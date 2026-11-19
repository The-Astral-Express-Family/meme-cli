"""归纳日预算（§7.5）：kv_meta 计数，超限触发候选排队等下一轮 surf。"""

from __future__ import annotations

import sqlite3
import time

from ..db import kv_get, kv_set


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def used_today(conn: sqlite3.Connection) -> tuple[int, int]:
    """(今日调用数, 今日 token 数)。跨天自动清零。"""
    day = _today()
    last_day = kv_get(conn, "budget_day")
    if last_day != day:
        kv_set(conn, "budget_day", day)
        kv_set(conn, "budget_calls", "0")
        kv_set(conn, "budget_tokens", "0")
        return 0, 0
    return int(kv_get(conn, "budget_calls", "0") or 0), int(kv_get(conn, "budget_tokens", "0") or 0)


def can_spend(conn: sqlite3.Connection, daily_calls: int) -> bool:
    calls, _ = used_today(conn)
    return calls < daily_calls


def spend(conn: sqlite3.Connection, tokens: int) -> None:
    calls, tok = used_today(conn)
    kv_set(conn, "budget_calls", str(calls + 1))
    kv_set(conn, "budget_tokens", str(tok + tokens))


def enqueue(conn: sqlite3.Connection, cid: str | None, ctx: str | None) -> int:
    """预算耗尽 → 排队（候选 id 或裸文本上下文）。返回当前排队数。"""
    import time as _t

    key = cid or f"text:{(ctx or '')[:40]}"
    conn.execute(
        "INSERT OR IGNORE INTO induction_queue(cid, ctx, queued_at) VALUES(?,?,?)",
        (key, ctx, _t.strftime("%Y-%m-%dT%H:%M:%S", _t.localtime())),
    )
    conn.commit()
    return conn.execute("SELECT COUNT(*) FROM induction_queue").fetchone()[0]


def dequeue_all(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    rows = conn.execute("SELECT * FROM induction_queue ORDER BY queued_at").fetchall()
    conn.execute("DELETE FROM induction_queue")
    conn.commit()
    return rows
