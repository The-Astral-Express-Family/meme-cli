"""爆发检测：近期窗口日均频次 vs 基线窗口的 z-score（O2 待实测校准）。"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta


def z_score(
    conn: sqlite3.Connection,
    table: str,  # phrase_daily | skel_daily
    key_col: str,  # phrase | skel
    key: str,
    today: date | None = None,
    recent_days: int = 7,
    baseline_days: int = 90,
) -> tuple[float | None, int]:
    """返回 (z, 有效基线天数)。

    冷启动修复（实战教训：库龄 <14 天时旧实现恒返回 None，6 轮 surf 触发 0 候选）：
    - 基线 ≥14 天：完整 z-score；
    - 基线 1-13 天：用现有历史天数做短基线 z（近期 vs 短基线均值）；
    - 基线 0 天（首轮新物）：z=None，由触发层的"新物跨视频"信号兜底。
    """
    today = today or date.today()
    recent_start = (today - timedelta(days=recent_days - 1)).isoformat()
    base_end = (today - timedelta(days=recent_days)).isoformat()
    base_start = (today - timedelta(days=recent_days + baseline_days)).isoformat()

    row = conn.execute(
        f"SELECT COALESCE(SUM(cnt),0), COUNT(DISTINCT day) FROM {table} "
        f"WHERE {key_col}=? AND day>=? AND day<=?",
        (key, recent_start, today.isoformat()),
    ).fetchone()
    recent_sum, recent_active = int(row[0]), int(row[1])
    row = conn.execute(
        f"SELECT COALESCE(SUM(cnt),0), COUNT(DISTINCT day) FROM {table} "
        f"WHERE {key_col}=? AND day>=? AND day<=?",
        (key, base_start, base_end),
    ).fetchone()
    base_sum, base_active = int(row[0]), int(row[1])
    if base_active == 0:
        return None, 0
    # 基线日频方差（按日计数重取；天数不足时窗口收窄到实际天数）
    rows = conn.execute(
        f"SELECT day, cnt FROM {table} WHERE {key_col}=? AND day>=? AND day<=? ORDER BY day",
        (key, base_start, base_end),
    ).fetchall()
    by_day = {r["day"]: int(r["cnt"]) for r in rows}
    filled = []
    d = date.fromisoformat(base_start)
    while d <= date.fromisoformat(base_end):
        filled.append(by_day.get(d.isoformat(), 0))
        d += timedelta(days=1)
    if not filled:
        return None, 0
    # 按实际活跃天数（而非日历天数）做均值——surf 非每日进行，日历均值会把
    # 基线稀释成接近 0，z 虚高。std 加 1 平滑：短基线的方差噪音不放大成信号。
    mean = sum(filled) / len(filled)
    var = sum((c - mean) ** 2 for c in filled) / max(len(filled) - 1, 1)
    std = var**0.5
    recent_rate = recent_sum / max(recent_active, 1)
    z = (recent_rate - mean) / (std + 1.0)
    return z, base_active
