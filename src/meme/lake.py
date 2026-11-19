"""原始湖访问：内容寻址缓存的查询面（候选语料 + backtest 负例来源）。"""

from __future__ import annotations

import sqlite3
import time


def comments_for_round(conn: sqlite3.Connection, round_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM lake_comments WHERE round_id=? ORDER BY ctime", (round_id,)
    ).fetchall()


def up_mid_map(conn: sqlite3.Connection) -> dict[int, int]:
    """aid → up_mid（跨 up 新颖性计算）。"""
    return {r["aid"]: r["up_mid"] for r in conn.execute("SELECT aid, up_mid FROM lake_videos")}


def random_negative_comments(
    conn: sqlite3.Connection, n: int, exclude_like: list[str], seed: int | None = None
) -> list[str]:
    """随机采样不含目标词的评论作为 backtest 负例（§7.4）。"""
    import random as _random

    rnd = _random.Random(seed)
    total = conn.execute("SELECT COUNT(*) FROM lake_comments").fetchone()[0]
    if total == 0:
        return []
    msgs: list[str] = []
    tried = 0
    seen_rp: set[int] = set()
    while len(msgs) < n and tried < n * 10 + 200:
        tried += 1
        offset = rnd.randrange(total)
        row = conn.execute(
            "SELECT rpid, message FROM lake_comments LIMIT 1 OFFSET ?", (offset,)
        ).fetchone()
        if row is None or row["rpid"] in seen_rp:
            continue
        seen_rp.add(row["rpid"])
        m = row["message"]
        if not any(term in m for term in exclude_like if term):
            msgs.append(m)
    return msgs


def comment_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM lake_comments").fetchone()[0]


def recent_comments_since(conn: sqlite3.Connection, days: int) -> list[sqlite3.Row]:
    cutoff = time.time() - days * 86400
    return conn.execute(
        "SELECT * FROM lake_comments WHERE ctime >= ? ORDER BY ctime", (cutoff,)
    ).fetchall()
