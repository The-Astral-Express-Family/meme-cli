"""测试夹具：临时库、假 fetcher、假 LLM。全部离线。"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from meme.config import Config  # noqa: E402
from meme.db import connect  # noqa: E402


@pytest.fixture()
def cfg(tmp_path) -> Config:
    c = Config()
    c.db_path = tmp_path / "test.db"
    c.retrieval.embed_model = "BAAI/bge-small-zh-v1.5"
    return c


@pytest.fixture()
def conn(cfg):
    c = connect(cfg.db_path)
    yield c
    c.close()


class FakeLLM:
    """可编程假 LLM：按序返回预设响应（跳过网络）。"""

    def __init__(self, responses: list):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def complete(self, system, user, model=None, effort=None, max_tokens=None, retries=0):
        from meme.induct.llm import LLMResult

        self.calls.append({"system": system, "user": user, "model": model})
        if not self.responses:
            raise AssertionError("FakeLLM 预设响应耗尽")
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return LLMResult(text=r, model=model or "fake",
                         usage={"input_tokens": 10, "output_tokens": 20})


def fake_fetch_round(new_comments: int = 0, videos: int = 0, degraded: bool = False, reason=None):
    from meme.fetch.sampler import FetchResult

    def _fetch(conn, fcfg, round_id, probe_extra=None):
        res = FetchResult(new_videos=videos, new_comments=new_comments,
                          degraded=degraded, reason=reason)
        res.probed = list(probe_extra or [])
        return res

    return _fetch


def seed_comments(conn, texts, aids=None, round_id=1, days_ago=0, rpid_base=50000):
    """直灌原始湖（绕过网络），并登记视频元数据。多轮 seed 用不同 rpid_base 防冲突。"""
    import time

    aids = aids or [1001 + i // max(len(texts) // 3, 1) for i in range(len(texts))]
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    for i, (t, aid) in enumerate(zip(texts, aids)):
        conn.execute(
            "INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id)"
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (rpid_base + i, aid, 0, 0, 9000 + i, t, int(time.time()) - days_ago * 86400, i, ts, round_id),
        )
        conn.execute(
            "INSERT OR IGNORE INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source)"
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (aid, f"BV{i}", f"视频{aid}", 119, 7000 + aid % 5, f"up{aid % 5}", 0, 100, ts, "test"),
        )
    conn.commit()
