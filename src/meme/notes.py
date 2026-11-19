"""笔记：LLM 操作员的低信任私有附着物（§4.4）。永不进入 matcher 与 card。"""

from __future__ import annotations

import sqlite3

from .models import now_iso


def add(conn: sqlite3.Connection, content: str, meme_id: str | None = None, head: str | None = None) -> int:
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO notes(meme_id,head,content,created_at,updated_at) VALUES(?,?,?,?,?)",
        (meme_id, head, content, ts, ts),
    )
    conn.commit()
    return int(cur.lastrowid)


def update(conn: sqlite3.Connection, note_id: int, content: str) -> bool:
    cur = conn.execute(
        "UPDATE notes SET content=?, updated_at=? WHERE id=?",
        (content, now_iso(), note_id),
    )
    conn.commit()
    return cur.rowcount > 0


def delete(conn: sqlite3.Connection, note_id: int) -> bool:
    cur = conn.execute("DELETE FROM notes WHERE id=?", (note_id,))
    conn.commit()
    return cur.rowcount > 0


def get(conn: sqlite3.Connection, note_id: int) -> dict | None:
    r = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
    return dict(r) if r else None


def list_notes(conn: sqlite3.Connection, meme_id: str | None = None) -> list[dict]:
    if meme_id:
        rows = conn.execute("SELECT * FROM notes WHERE meme_id=? ORDER BY id", (meme_id,))
    else:
        rows = conn.execute("SELECT * FROM notes ORDER BY id")
    return [dict(r) for r in rows]


def dedupe(conn: sqlite3.Connection) -> int:
    """库卫生：删除完全重复的笔记（surf 顺手执行，§6.1）。

    去重键含 head——不同词头、相同内容的两条悬挂笔记不是重复。
    """
    rows = conn.execute(
        "SELECT id, COALESCE(meme_id,'') || '|' || COALESCE(head,'') || '|' || content AS k "
        "FROM notes ORDER BY id"
    ).fetchall()
    seen: set[str] = set()
    removed = 0
    for r in rows:
        if r["k"] in seen:
            conn.execute("DELETE FROM notes WHERE id=?", (r["id"],))
            removed += 1
        else:
            seen.add(r["k"])
    if removed:
        conn.commit()
    return removed
