"""爆发检测 z-score 数学（O2 默认参数的行为验证）。"""

import sqlite3

from meme.detect.burst import z_score


def _seed(conn: sqlite3.Connection):
    days = [(f"2026-0{m}-{d:02d}", 1 if d <= 20 else 0) for m in (8,) for d in range(1, 31)]
    rows = [
        ("2026-09-" + f"{d:02d}", 0) for d in range(1, 26)
    ]
    for day, cnt in days + rows:
        conn.execute("INSERT OR REPLACE INTO phrase_daily VALUES(?,?,?,?)", ("某梗", day, cnt, 1))
    conn.commit()


def test_burst_rises_when_recent_explodes(conn):
    _seed(conn)
    # 近 7 天爆到 20/天，基线约 0.65/天 → 高 z
    import datetime

    today = datetime.date(2026, 10, 2)
    for d in range(1, 8):
        day = (today - datetime.timedelta(days=d)).isoformat()
        conn.execute("INSERT OR REPLACE INTO phrase_daily VALUES(?,?,?,?)",
                     ("某梗", day, 20, 3))
    conn.commit()
    z, baseline = z_score(conn, "phrase_daily", "phrase", "某梗", today=datetime.date(2026, 10, 2))
    assert baseline >= 14
    assert z is not None and z > 4


def test_steady_phrase_low_z(conn):
    _seed(conn)
    import datetime

    today = datetime.date(2026, 10, 2)
    for d in range(1, 8):
        day = (today - datetime.timedelta(days=d)).isoformat()
        conn.execute("INSERT OR REPLACE INTO phrase_daily VALUES(?,?,?,?)",
                     ("某梗", day, 1, 1))
    conn.commit()
    z, _ = z_score(conn, "phrase_daily", "phrase", "某梗", today=datetime.date(2026, 10, 2))
    assert z is not None and abs(z) < 2


def test_new_phrase_returns_none_z(conn):
    z, baseline = z_score(conn, "phrase_daily", "phrase", "全新短语")
    assert z is None and baseline == 0
