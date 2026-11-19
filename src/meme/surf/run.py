"""surf 轮次编排（§6.1）：获取（增量）→ 证据更新（零 LLM）→ 关联预计算 → 四区呈现。

一切发生在被调用时——不存在独立于调用的整理任务（D1）。
获取失败 → 降级模式，靠原始湖存量继续运转（§6.6）。
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from .. import candidates, entries, lifecycle, notes
from ..config import Config
from ..db import kv_get, kv_set
from ..detect.signals import update_signals
from ..errors import candidate_not_found
from ..fetch.sampler import run_fetch
from ..induct import budget as budget_mod
from ..induct.inductor import run_add
from ..match.pipeline import load_matchers, scan_texts
from ..models import now_iso
from . import present


def handle_allow(conn: sqlite3.Connection, words: list[str]) -> list[str]:
    """--allow：豁免词写入 kv generic_allow（黑名单误杀的可逆逃生口）。"""
    import json as _json

    from ..db import kv_get, kv_set

    cur = _json.loads(kv_get(conn, "generic_allow", "[]") or "[]")
    cur += [w for w in words if w not in cur]
    kv_set(conn, "generic_allow", _json.dumps(cur, ensure_ascii=False))
    return words


def handle_reject(conn: sqlite3.Connection, cids: list[str], ban: bool) -> tuple[list[str], list[str]]:
    """--reject [--ban]：批量跳过候选；ban 时把词头沉淀为持久停用词。

    不存在的 cid 抛 KeyError(cid)——由 CLI 层转稳定错误码。
    """
    import json as _json

    from .. import candidates as cands
    from ..db import kv_get, kv_set

    done: list[str] = []
    banned: list[str] = []
    for cid in cids:
        if not cands.reject(conn, cid, reason="operator"):
            continue  # 已出队：幂等跳过（批量操作不该被单条状态卡死）
        done.append(cid)
        if ban:
            cand = cands.get(conn, cid)
            if cand is not None and cand.head:
                banned.append(cand.head)
                words = _json.loads(kv_get(conn, "generic_auto", "[]") or "[]")
                if cand.head not in words:
                    words.append(cand.head)
                    kv_set(conn, "generic_auto", _json.dumps(words, ensure_ascii=False))
    return done, banned


def _process_queue(conn: sqlite3.Connection, cfg: Config) -> list[dict]:
    """处理上一轮预算耗尽排队的归纳（§7.5）。预算耗尽时剩余行必须全部重新排队——
    曾经的实现 break 后丢弃未处理行，排队悄无声息地缩水。"""
    import sys as _sys

    done = []
    rows = budget_mod.dequeue_all(conn)
    for i, row in enumerate(rows):
        if not budget_mod.can_spend(conn, cfg.induction.daily_call_budget):
            for rest in rows[i:]:  # 预算耗尽：本行起全部重新排队，不丢行
                budget_mod.enqueue(conn, rest["cid"], rest["ctx"])
            break
        try:
            cid = row["cid"] if row["cid"].startswith("c_") else None
            text = None if cid else (row["ctx"] or row["cid"].removeprefix("text:"))
            res = run_add(conn, cfg, cid=cid, text=text, ctx=row["ctx"])
            done.append(res.to_dict())
        except Exception as e:  # noqa: BLE001 - 单条失败不阻塞 surf，但不得丢行：
            # errors.py 向操作员承诺"证据已保留在队列中"——裸文本行的唯一载体就是这行
            print(f"meme: surf: 排队归纳 {row['cid']} 失败（{e}），重新排队", file=_sys.stderr)
            budget_mod.enqueue(conn, row["cid"], row["ctx"])
            continue
    return done


def _wild_recheck(conn: sqlite3.Connection, cfg: Config, round_id: int) -> tuple[list[dict], list[dict]]:
    """已有词条野外频率复查：命中计数、变体提示、爆发上升、存活/复活转移。"""
    day = date.today().isoformat()
    matchers = load_matchers(conn)
    rows = conn.execute(
        "SELECT rpid, message, parent FROM lake_comments WHERE round_id=?", (round_id,)
    ).fetchall()
    dynamics: list[dict] = []
    if not rows or not matchers:
        return dynamics, []
    # 楼中楼父子文本 → 交互梗（tier 3）的会话上下文；无父评论的行 ctx 为 None
    msg_by_rpid = {r["rpid"]: r["message"] for r in rows}
    items = []
    for r in rows:
        ctx = None
        if r["parent"]:
            p = msg_by_rpid.get(r["parent"])
            if p:
                ctx = [p, r["message"]]
        items.append((r["message"], ctx))
    counts, excerpts = scan_texts(matchers, items)
    for mid, hits in counts.items():
        m = entries.get(conn, mid)
        if m is None:
            continue
        old_state = m.state
        m = lifecycle.note_wild_match(conn, m, round_id, day, hits, cfg.lifecycle.promote_rounds)
        # 变体提示：命中摘录不在已知词表内 → 骨架漂移信号
        known = m.terms
        for ex in list(excerpts.get(mid, []))[:3]:
            if len(ex) >= 2 and not any(k in ex or ex in k for k in known if k):
                dynamics.append({
                    "id": mid, "name": m.name,
                    "change": f"新形态\"{ex[:16]}\"出现（{hits} 次命中）",
                    "action": "可 edit --variant 收编",
                })
                break
        # 爆发上升：本轮命中 ≥ 2× 前 14 天日均
        prev = conn.execute(
            "SELECT COALESCE(SUM(cnt),0) FROM meme_hit_daily WHERE meme_id=? AND day<? AND day>=?",
            (mid, day, (date.today() - timedelta(days=14)).isoformat()),
        ).fetchone()[0]
        base = prev / 14
        if hits >= 5 and base > 0 and hits >= 2 * base:
            dynamics.append({
                "id": mid, "name": m.name,
                "change": f"爆发上升 {base:.1f}/日→本轮 {hits}",
                "action": "可 edit --promote 升格" if old_state == "observing" else "持续观察",
            })
        if old_state == "observing" and m.state == "active":
            dynamics.append({"id": mid, "name": m.name,
                             "change": "连续野外存活，自动升格 active", "action": ""})
        if old_state in ("fading", "tombstone") and m.state == "active":
            dynamics.append({"id": mid, "name": m.name,
                             "change": "野外重现复活（最小卡待确认）", "action": "show 确认"})
    return dynamics, []


def _fading_zone(conn: sqlite3.Connection, cfg: Config, changes: list[dict]) -> list[str]:
    lines = []
    for ch in changes:
        lines.append(f"{ch['id']} {ch['name']}   {ch['from']} → {ch['to']}")
    for m in entries.all_memes(conn, states=["fading"]):
        series = lifecycle._daily_series(conn, m.id, cfg.lifecycle.fade_window_days)
        if not any(series):
            continue
        peak = max(sum(series[i : i + 7]) / 7 for i in range(0, max(len(series) - 6, 1)))
        cur = sum(series[-14:]) / 14
        if peak > 0:
            drop = max(0.0, 1 - cur / peak)
            lines.append(f"{m.id} {m.name}   野外频率 {cfg.lifecycle.fade_window_days}天 -{drop * 100:.0f}%")
    return lines[:10]


def run_surf(
    conn: sqlite3.Connection,
    cfg: Config,
    *,
    more: bool = False,
    focus: str | None = None,
    round_size: int | None = None,
    no_fetch: bool = False,
    probe_extra: list[str] | None = None,
    full: bool = False,
    _fetch=run_fetch,
) -> dict:
    round_size = round_size or cfg.retrieval.round_size

    # --focus：深入单个候选（不获取、不更新证据）
    if focus:
        cand = candidates.get(conn, focus)
        if cand is None:
            raise candidate_not_found(focus)
        vids = conn.execute(
            "SELECT v.aid, v.title, v.up_name FROM cand_video cv JOIN lake_videos v ON v.aid=cv.aid "
            "WHERE cv.cid=? ORDER BY cv.ts DESC LIMIT 5",
            (cand.cid,),
        ).fetchall()
        related = []
        for r in cand.related:
            rid, rtype, rscore = (r["id"], r["type"], r["score"]) if isinstance(r, dict) \
                else (r.id, r.type, r.score)
            m = entries.get(conn, rid)
            related.append({"id": rid, "type": rtype, "score": rscore,
                            "name": m.name if m else "?"})
        human = present.render_focus(cand, [dict(v) for v in vids], related)
        return {
            "payload": {"round": int(kv_get(conn, "surf_round", "0") or 0),
                        "candidate": present.cand_dict(cand),
                        "videos": [dict(v) for v in vids], "related": related},
            "human": human,
        }

    if more:
        round_id = int(kv_get(conn, "surf_round", "0") or 0)
        page = int(kv_get(conn, "surf_page", "0") or 0) + 1
        kv_set(conn, "surf_page", str(page))
        zones = _build_zones(conn, cfg, page, round_size)
        return {"payload": zones, "human": present.render_zones(zones, present.page_footer(
            page, zones["has_more"], round_size))}

    # ---- 新一轮 ----
    queued_done = _process_queue(conn, cfg)
    cur = conn.execute(
        "INSERT INTO surf_runs(started_at, fetched) VALUES(?, 0)", (now_iso(),)
    )
    conn.commit()
    round_id = int(cur.lastrowid)

    fetch_note = None
    fres = None
    if no_fetch:
        fetch_note = "本轮 --no-fetch（存量模式）"
    else:
        fres = _fetch(conn, cfg.fetch, round_id, probe_extra or [])
        conn.execute(
            "UPDATE surf_runs SET fetched=1, new_videos=?, new_comments=?, degraded=?, note=? WHERE round_id=?",
            (fres.new_videos, fres.new_comments, int(fres.degraded), fres.reason, round_id),
        )
        conn.commit()
        if fres.degraded:
            fetch_note = fres.reason

    sig = update_signals(conn, cfg, round_id)
    dynamics, _ = _wild_recheck(conn, cfg, round_id)
    fade_changes = lifecycle.check_fade(conn, cfg.lifecycle)
    trans = lifecycle.transition_candidates(conn, cfg.lifecycle, round_id)
    notes.dedupe(conn)

    kv_set(conn, "surf_round", str(round_id))
    kv_set(conn, "surf_page", "0")
    import json as _json

    kv_set(conn, "surf_hotwords", _json.dumps(fres.hot_keywords if fres else [], ensure_ascii=False))

    zones = _build_zones(conn, cfg, 0, round_size, full=full)
    zones["round"] = round_id
    zones["fetch"] = {
        "new_videos": 0 if fres is None else fres.new_videos,
        "new_comments": 0 if fres is None else fres.new_comments,
        "degraded": bool(fetch_note),
        "note": fetch_note,
        "probed": [] if fres is None else fres.probed,
    }
    zones["degraded"] = fetch_note
    zones["signals"] = sig.to_dict()
    zones["candidate_transitions"] = trans
    zones["queued_inductions_done"] = queued_done
    zones["dynamics_raw"] = dynamics
    zones["dynamics"] = [
        f"{d['id']} {d['name']}  {d['change']}" + (f"   → {d['action']}" if d["action"] else "")
        for d in dynamics
    ][:10]
    zones["fading"] = _fading_zone(conn, cfg, fade_changes)
    zones["counts"]["fading"] = len(zones["fading"])
    return {"payload": zones, "human": present.render_zones(
        zones, present.page_footer(0, zones["has_more"], round_size))}


FULL_DUMP_CAP = 1000  # --json 全量输出保险丝：候选队列治理靠过期+操作员，不该有兆级转储


def _build_zones(conn: sqlite3.Connection, cfg: Config, page: int, round_size: int,
                 full: bool = False) -> dict:
    import json as _json

    from .. import entries as _e
    from ..db import kv_get

    related_names = {m.id: m.name for m in _e.all_memes(conn)}
    try:
        hot = _json.loads(kv_get(conn, "surf_hotwords", "[]") or "[]")
    except _json.JSONDecodeError:
        hot = []
    cands = sorted(
        [c for c in candidates.all_active(conn) if c.state in ("pending", "triggered")],
        key=present.order_key,
    )
    if full:
        # 机器输出不分页（agent 工效）：一次给全量候选，人类渲染才需要翻页
        page_items = cands[:FULL_DUMP_CAP]
        start, has_more = 0, False
    else:
        start = page * round_size
        page_items = cands[start : start + round_size]
        has_more = start + round_size < len(cands)
    triggered = [c for c in cands if c.state == "triggered"]
    pending = [c for c in cands if c.state == "pending"]
    queued = conn.execute("SELECT COUNT(*) FROM induction_queue").fetchone()[0]
    backlog_n = len(triggered) + queued
    backlog_line = (
        f"积压候选 {backlog_n} 条未处理（triggered {len(triggered)}、排队 {queued}、"
        f"pending {len(pending)}）"
        if backlog_n >= cfg.lifecycle.backlog_alert
        else f"待处理：triggered {len(triggered)}｜排队 {queued}｜pending {len(pending)}"
    )
    return {
        "counts": {
            "new": len(cands),
            "dynamics": 0,
            "fading": 0,
            "backlog": backlog_n,
        },
        "hot_keywords": hot,
        "new_candidates": [present.cand_line(c, related_names) for c in page_items],
        "new_candidates_raw": [present.cand_dict(c) for c in page_items],
        "dynamics": [],
        "fading": [],
        "backlog_line": backlog_line,
        "backlog": {"triggered": len(triggered), "pending": len(pending), "queued": queued,
                    "alert": backlog_n >= cfg.lifecycle.backlog_alert},
        "page": page,
        "has_more": has_more,
    }
