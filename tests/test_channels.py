"""新通道回归：接龙（一人一字）、回复前缀剥离、pHash 图梗聚类。"""

import time

from meme import candidates
from meme.detect.imgphash import hamming, phash_bytes
from meme.detect.ngram import phrases
from meme.detect.signals import update_signals


def _png_bytes(color: tuple[int, int, int], size: int = 64) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (size, size), color).save(buf, format="PNG")
    return buf.getvalue()


def test_reply_prefix_stripped():
    """楼中楼 UI 前缀（回复 @某人 ：）是界面残留，不得进骨架/短语。"""
    ps = phrases("回复 @某人 ：太典了")
    assert "太典了" in ps
    assert not any("回复" in p for p in ps)
    from meme.detect.skel import skeleton_variants

    vs = skeleton_variants("回复 @某人 ：太典了")
    assert not any(v.startswith("回复") for v in vs)


def test_chain_detection(conn, cfg):
    """接龙 = 楼中楼短消息自动拼接：拼接文本作为普通单元参与短语通道，标记 chain。

    同人连发也拼接（无相邻同人限制）；「句号」特例天然覆盖（2 字消息）。
    """
    ts = int(time.time())
    rows = [
        # 视频 8001，根 900：同人连发「好」「笑」——不设相邻同人限制，照样拼接
        (6001, 8001, 900, 900, 11, "好", ts - 50),
        (6002, 8001, 900, 900, 11, "笑", ts - 49),
        # 视频 8001，根 901：两人各一字
        (6003, 8001, 901, 901, 12, "好", ts - 40),
        (6004, 8001, 901, 901, 13, "笑", ts - 39),
        # 视频 8002，根 902：含「句号」特例
        (6005, 8002, 902, 902, 14, "好", ts - 30),
        (6006, 8002, 902, 902, 15, "笑", ts - 29),
        (6007, 8002, 902, 902, 16, "句号", ts - 28),
        # 干扰：被打断的短评论串（中间夹长评论）——好/笑 分属两侧 run，各长 1，不拼接
        (6011, 8003, 903, 903, 21, "好", ts - 20),
        (6012, 8003, 903, 903, 22, "这句很长所以打断了拼接", ts - 19),
        (6013, 8003, 903, 903, 23, "笑", ts - 18),
    ]
    for rpid, oid, root, parent, mid, msg, ctime in rows:
        conn.execute(
            "INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id)"
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (rpid, oid, root, parent, mid, msg, ctime, 0, "t", 1),
        )
    for aid in (8001, 8002, 8003):
        conn.execute(
            "INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source)"
            f"VALUES({aid},'BV{aid}','v',119,7,'up',0,0,'t','test')"
        )
    conn.commit()

    res = update_signals(conn, cfg, 1)
    # 拼接文本「好笑」×2 视频 3 次（好/笑 单字各自也计数）→ 正常短语候选
    cand = candidates.by_head(conn, "好笑")
    assert cand is not None, "拼接文本未走通短语通道"
    assert cand.distinct_videos == 2
    assert cand.evidence_usages, "无用例"
    assert all(u.chain for u in cand.evidence_usages), "拼接来源未标记 chain"
    # 含句号的拼接产出的短语（好笑/笑了句号等）也在计数里，但没有特殊「接龙：」候选头
    assert not any(c.channel == "chain" for c in candidates.all_active(conn))
    # 10 条真实评论（6001-6007 + 6011-6013）+ 3 个拼接单元
    assert res.scanned == 13


def test_short_proper_noun_relief(conn, cfg):
    """短词 Relief（实战反馈）：滔博/陀螺这类专名梗词只活在句中，独立成评率恒低——
    高频 + 极低 df 的 ≤2 字内容词应免独立成评入榜。"""
    from conftest import seed_comments

    texts, aids = [], []
    for i in range(9):  # 9 次、3 视频、句中用法（逗号切分出"滔博" gram，零独立成评）
        texts.append(f"滔博，第{i}把稳了")
        aids.append([910, 911, 912][i % 3])
    texts.append("甲乙两个词只在句中出现一次")  # 对照：低频短词仍被闸
    aids.append(910)
    # Relief 门槛需要 df 分母（n≥50 且 9/n ≤ 0.05 → n ≥ 180）：补 filler 评论
    for i in range(200):
        texts.append(f"普通观众留言第{i}号没有任何梗")
        aids.append(920 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "滔博")
    assert cand is not None and cand.distinct_videos == 3
    assert candidates.by_head(conn, "甲乙") is None  # 低频短词不豁免


def test_low_freq_distinctive_survives_flood(conn, cfg):
    """教训回归：创建上限按次数截断曾把滔博/陀螺类低频专名静默挤出榜——
    现在全部过闸短语都创建候选，独特低频词与刷屏词并存，治理靠过期+操作员。"""
    from conftest import seed_comments

    texts, aids = [], []
    for i in range(200):  # 刷屏洪流："希望"计数 200
        texts.append(f"希望大家多多点赞支持{i}")
        aids.append(950 + i % 3)
    for i in range(5):  # 独特低频词：cnt 5，df≈0.024（逗号隔离防 jieba 融合）
        texts.append(f"真是青铜巨像，第{i}个名场面")
        aids.append(960 + i % 2)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "青铜巨像") is not None, "独特低频词被创建上限杀死"
    assert candidates.by_head(conn, "希望") is None  # 对照：df≈1.0 的刷屏词被 df 闸门拒绝
    # v2：青铜（2 字 cnt5 dv2）允许入榜——轻门槛立户 + 统计判别压制，
    # 不再用 Relief 地板硬闸（那曾把滔博类专名一并误杀）


def test_judgment_guide_in_tool_surfaces():
    """判梗参考进工具（轻强调：视角而非模板）：归纳提示词 + surf 呈现。"""
    from meme.induct.prompts import build_induction_prompt
    from meme.surf.present import render_zones

    system, user = build_induction_prompt(
        {"kind": "word", "head": "X", "spread": {"videos": 2, "ups": 2}, "usages": []},
        "zero_word",
    )
    assert "判梗参考" in system
    assert "不是判定模板" in system  # 明确非模板定位，防过度强调
    assert "以证据为准" in system
    zones = {"counts": {"new": 0, "dynamics": 0, "fading": 0, "backlog": 0},
             "new_candidates": [], "dynamics": [], "fading": [],
             "backlog_line": "x", "page": 0, "has_more": False}
    assert "判梗参考" in render_zones(zones, "footer")


def test_probe_extra_passed_to_fetch(conn, cfg):
    """surf --probe：操作员定向探测词原样传给 fetcher。"""
    from conftest import fake_fetch_round
    from meme.surf.run import run_surf

    captured = {}

    def fake(conn, fcfg, round_id, probe_extra=None):
        captured["probe"] = probe_extra
        return fake_fetch_round()(conn, fcfg, round_id, probe_extra)

    run_surf(conn, cfg, probe_extra=["我记下了", "烧心"], _fetch=fake)
    assert captured["probe"] == ["我记下了", "烧心"]


def test_phash_basics():
    """同图同哈希；异图远距离。"""
    h1 = phash_bytes(_png_bytes((255, 0, 0)))
    assert h1 is not None and len(h1) == 16
    assert phash_bytes(_png_bytes((255, 0, 0))) == h1
    h2 = phash_bytes(_png_bytes((0, 0, 255)))
    assert hamming(h1, h2) > 8


def test_image_cluster_candidates(conn, cfg):
    """图梗：pHash 相近的跨视频图片聚成同簇候选，跨轮累积视频数。"""
    ts = int(time.time())
    h_a = "0000000000000000"
    h_a2 = "0700000000000000"  # 与 h_a 汉明距 3
    h_far = "ffffffffffffffff"
    imgs = [
        (7001, 8001, h_a, 1), (7002, 8002, h_a2, 1), (7003, 8003, h_far, 1),
    ]
    for rpid, oid, ph, rid in imgs:
        conn.execute(
            "INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id)"
            "VALUES(?,?,0,0,0,'[图]',?,0,'t',?)", (rpid, oid, ts, rid))
        conn.execute(
            "INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source)"
            "VALUES(?, 'BV','v',119,7,'up',0,0,'t','test')", (oid,))
        conn.execute(
            "INSERT INTO lake_comment_images(rpid,url,phash,width,height,round_id)"
            "VALUES(?,?,?,0,0,?)", (rpid, f"https://img/{rpid}.jpg", ph, rid))
    # 轮 2：又一处相近变体
    conn.execute(
        "INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id)"
        "VALUES(7004,8004,0,0,0,'[图]',?,0,'t',2)", (ts + 1,))
    conn.execute(
        "INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source)"
        "VALUES(8004,'BV','v4',119,9,'up',0,0,'t','test')")
    conn.execute(
        "INSERT INTO lake_comment_images(rpid,url,phash,width,height,round_id)"
        "VALUES(7004,'https://img/7004.jpg',?,0,0,2)", ("0f00000000000000",))  # 与 h_a 汉明距 4
    conn.commit()

    update_signals(conn, cfg, 1)
    cands = [c for c in candidates.all_active(conn) if c.channel == "image"]
    assert len(cands) == 2  # h_a 簇 + h_far 簇
    big = [c for c in cands if c.distinct_videos == 2]
    assert len(big) == 1 and big[0].head.startswith("img:00000000")

    update_signals(conn, cfg, 2)
    big2 = [c for c in candidates.all_active(conn) if c.channel == "image" and c.distinct_videos == 3]
    assert len(big2) == 1 and big2[0].surfs_seen >= 2  # surfs_seen 按命中次数累积（图 3 次）


def test_fetch_comment_images(tmp_path, cfg):
    """图片下载 + pHash 入库；URL 内容寻址去重；cap 生效。"""
    import sqlite3

    from meme.fetch.http import BiliSession
    from meme.fetch.sampler import _fetch_comment_images

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        "CREATE TABLE lake_comment_images(rpid INTEGER, url TEXT, phash TEXT, width INTEGER,"
        "height INTEGER, round_id INTEGER, PRIMARY KEY(rpid,url));"
        "CREATE TABLE lake_comments(rpid INTEGER PRIMARY KEY, oid INTEGER, root INTEGER DEFAULT 0,"
        "parent INTEGER DEFAULT 0, mid INTEGER DEFAULT 0, message TEXT, ctime INTEGER, likes INTEGER"
        " DEFAULT 0, fetched_at TEXT, round_id INTEGER DEFAULT 0);"
    )

    class FakeSession:
        def __init__(self):
            self.calls = 0

        def get_bytes(self, url):
            self.calls += 1
            return _png_bytes((10, 20, 30) if "a" in url else (200, 100, 50))

    sess = FakeSession()
    n = _fetch_comment_images(conn, sess, [
        (7001, "https://img/a.png", 100, 100),
        (7002, "https://img/b.png", 100, 100),
        (7001, "https://img/a.png", 100, 100),  # 重复 URL
    ], round_id=1, cap=5)
    assert n == 2 and sess.calls == 2
    rows = conn.execute("SELECT rpid, phash FROM lake_comment_images").fetchall()
    assert all(r["phash"] and len(r["phash"]) == 16 for r in rows)
    # cap=1 只下一张
    n2 = _fetch_comment_images(conn, FakeSession(), [
        (7003, "https://img/c.png", 10, 10), (7004, "https://img/d.png", 10, 10),
    ], round_id=2, cap=1)
    assert n2 == 1
