"""审计日志：归纳与一切 edit 强制记录（§7.5、§9.1），错误词条可回溯、可撤销。"""

from __future__ import annotations

import sqlite3

from .models import now_iso


def record(conn: sqlite3.Connection, meme_id: str, action: str, source: str, payload: dict) -> None:
    import json

    conn.execute(
        "INSERT INTO audit_log(meme_id, action, source, payload, ts) VALUES(?,?,?,?,?)",
        (meme_id, action, source, json.dumps(payload, ensure_ascii=False), now_iso()),
    )
    conn.commit()


def for_meme(conn: sqlite3.Connection, meme_id: str) -> list[dict]:
    import json

    return [
        {
            "seq": r["seq"],
            "action": r["action"],
            "source": r["source"],
            "payload": json.loads(r["payload"]),
            "ts": r["ts"],
        }
        for r in conn.execute(
            "SELECT * FROM audit_log WHERE meme_id=? ORDER BY seq", (meme_id,)
        )
    ]
