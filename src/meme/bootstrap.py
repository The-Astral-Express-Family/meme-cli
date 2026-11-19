"""进程引导：Windows 控制台 UTF-8、jieba 静音。"""

from __future__ import annotations

import sys


def setup() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    try:
        import jieba

        jieba.setLogLevel(60)
    except Exception:  # noqa: BLE001
        pass
