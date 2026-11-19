"""生命周期：候选与词条双状态机（§4.5）。一切转移发生在被调用时（D1）。

遗忘 = 降级 + 压缩，不是删除（D7）；ID 永不回收。
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from . import audit, entries
from .models import Meme, now_iso


# ---------- 候选状态机 ----------

def candidate_should_trigger(cand, cfg, feats=None) -> bool:
    """触发归纳：跨轮次 + 跨视频 + 跨 up + **梗性证据**（v2 重校准）。

    实战教训（6 轮 720 候选触发 0）：旧条件 z≥4 或 dv≥15 在冷启动期
    （z 恒 None、每轮仅 ~20 视频）永不可达；泛用词 dv=14 与真梗 dv=6 无法
    用计数区分。v2 改为：
    - 计数门（必要）：surfs_seen≥2 && dv≥4 && du≥3；
    - 梗性门（必要）：meme_score ≥ trigger_meme_score（复读/模板坍缩/独立成评
      的统计证据——泛用词句句不同，永远不过此门，不再依赖操作员手动 reject）；
    - 强度门（其一）：z≥4（爆发）｜dv≥8（广泛）｜新物跨 ≥5 视频（fresh 传播）。
    """
    if cand.state != "pending":
        return False
    if cand.surfs_seen < cfg.trigger_rounds:
        return False
    if cand.distinct_videos < cfg.trigger_videos:
        return False
    if cand.distinct_ups < 3:
        return False
    if feats is None:
        from .detect.evidence import meme_features

        feats = meme_features(cand.evidence_usages, cand.head)
    if feats.meme_score < cfg.trigger_meme_score:
        return False
    z_ok = cand.z_score is not None and cand.z_score >= cfg.trigger_z
    wide_ok = cand.distinct_videos >= cfg.trigger_videos_alt
    fresh_ok = cand.z_score is None and cand.distinct_videos >= cfg.trigger_fresh_videos
    return z_ok or wide_ok or fresh_ok


def transition_candidates(conn: sqlite3.Connection, cfg, current_round: int) -> dict:
    """pending → triggered（达标） / → rejected（过期，O4）。返回变化摘要。"""
    from . import candidates as cands

    summary = {"triggered": [], "expired": []}
    for cand in cands.all_active(conn):
        if candidate_should_trigger(cand, cfg):
            cand.state = "triggered"
            cand.updated_at = now_iso()
            cands.save(conn, cand)
            summary["triggered"].append(cand.cid)
        elif (
            current_round - cand.last_round >= cfg.candidate_expire_rounds
            and cand.last_round > 0
        ):
            # 长期无新证据且未达阈值 → 过期（O4）。
            # 单轮候选（surfs_seen=1）同样过期：原先豁免它们导致 pending 队列只进不出。
            conn.execute(
                "UPDATE candidates SET state='rejected', rejected_at=?, reject_reason='expired' WHERE cid=?",
                (now_iso(), cand.cid),
            )
            conn.commit()
            summary["expired"].append(cand.cid)
    return summary


# ---------- 词条状态机 ----------

def _consecutive_tail(rounds: list[int], n: int, current: int) -> bool:
    """wild_rounds 尾部是否为以 current 结尾的 n 个连续轮次。"""
    if len(rounds) < n:
        return False
    tail = rounds[-n:]
    return tail == list(range(current - n + 1, current + 1))


def note_wild_match(
    conn: sqlite3.Connection, meme: Meme, round_id: int, day: str, hits: int,
    promote_rounds: int = 2,
) -> Meme:
    """记录一轮野外命中；observing→active 存活门在此判定（§4.5）。"""
    entries.record_wild_hit(conn, meme.id, day, hits)
    if not meme.wild_rounds or meme.wild_rounds[-1] != round_id:
        meme.wild_rounds = (meme.wild_rounds + [round_id])[-12:]
    meme.stats.last_seen = now_iso()
    meme.stats.last_matched_round = round_id
    old_state = meme.state
    if meme.state == "observing":
        if _consecutive_tail(meme.wild_rounds, promote_rounds, round_id):
            meme.state = "active"
            audit.record(conn, meme.id, "state_change", "system",
                         {"from": "observing", "to": "active", "round": round_id,
                          "reason": "连续野外存活"})
    elif meme.state in ("fading", "tombstone"):
        # 野外重现：先回移 + 最小卡（"记得但记不全"），确认后恢复
        meme.state = "active"
        meme.revived_pending = 1
        audit.record(conn, meme.id, "state_change", "system",
                     {"from": old_state, "to": "active", "round": round_id,
                      "reason": "野外重现复活（最小卡待确认）"})
    entries.save(conn, meme)
    return meme


def _daily_series(conn: sqlite3.Connection, meme_id: str, days: int) -> list[int]:
    cutoff = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = {
        r["day"]: int(r["cnt"])
        for r in conn.execute(
            "SELECT day, cnt FROM meme_hit_daily WHERE meme_id=? AND day>=?", (meme_id, cutoff)
        )
    }
    out = []
    d = date.today() - timedelta(days=days - 1)
    while d <= date.today():
        out.append(rows.get(d.isoformat(), 0))
        d += timedelta(days=1)
    return out


def check_fade(conn: sqlite3.Connection, cfg) -> list[dict]:
    """surf 顺手执行的衰减复查：active→fading→tombstone（§9.2）。返回变化列表。"""
    changes: list[dict] = []
    for meme in entries.all_memes(conn, states=["active", "fading"]):
        series = _daily_series(conn, meme.id, cfg.fade_window_days)
        if not any(series):
            continue
        # 峰值 = 任意 7 天滑窗均值最大值；当前 = 近 14 天均值
        peak = max(
            sum(series[i : i + 7]) / 7 for i in range(0, max(len(series) - 6, 1))
        )
        cur = sum(series[-14:]) / 14
        meme.stats.peak_freq = max(meme.stats.peak_freq, peak)
        meme.stats.wild_freq_30d = sum(series[-30:]) / 30
        if meme.state == "active" and peak > 0 and cur < peak * (1 - cfg.fade_drop):
            meme.state = "fading"
            audit.record(conn, meme.id, "state_change", "system",
                         {"from": "active", "to": "fading", "peak": round(peak, 2),
                          "current": round(cur, 2), "reason": f"{cfg.fade_window_days}天窗口频率下降超阈值"})
            changes.append({"id": meme.id, "name": meme.name, "from": "active", "to": "fading"})
        elif meme.state == "fading" and peak > 0 and cur < peak * cfg.tombstone_ratio:
            meme.state = "tombstone"
            audit.record(conn, meme.id, "state_change", "system",
                         {"from": "fading", "to": "tombstone", "peak": round(peak, 2),
                          "current": round(cur, 2), "reason": "持续衰减至近零"})
            changes.append({"id": meme.id, "name": meme.name, "from": "fading", "to": "tombstone"})
        entries.save(conn, meme)
    return changes


def promote(conn: sqlite3.Connection, meme: Meme, source: str, reason: str = "") -> Meme:
    if meme.state != "observing":
        raise ValueError(f"{meme.id} 状态为 {meme.state}，不可升格")
    meme.state = "active"
    audit.record(conn, meme.id, "state_change", source,
                 {"from": "observing", "to": "active", "reason": reason or "人工升格"})
    entries.save(conn, meme)
    return meme


def kill(conn: sqlite3.Connection, meme: Meme, source: str, reason: str = "") -> Meme:
    """判死：加速降级——LLM 主观通道，独立于统计衰减。"""
    old = meme.state
    if meme.state == "active":
        meme.state = "fading"
    audit.record(conn, meme.id, "state_change", source,
                 {"from": old, "to": meme.state, "reason": reason or "主观判死"})
    entries.save(conn, meme)
    return meme


def revive(conn: sqlite3.Connection, meme: Meme, source: str, reason: str = "") -> Meme:
    """复活：fading/tombstone → active，先给最小卡待确认。"""
    if meme.state not in ("fading", "tombstone"):
        raise ValueError(f"{meme.id} 状态为 {meme.state}，无需复活")
    old = meme.state
    meme.state = "active"
    meme.revived_pending = 1
    audit.record(conn, meme.id, "state_change", source,
                 {"from": old, "to": "active", "reason": reason or "复活（最小卡待确认）"})
    entries.save(conn, meme)
    return meme
