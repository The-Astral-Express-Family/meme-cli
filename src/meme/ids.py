"""ID 分配：c_NNNN / m_NNNN 单调递增，一经分配永不回收、永不复用（§4.6）。"""

from __future__ import annotations

import sqlite3

from .db import kv_get, kv_set


def next_id(conn: sqlite3.Connection, kind: str) -> str:
    """kind: 'c'（候选）或 'm'（词条）。"""
    key = f"seq_{kind}"
    cur = int(kv_get(conn, key, "0") or "0") + 1
    kv_set(conn, key, str(cur))
    return f"{kind}_{cur:04d}"
