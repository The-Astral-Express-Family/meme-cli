"""候选队列：跨 surf 轮次持续累积证据（D3）。"""

from __future__ import annotations

import sqlite3
from datetime import date

from .ids import next_id
from .models import Candidate, UsageSample, now_iso


def upsert_from_signal(
    conn: sqlite3.Connection,
    *,
    head: str,
    channel: str,
    kind_guess: str,
    usages: list[UsageSample],
    video_pairs: list[tuple[int, int]],  # (aid, up_mid)
    day: str | None = None,
    round_id: int = 0,
) -> Candidate | None:
    """信号通道写入：不存在则建候选，存在则合流证据。返回最新候选。"""
    day = day or date.today().isoformat()
    row = conn.execute("SELECT * FROM candidates WHERE head=? AND channel=?", (head, channel)).fetchone()
    ts = now_iso()
    if row is None:
        cid = next_id(conn, "c")
        conn.execute(
            "INSERT INTO candidates(cid,head,kind_guess,channel,state,first_seen,last_seen,"
            "evidence_usages,related,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (cid, head, kind_guess, channel, "pending", ts, ts, "[]", "[]", ts, ts),
        )
        row = conn.execute("SELECT * FROM candidates WHERE cid=?", (cid,)).fetchone()
    elif row["state"] == "rejected":
        # 拒绝不是永刑：新浪再来 = 新证据，重开候选（显式跳过只代表当时的判断）
        conn.execute(
            "UPDATE candidates SET state='pending', rejected_at=NULL, reject_reason=NULL WHERE cid=?",
            (row["cid"],),
        )
        row = conn.execute("SELECT * FROM candidates WHERE cid=?", (row["cid"],)).fetchone()
    cand = _from_row(row)
    # kind 只升不降：回复复读（interaction 证据）可以升级 word 预判，
    # 反之不降级——phrase 通道先建的 word 户不该抹掉 copy 通道的 interaction 判断
    if cand.kind_guess == "word" and kind_guess == "interaction":
        cand.kind_guess = "interaction"
    # 证据合流：用例样本封顶 40 条，保留跨视频多样性（简单轮换）
    merged = cand.evidence_usages + usages
    uniq: dict[tuple[str, int], UsageSample] = {}
    for u in merged:
        uniq.setdefault((u.text, u.rpid), u)
    cand.evidence_usages = list(uniq.values())[-40:]
    # 跨视频/up 计数走 cand_video 链接表（每候选封顶 500 行 FIFO）
    for aid, up_mid in video_pairs:
        conn.execute(
            "INSERT OR IGNORE INTO cand_video(cid,aid,up_mid,ts) VALUES(?,?,?,?)",
            (cand.cid, aid, up_mid, ts),
        )
    cnt = conn.execute("SELECT COUNT(*) FROM cand_video WHERE cid=?", (cand.cid,)).fetchone()[0]
    if cnt > 500:
        conn.execute(
            "DELETE FROM cand_video WHERE cid=? AND aid NOT IN "
            "(SELECT aid FROM cand_video WHERE cid=? ORDER BY ts DESC LIMIT 500)",
            (cand.cid, cand.cid),
        )
    stats = conn.execute(
        "SELECT COUNT(DISTINCT aid) AS v, COUNT(DISTINCT up_mid) AS u FROM cand_video WHERE cid=?",
        (cand.cid,),
    ).fetchone()
    cand.distinct_videos, cand.distinct_ups = int(stats["v"]), int(stats["u"])
    cand.last_seen = ts
    cand.surfs_seen += 1
    if round_id:
        cand.last_round = round_id
    _save(conn, cand)
    return cand


def _from_row(row: sqlite3.Row) -> Candidate:
    import json

    return Candidate(
        cid=row["cid"],
        head=row["head"],
        kind_guess=row["kind_guess"],
        channel=row["channel"],
        state=row["state"],
        z_score=row["z_score"],
        distinct_videos=row["distinct_videos"],
        distinct_ups=row["distinct_ups"],
        first_seen=row["first_seen"],
        last_seen=row["last_seen"],
        surfs_seen=row["surfs_seen"],
        last_round=row["last_round"],
        evidence_usages=[UsageSample(**u) for u in json.loads(row["evidence_usages"])],
        related=[dict(r) for r in json.loads(row["related"])],
        provenance=row["provenance"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _save(conn: sqlite3.Connection, cand: Candidate) -> None:
    from .models import j

    conn.execute(
        "UPDATE candidates SET kind_guess=?, state=?, z_score=?, distinct_videos=?, distinct_ups=?,"
        "first_seen=?, last_seen=?, surfs_seen=?, last_round=?, evidence_usages=?, related=?, updated_at=? WHERE cid=?",
        (cand.kind_guess, cand.state, cand.z_score, cand.distinct_videos, cand.distinct_ups,
         cand.first_seen, cand.last_seen, cand.surfs_seen, cand.last_round, j(cand.evidence_usages),
         j(cand.related), cand.updated_at, cand.cid),
    )
    conn.commit()


def save(conn: sqlite3.Connection, cand: Candidate) -> None:
    _save(conn, cand)


def get(conn: sqlite3.Connection, cid: str) -> Candidate | None:
    row = conn.execute("SELECT * FROM candidates WHERE cid=?", (cid,)).fetchone()
    return _from_row(row) if row else None


def by_head(conn: sqlite3.Connection, head: str) -> Candidate | None:
    row = conn.execute(
        "SELECT * FROM candidates WHERE head=? AND state IN ('pending','triggered') "
        "ORDER BY updated_at DESC LIMIT 1",
        (head,),
    ).fetchone()
    return _from_row(row) if row else None


def all_active(conn: sqlite3.Connection) -> list[Candidate]:
    rows = conn.execute(
        "SELECT * FROM candidates WHERE state IN ('pending','triggered') ORDER BY cid"
    )
    return [_from_row(r) for r in rows]


def reject(conn: sqlite3.Connection, cid: str, reason: str = "operator") -> bool:
    """LLM 显式跳过（§4.5）：pending/triggered → rejected。

    返回 None 语义区分（批量 reject 幂等性，subagent 实战反馈）：
    - True  ：本次生效
    - False ：已出队（rejected/inducted）——幂等成功，不报错
    - raise：cid 不存在——多半是手抄错，报错引导
    """
    cur = conn.execute(
        "UPDATE candidates SET state='rejected', rejected_at=?, reject_reason=? "
        "WHERE cid=? AND state IN ('pending','triggered')",
        (now_iso(), reason, cid),
    )
    conn.commit()
    if cur.rowcount > 0:
        return True
    if conn.execute("SELECT 1 FROM candidates WHERE cid=?", (cid,)).fetchone():
        return False  # 已出队：幂等
    raise KeyError(cid)
