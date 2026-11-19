"""获取器游标翻页回归：reply/main 的 next 是从 0 起的游标（真网踩坑）。"""

import sqlite3

from meme.fetch import sampler


class FakeSession:
    """按游标出三页，验证 sampler 跟随 cursor 而非自增页号。"""

    def __init__(self, pages: dict[int, list[dict]]):
        self.pages = pages
        self.calls: list[int] = []

    def get_json(self, url, params=None):
        assert "/x/v2/reply/main" in url
        nxt = (params or {}).get("next", 0)
        self.calls.append(nxt)
        cursor_next = nxt + 10  # 游标跳跃前进（非 +1）
        is_end = nxt not in self.pages or nxt == max(self.pages)
        # 契约：get_json 返回已解包的 data 载荷（与 BiliSession 一致）
        return {
            "replies": self.pages.get(nxt, []),
            "cursor": {"is_end": is_end, "next": cursor_next, "all_count": 99},
        }


def _cfg():
    from meme.config import FetchConfig

    return FetchConfig(reply_pages_per_video=3, comments_per_video=200,
                       subreply_pages_per_root=0, delay_min=0, delay_max=0)


def _reply(rpid):
    return {"rpid": rpid, "content": {"message": f"评论{rpid}"}, "ctime": 1, "like": 1,
            "rcount": 0, "replies": []}


def test_cursor_followed_not_incremented(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "t.db"))
    conn.row_factory = sqlite3.Row
    conn.executescript(
        "CREATE TABLE lake_comments(rpid INTEGER PRIMARY KEY, oid INTEGER, root INTEGER DEFAULT 0,"
        "parent INTEGER DEFAULT 0, mid INTEGER DEFAULT 0, message TEXT, ctime INTEGER,"
        "likes INTEGER DEFAULT 0, fetched_at TEXT, round_id INTEGER DEFAULT 0);"
        "CREATE TABLE lake_videos(aid INTEGER PRIMARY KEY);"
    )
    conn.execute("INSERT INTO lake_videos VALUES(999)")
    conn.commit()
    pages = {0: [_reply(1), _reply(2)], 10: [_reply(3)], 20: [_reply(4)]}
    s = FakeSession(pages)
    added, skipped, _imgs = sampler._fetch_video_comments(conn, s, 999, _cfg(), 1, is_new_video=True)
    assert added == 4 and skipped == 0
    assert s.calls == [0, 10, 20]  # 游标被跟随：0 → 10 → 20，而非 0 → 1 → 2
    conn.close()


def test_comment_age_gate(tmp_path):
    """近期性闸门：ctime 早于 min_ctime 的远古评论不入湖。"""
    import time as _t

    conn = sqlite3.connect(str(tmp_path / "t2.db"))
    conn.row_factory = sqlite3.Row
    conn.executescript(
        "CREATE TABLE lake_comments(rpid INTEGER PRIMARY KEY, oid INTEGER, root INTEGER DEFAULT 0,"
        "parent INTEGER DEFAULT 0, mid INTEGER DEFAULT 0, message TEXT, ctime INTEGER,"
        "likes INTEGER DEFAULT 0, fetched_at TEXT, round_id INTEGER DEFAULT 0);"
    )
    now = int(_t.time())
    min_ctime = now - 30 * 86400
    ancient = {"rpid": 1, "content": {"message": "2023年的热评"}, "ctime": now - 400 * 86400,
               "like": 999, "rcount": 0, "replies": []}
    fresh = {"rpid": 2, "content": {"message": "昨天的热评"}, "ctime": now - 3600,
             "like": 5, "rcount": 0, "replies": []}
    assert sampler._insert_comment(conn, ancient, 1, 1, min_ctime) is False
    assert sampler._insert_comment(conn, fresh, 1, 1, min_ctime) is True
    assert conn.execute("SELECT COUNT(*) FROM lake_comments").fetchone()[0] == 1
    conn.close()
