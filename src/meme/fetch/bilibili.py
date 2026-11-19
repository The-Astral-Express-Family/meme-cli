"""B站公开端点封装（匿名）。全部失败由上层降级（§6.6）。"""

from __future__ import annotations

from .http import BiliSession, FetchError
from .wbi import WbiSigner

API = "https://api.bilibili.com"


def _video_row(v: dict, source: str) -> dict:
    owner = v.get("owner") or v.get("author") or {}
    stat = v.get("stat") or {}
    return {
        "aid": int(v.get("aid", 0)),
        "bvid": v.get("bvid", ""),
        "title": v.get("title", ""),
        "rid": v.get("tid") or v.get("rid") or 0,
        "up_mid": int(owner.get("mid", v.get("mid", 0)) or 0),
        "up_name": owner.get("name") or v.get("author") or "",
        "pubdate": int(v.get("pubdate") or v.get("created") or 0),
        "reply_count": int(stat.get("reply") or v.get("reply") or 0),
        "source": source,
    }


def popular(s: BiliSession, page: int = 1) -> list[dict]:
    data = s.get_json(f"{API}/x/web-interface/popular", {"ps": 20, "pn": page})
    return [_video_row(v, "popular") for v in data.get("list") or []]


def weekly_latest_number(s: BiliSession) -> int | None:
    data = s.get_json(f"{API}/x/web-interface/popular/series/list")
    lst = data.get("list") or []
    return int(lst[0]["number"]) if lst else None


def weekly(s: BiliSession, number: int) -> list[dict]:
    data = s.get_json(f"{API}/x/web-interface/popular/series/one", {"number": number})
    return [_video_row(v, "weekly") for v in data.get("list") or []]


def region(s: BiliSession, rid: int, page: int = 1, ps: int = 20) -> list[dict]:
    data = s.get_json(f"{API}/x/web-interface/dynamic/region", {"rid": rid, "ps": ps, "pn": page})
    return [_video_row(v, "region") for v in data.get("archives") or []]


def up_videos(s: BiliSession, signer: WbiSigner, mid: int) -> list[dict]:
    params = signer.sign({"mid": mid, "ps": 30, "pn": 1, "order": "pubdate"})
    data = s.get_json(f"{API}/x/space/wbi/arc/search", params)
    vlist = ((data.get("list") or {}).get("vlist")) or []
    return [_video_row(v, "up") for v in vlist]


def hot_search(s: BiliSession, limit: int = 20) -> list[dict]:
    """站内热搜词（今日热点）。搜索接口需登录，热词仅作呈现层决策支持（D8）。"""
    data = s.get_json(f"{API}/x/web-interface/search/square", {"limit": limit})
    lst = (data.get("trending") or {}).get("list") or []
    return [{"keyword": (t.get("keyword") or "").strip(),
             "show_name": (t.get("show_name") or "").strip()} for t in lst if t.get("keyword")]


def rank_region(s: BiliSession, rid: int) -> list[dict]:
    """分区周榜（排行版）：头部视频评论区是梗浪主战场。"""
    data = s.get_json(f"{API}/x/web-interface/ranking/v2", {"rid": rid, "type": "all"})
    return [_video_row(v, "rank") for v in (data.get("list") or [])]


def feed_rcmd(s: BiliSession, signer: WbiSigner, page: int = 1, ps: int = 20) -> list[dict]:
    """首页推荐流（自动推送）：发现的主动入口——站方推荐序就是实时热度信号，
    不依赖操作员猜关键词（关键词检索降级为梗信息确认工具，surf --probe）。"""
    params = signer.sign({
        "feed_version": "V3", "fresh_type": 4, "fresh_day": 1,
        "fresh_idx": page, "fresh_idx_1h": page, "ps": ps, "platform": "web",
    })
    data = s.get_json(f"{API}/x/web-interface/index/top/feed/rcmd", params)
    out = []
    for it in data.get("item") or []:
        if it.get("goto") not in (None, "av"):  # 非 av 卡片（直播/广告位）跳过
            continue
        stat = it.get("stat") or {}
        out.append(_video_row({
            "aid": it.get("id") or it.get("aid"),
            "bvid": it.get("bvid", ""),
            "title": it.get("title", ""),
            "tid": 0,
            "owner": {"mid": (it.get("owner") or {}).get("mid", 0),
                      "name": (it.get("owner") or {}).get("name", "")},
            "pubdate": it.get("pubdate") or 0,
            "stat": {"reply": stat.get("reply") or 0},
        }, "feed"))
    return out


def related(s: BiliSession, aid: int) -> list[dict]:
    """相关视频推荐：从已知视频顺藤摸瓜（梗浪跨相关视频传播）。"""
    data = s.get_json(f"{API}/x/web-interface/archive/related", {"aid": aid})
    return [_video_row(v, "related") for v in (data or [])]


_RE_TAG = None


def search_videos(s: BiliSession, signer: WbiSigner, keyword: str, page: int = 1) -> list[dict]:
    """关键词搜视频（综合排序，需登录态）——热词探测：定位承载梗浪的视频（§11 交叉验证）。"""
    import re as _re

    params = signer.sign({
        "search_type": "video", "keyword": keyword, "page": page,
        "page_size": 20, "order": "totalrank",
    })
    data = s.get_json(f"{API}/x/web-interface/wbi/search/type", params)
    out = []
    for it in data.get("result") or []:
        if not it.get("aid"):
            continue
        title = _re.sub(r"<[^>]+>", "", it.get("title") or "")
        out.append(_video_row({
            "aid": it["aid"], "bvid": it.get("bvid", ""), "title": title,
            "tid": it.get("tid") or 0,
            "owner": {"mid": it.get("mid") or 0, "name": it.get("author") or ""},
            "pubdate": it.get("pubdate") or 0,
            "stat": {"reply": it.get("review") or 0},
        }, "probe"))
    return out


def reply_main(s: BiliSession, aid: int, next_cursor: int = 0, mode: int = 2) -> dict:
    """主评论区。mode: 2=热度序 3=时间序（最新评论=进行中梗浪）。next 是游标（从 0 起）。"""
    data = s.get_json(
        f"{API}/x/v2/reply/main", {"type": 1, "oid": aid, "mode": mode, "next": next_cursor}
    )
    replies = data.get("replies") or []
    cursor = data.get("cursor") or {}
    return {
        "replies": replies,
        "is_end": bool(cursor.get("is_end")),
        "next": int(cursor.get("next") or 0),
    }


def sub_replies(s: BiliSession, aid: int, root: int, page: int = 1) -> list[dict]:
    """楼中楼（交互梗配对样本来源，§4.1）。"""
    data = s.get_json(
        f"{API}/x/v2/reply/reply",
        {"type": 1, "oid": aid, "root": root, "ps": 20, "pn": page},
    )
    return data.get("replies") or []


__all__ = [
    "BiliSession",
    "FetchError",
    "WbiSigner",
    "popular",
    "weekly",
    "weekly_latest_number",
    "region",
    "up_videos",
    "hot_search",
    "rank_region",
    "feed_rcmd",
    "related",
    "reply_main",
    "sub_replies",
]
