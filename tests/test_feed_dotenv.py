"""登录态 surf 基建回归：.env 加载、推荐流（自动推送）解析。"""

import pytest

from meme.config import _load_dotenv
from meme.fetch import bilibili as bili


def test_dotenv_load(tmp_path, monkeypatch):
    """cwd/.env 加载；已存在的环境变量不覆盖；注释与引号剥离。"""
    (tmp_path / ".env").write_text(
        '# 注释行\nBILI_SESSDATA="abc123"\nEMPTY=\nMEME_DB=/tmp/x.db\n',
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("BILI_SESSDATA", raising=False)
    monkeypatch.delenv("MEME_DB", raising=False)
    _load_dotenv()
    import os

    assert os.environ["BILI_SESSDATA"] == "abc123"
    assert os.environ["MEME_DB"] == "/tmp/x.db"
    monkeypatch.setenv("BILI_SESSDATA", "keep-me")
    _load_dotenv()
    assert os.environ["BILI_SESSDATA"] == "keep-me"  # 不覆盖已有


class FakeSigner:
    def sign(self, params):
        return params


class FakeSession:
    """get_json 返回去壳 data 载荷（与真实 BiliSession 契约一致）。"""

    def __init__(self, pages):
        self.pages = list(pages)

    def get_json(self, url, params=None):
        return self.pages.pop(0)


def test_feed_rcmd_parses_items():
    """推荐流项 → 统一视频行：id→aid、owner 提取、无 reply 记 0、非 av 卡片跳过。"""
    payload = {
        "item": [
            {"id": 111, "bvid": "BV1", "title": "标题1", "goto": "av",
             "owner": {"mid": 9, "name": "up甲"}, "pubdate": 1794000000,
             "stat": {"view": 100, "like": 5, "danmaku": 1}},
            {"id": 222, "bvid": "BV2", "title": "直播卡", "goto": "live"},
            {"aid": 333, "bvid": "BV3", "title": "标题3", "goto": "av",
             "owner": {"mid": 8, "name": "up乙"}, "pubdate": 1794000100, "stat": {}},
        ],
    }
    s = FakeSession([payload, payload])
    out = bili.feed_rcmd(s, FakeSigner(), page=1)
    assert [v["aid"] for v in out] == [111, 333]
    assert out[0]["source"] == "feed"
    assert out[0]["up_name"] == "up甲"
    assert out[0]["reply_count"] == 0  # 推荐流无 reply 字段
    assert out[1]["aid"] == 333  # aid 键回退兼容
    # 翻页
    assert bili.feed_rcmd(s, FakeSigner(), page=2)[0]["aid"] == 111
    with pytest.raises(IndexError):
        bili.feed_rcmd(s, FakeSigner(), page=3)
