"""采样框编排：热门 + 每周必看 + 高梗浓度分区 + 目标 up（§11）。

获取与呈现解耦：任何获取失败只降级、不阻塞 surf。
"""

from __future__ import annotations

import sqlite3
import sys
import time
from dataclasses import dataclass, field

from ..models import now_iso
from . import bilibili as bili
from .http import BiliSession, FetchError
from .wbi import WbiSigner


@dataclass
class FetchResult:
    new_videos: int = 0
    new_comments: int = 0
    old_skipped: int = 0
    degraded: bool = False
    reason: str | None = None
    hot_keywords: list[str] = field(default_factory=list)
    probed: list[str] = field(default_factory=list)  # 实际执行搜索探测的关键词
    sources_ok: list[str] = field(default_factory=list)
    sources_failed: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "new_videos": self.new_videos,
            "new_comments": self.new_comments,
            "old_skipped": self.old_skipped,
            "degraded": self.degraded,
            "reason": self.reason,
            "hot_keywords": self.hot_keywords,
            "probed": self.probed,
            "sources_ok": self.sources_ok,
            "sources_failed": self.sources_failed,
        }


def grab_probe(res: FetchResult, session: BiliSession, signer, kw: str, videos: list) -> None:
    """单个热词的搜索探测：结果并入候选视频池（source=probe，最高优先级）。"""
    try:
        vids = bili.search_videos(session, signer, kw)
        videos.extend(vids)
        res.sources_ok.append(f"probe:{kw[:12]}")
    except Exception as e:  # noqa: BLE001 - 单词失败不拖垮探测
        res.sources_failed.append(f"probe:{kw[:12]}:{getattr(e, 'code', type(e).__name__)}")


def _collect_videos(session: BiliSession, res: FetchResult, cfg, conn: sqlite3.Connection) -> list[dict]:
    videos: list[dict] = []
    signer: WbiSigner | None = None

    def _signer() -> WbiSigner:
        nonlocal signer
        if signer is None:
            signer = WbiSigner(session)
        return signer

    def grab(source: str, fn) -> None:
        try:
            videos.extend(fn())
            res.sources_ok.append(source)
        except FetchError as e:
            res.sources_failed.append(f"{source}:{e.code}")
        except Exception as e:  # noqa: BLE001 - 单源失败不拖垮整轮
            res.sources_failed.append(f"{source}:{type(e).__name__}")

    grab("popular", lambda: [
        v for p in range(1, max(cfg.popular_pages, 0) + 1) for v in bili.popular(session, p)
    ])
    if cfg.weekly:
        def _weekly():
            n = bili.weekly_latest_number(session)
            return bili.weekly(session, n) if n else []
        grab("weekly", _weekly)
    if getattr(cfg, "feed", False):
        grab("feed", lambda: [
            v for p in range(1, max(getattr(cfg, "feed_pages", 2), 0) + 1)
            for v in bili.feed_rcmd(session, _signer(), p)
        ])
    for rid in cfg.regions:
        grab(f"region:{rid}", lambda rid=rid: [
            v for p in range(1, max(cfg.region_pages, 0) + 1) for v in bili.region(session, rid, p)
        ])
    for rid in cfg.rank_regions:
        grab(f"rank:{rid}", lambda rid=rid: bili.rank_region(session, rid))
    if cfg.related_of_top:
        hosts = [r["aid"] for r in conn.execute(
            "SELECT aid FROM lake_videos ORDER BY reply_count DESC LIMIT ?", (cfg.related_of_top,)
        )]
        for aid in hosts:
            grab(f"related:{aid}", lambda aid=aid: bili.related(session, aid))
    if cfg.ups:
        for mid in cfg.ups:
            grab(f"up:{mid}", lambda mid=mid: bili.up_videos(session, _signer(), mid))
    if cfg.hot_words:
        # 热词是呈现层信号（D8），不是视频源——单独入 res
        try:
            res.hot_keywords = [k["keyword"] for k in bili.hot_search(session, 15)]
            res.sources_ok.append("hot_search")
        except (FetchError, Exception) as e:  # noqa: BLE001
            res.sources_failed.append(f"hot_search:{getattr(e, 'code', type(e).__name__)}")
    return videos


def _insert_video(conn: sqlite3.Connection, v: dict) -> None:
    conn.execute(
        "INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(aid) DO UPDATE SET reply_count=excluded.reply_count, fetched_at=excluded.fetched_at",
        (v["aid"], v["bvid"], v["title"], v["rid"], v["up_mid"], v["up_name"],
         v["pubdate"], v["reply_count"], now_iso(), v["source"]),
    )


def _reply_images(reply: dict) -> list[tuple[str, int, int]]:
    """提取一条评论的图片：(url, w, h)。真实字段是 content.pictures（实探校准，
    img_src/img_width/img_height）；content.image 仅作旧接口兜底。"""
    content = reply.get("content") or {}
    out: list[tuple[str, int, int]] = []
    for img in content.get("pictures") or content.get("image") or []:
        if not isinstance(img, dict):
            continue
        url = img.get("img_src") or img.get("image_url") or img.get("url") or ""
        if url:
            out.append((url, int(img.get("img_width") or 0), int(img.get("img_height") or 0)))
    return out


def _insert_comment(
    conn: sqlite3.Connection, r: dict, aid: int, round_id: int, min_ctime: int = 0
) -> bool:
    """内容寻址写入，返回是否为新评论。min_ctime 之前的远古评论不入湖（近期性闸门）。"""
    ctime = int(r.get("ctime") or 0)
    if min_ctime and ctime and ctime < min_ctime:
        return False
    cur = conn.execute(
        "INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (int(r["rpid"]), aid, int(r.get("root") or 0), int(r.get("parent") or 0),
         int(r.get("mid") or 0), (r.get("content") or {}).get("message", ""),
         ctime, int(r.get("like") or 0), now_iso(), round_id),
    )
    return cur.rowcount > 0


def _fetch_video_comments(
    conn: sqlite3.Connection, session: BiliSession, aid: int, cfg, round_id: int,
    is_new_video: bool, min_ctime: int = 0,
) -> tuple[int, int, list[tuple[int, str, int, int]]]:
    """拉取一个视频的评论（含楼中楼），返回 (新增数, 超龄跳过数, 图片评论)。"""
    added = 0
    skipped_old = 0
    roots_needing_sub: list[tuple[int, int]] = []  # (rpid, likes)
    img_comments: list[tuple[int, str, int, int]] = []  # (rpid, url, w, h) 图梗原料

    def insert(reply: dict) -> bool:
        """直插一条评论——root/parent 以 API 返回为准（交互梗配对依赖真实链）。"""
        nonlocal added, skipped_old
        if _insert_comment(conn, reply, aid, round_id, min_ctime):
            added += 1
            for url, w, h in _reply_images(reply):
                img_comments.append((int(reply["rpid"]), url, w, h))
            return True
        if min_ctime:
            ctime = int(reply.get("ctime") or 0)
            if ctime and ctime < min_ctime:
                skipped_old += 1
        return False

    max_pages = cfg.reply_pages_per_video if is_new_video else 1

    def crawl(mode: int, pages: int) -> None:
        """按给定排序爬 pages 页；insert 内部做内容寻址去重与年龄闸门。"""
        nonlocal added, skipped_old
        cursor = 0  # reply/main 的 next 是游标，从 0 起
        for _ in range(pages):
            try:
                out = bili.reply_main(session, aid, cursor, mode=mode)
            except FetchError:
                raise
            replies = out["replies"]
            if not replies:
                break
            new_in_page = 0
            for r in replies:
                if insert(r):
                    new_in_page += 1
                sub_preview = r.get("replies") or []
                for sub in sub_preview:
                    insert(sub)
                rcount = int(r.get("rcount") or 0)
                if rcount > len(sub_preview):
                    roots_needing_sub.append((int(r["rpid"]), int(r.get("like") or 0)))
            if added >= cfg.comments_per_video:
                break
            # 增量式：老视频热度页收益低（前页已覆盖且多为旧评），新视频翻到 is_end
            if mode == 2 and not is_new_video and new_in_page == 0:
                break
            if out["is_end"]:
                break
            nxt = out.get("next") or 0
            if nxt <= cursor:  # 游标不前进 → 防死循环
                break
            cursor = nxt

    crawl(2, max_pages)  # 热度页（高赞沉淀层）
    latest_pages = getattr(cfg, "latest_pages_per_video", 0) or 0
    if latest_pages and added < cfg.comments_per_video:
        crawl(3, latest_pages)  # 最新页（进行中梗浪，天然满足近期性闸门）
    # 楼中楼补全：取点赞最高的少量根评论，控制请求预算
    roots_needing_sub.sort(key=lambda x: -x[1])
    sub_roots = max(getattr(cfg, "subreply_roots", 0) or 0, 0) or 5
    sub_pages = max(getattr(cfg, "subreply_pages_per_root", 1) or 1, 1)
    for rpid, _ in roots_needing_sub[:sub_roots]:
        if added >= cfg.comments_per_video:
            break
        for pg in range(1, sub_pages + 1):
            try:
                subs = bili.sub_replies(session, aid, rpid, pg)
            except FetchError:
                break
            if not subs:
                break
            for sub in subs:
                insert(sub)
    return added, skipped_old, img_comments


def _fetch_comment_images(
    conn: sqlite3.Connection, session: BiliSession,
    img_comments: list[tuple[int, str, int, int]], round_id: int, cap: int,
) -> int:
    """下载评论图片并计算 pHash 入库（图梗发现原料）。URL 内容寻址，跨视频去重。"""
    from ..detect.imgphash import phash_bytes

    if cap <= 0 or not img_comments:
        return 0
    seen_urls = {r["url"] for r in conn.execute("SELECT url FROM lake_comment_images")}
    n = 0
    for rpid, url, w, h in img_comments:
        if n >= cap:
            break
        if url in seen_urls:
            continue
        seen_urls.add(url)
        try:
            data = session.get_bytes(url)
        except Exception as e:  # noqa: BLE001 - 单图失败不拖垮轮次
            print(f"meme: fetch: 图片下载失败 {url[:60]}（{type(e).__name__}）", file=sys.stderr)
            continue
        ph = phash_bytes(data)
        conn.execute(
            "INSERT OR IGNORE INTO lake_comment_images(rpid,url,phash,width,height,round_id) "
            "VALUES(?,?,?,?,?,?)",
            (rpid, url, ph, w, h, round_id),
        )
        n += 1
    if n:
        conn.commit()
    return n


def run_fetch(conn: sqlite3.Connection, cfg, round_id: int, probe_extra: list[str] | None = None) -> FetchResult:
    """执行一轮增量获取。任何网络失败 → degraded=True，存量照常出内容。

    probe_extra：操作员定向探测词（surf --probe），优先于热词；搜索需登录态。
    """
    import os as _os

    res = FetchResult()
    sessdata = _os.environ.get(cfg.sessdata_env, "") if cfg.sessdata_env else ""
    session = BiliSession(cfg.delay_min, cfg.delay_max, cfg.timeout, sessdata=sessdata)
    try:
        videos = _collect_videos(session, res, cfg, conn)
        if (probe_extra or cfg.probe_keywords) and not sessdata:
            print(
                "meme: fetch: 搜索探测需要登录态（配置 sessdata_env 并设置对应环境变量），本轮跳过",
                file=sys.stderr,
            )
        if sessdata and (probe_extra or cfg.probe_keywords):
            # 搜索探测（§11 交叉验证）：登录态搜索关键词，定位承载梗浪的视频。
            # 操作员 --probe 定向词全量探测；热词按 probe_keywords 预算截断。
            signer = WbiSigner(session)
            kws = list(dict.fromkeys(probe_extra or []))
            kws += [k for k in res.hot_keywords if k not in kws][: max(cfg.probe_keywords - len(kws), 0)]
            if kws:
                for kw in kws:
                    grab_probe(res, session, signer, kw, videos)
                res.probed = kws
        if not videos and res.sources_failed and not res.sources_ok:
            res.degraded = True
            res.reason = "全部数据源失败：" + ", ".join(res.sources_failed[:3])
            return res
        # 去重 + 排序：周榜/新视频优先，其余按评论数降序；老视频 3 天内不重爬
        seen: dict[int, dict] = {}
        for v in videos:
            if v["aid"] and v["aid"] not in seen:
                seen[v["aid"]] = v
        stale_days = 3
        cutoff = time.time() - stale_days * 86400
        fresh_rows = {
            r["aid"]: r for r in conn.execute(
                "SELECT aid, fetched_at FROM lake_videos WHERE fetched_at >= ?",
                (time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(cutoff)),),
            )
        }
        known = {r["aid"] for r in conn.execute("SELECT aid FROM lake_videos")}
        max_vage = getattr(cfg, "max_video_age_days", 0) or 0
        min_pub = int(time.time()) - max_vage * 86400 if max_vage else 0

        def rank(v: dict):
            # 发现优先级：probe（定向确认）> feed（自动推送，发现主动入口）>
            # rank（周榜枢纽）> 其他新视频 > 已知
            if v["source"] == "probe":
                tier = 0
            elif v["source"] == "feed":
                tier = 1
            elif v["source"] == "rank":
                tier = 2
            else:
                tier = 3 if v["aid"] not in known else 4
            return (tier, -v["reply_count"], v["aid"])
        # 单源配额封顶：防止头部源（周榜 93 视频）霸占配额，饿死顺藤摸瓜簇
        cap = max(getattr(cfg, "max_per_source", 0) or 0, 0)
        picked: list[dict] = []
        per_source: dict[str, int] = {}
        for v in sorted(seen.values(), key=rank):
            if v["aid"] in fresh_rows:  # 近期爬过的跳过
                continue
            if min_pub and v["pubdate"] and v["pubdate"] < min_pub:
                continue  # 视频年龄闸门：近期梗长在近期视频上
            src = v["source"].split(":")[0]
            if cap and per_source.get(src, 0) >= cap:
                continue
            picked.append(v)
            per_source[src] = per_source.get(src, 0) + 1
            if len(picked) >= cfg.videos_per_round:
                break
        min_ctime = (
            int(time.time()) - int(cfg.max_comment_age_days) * 86400
            if cfg.max_comment_age_days > 0
            else 0
        )
        img_cap = int(getattr(cfg, "comment_images_per_round", 0) or 0)
        img_budget = img_cap
        for v in picked:
            is_new = v["aid"] not in known
            _insert_video(conn, v)
            if is_new:
                res.new_videos += 1
            try:
                added, skipped, img_comments = _fetch_video_comments(
                    conn, session, v["aid"], cfg, round_id, is_new, min_ctime
                )
                res.new_comments += added
                res.old_skipped += skipped
                if img_cap and img_budget > 0:
                    img_budget -= _fetch_comment_images(
                        conn, session, img_comments, round_id, img_budget
                    )
            except FetchError as e:
                print(f"meme: fetch: 视频 {v['aid']} 评论失败（{e.code}），跳过", file=sys.stderr)
                continue
            conn.commit()
        if res.old_skipped:
            print(
                f"meme: fetch: 已按近期性闸门跳过 {res.old_skipped} 条"
                f"超过 {cfg.max_comment_age_days} 天的远古评论",
                file=sys.stderr,
            )
        if not res.sources_ok and not picked:
            res.degraded = True
            res.reason = res.reason or "无可用新视频（数据源失败或全部近期已爬）"
        return res
    finally:
        session.close()
