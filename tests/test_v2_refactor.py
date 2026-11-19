"""v2 重构回归：五通道发现（复读/后缀公式族/跨轮累积）、触发统计判别、
lookup 玩梗卡、iterate 重归纳、重名守卫。"""

import json

from conftest import seed_comments
from meme import candidates, entries
from meme.detect.signals import update_signals
from meme.errors import MemeError
from meme.lifecycle import transition_candidates
from meme.models import Card, Meme


# ---------- 复读通道 ----------

def test_copy_channel_cross_video_repeat(conn, cfg):
    """跨视频整句复读 → copy 候选；回复为主的复读 → interaction 预判。"""
    texts = ["警钟长鸣", "警钟长鸣", "警钟长鸣"]
    aids = [101, 102, 103]
    for i in range(60):  # filler
        texts.append(f"普通评论第{i}条没有任何梗")
        aids.append(200 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "警钟长鸣")
    assert cand is not None, "整句复读未入榜"
    assert cand.channel in ("copy", "phrase")
    assert cand.distinct_videos == 3


def test_copy_channel_interaction_kind(conn, cfg):
    """楼中楼回复复读（子评重复出现）→ kind_guess=interaction。"""
    import time

    ts = int(time.time())
    rows = [
        (7001, 601, 900, 900, 11, "你说这波什么水平", ts - 50),
        (7002, 601, 900, 900, 12, "急了急了", ts - 49),
        (7003, 602, 901, 901, 13, "我人都看傻了", ts - 40),
        (7004, 602, 901, 901, 14, "急了急了", ts - 39),
        (7005, 603, 902, 902, 15, "还有这种事", ts - 30),
        (7006, 603, 902, 902, 16, "急了急了", ts - 29),
    ]
    for rpid, oid, root, parent, mid, msg, ctime in rows:
        conn.execute(
            "INSERT INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id)"
            "VALUES(?,?,?,?,?,?,?,?,?,1)", (rpid, oid, root, parent, mid, msg, ctime, 0, "t", ),
        )
    for aid in (601, 602, 603):
        conn.execute(
            "INSERT INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source)"
            f"VALUES({aid},'BV{aid}','v',119,7,'up',0,0,'t','test')"
        )
    conn.commit()
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "急了急了")
    assert cand is not None, "回复复读未入榜"
    assert cand.kind_guess == "interaction", "回复为主的复读应预判 interaction"


# ---------- 后缀公式族 ----------

def test_suffix_family_synthesis(conn, cfg):
    """赢麻了/亏麻了/输麻了 各自低频，同后缀族 → <X>麻了 公式候选。"""
    texts, aids = [], []
    fam = ["赢麻了", "亏麻了", "输麻了", "赚麻了"]
    for i, w in enumerate(fam):
        texts.append(f"这波直接{w}")
        aids.append(301 + i)
        texts.append(f"兄弟们{w}，没眼看了")
        aids.append(305 + i)
    for i in range(60):
        texts.append(f"普通评论第{i}条")
        aids.append(400 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "<X>麻了")
    assert cand is not None, "后缀公式族未合成"
    assert cand.channel == "skeleton" and cand.kind_guess == "formula"
    assert cand.distinct_videos >= 4, "家族应合并跨视频证据"


def test_suffix_family_not_fired_for_plain_collocations(conn, cfg):
    """普通动宾搭配（X市场/X价格）不合成公式：族员无自身跨视频证据。"""
    texts, aids = [], []
    for w in ("股票市场", "期货市场", "牛市市场"):
        for i in range(2):
            texts.append(f"聊聊{w}的事第{i}条")
            aids.append(501 + i)
    for i in range(60):
        texts.append(f"普通评论第{i}条")
        aids.append(600 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "<X>市场") is None, "普通搭配被误合成为公式"


# ---------- 跨轮累积与触发 ----------

def test_cross_round_accumulation_triggers(conn, cfg):
    """轮内 1-2 次的真梗：既有候选再现即合流，dv 跨轮累积后触发。
    （v1 病灶：入榜门槛是轮内的，"难绷"每轮 1-2 次永远不入榜。）"""
    rounds = [
        (["难绷", "又是这活，难绷"], [705, 706]),
        (["真难绷", "难绷时刻"], [707, 708]),
        (["难绷住了", "这很难绷"], [709, 710]),
        (["太难绷了", "难绷，真的"], [711, 712]),
    ]
    for rid, (texts, aids) in enumerate(rounds, 1):
        filler = [f"普通评论{rid}{i}条" for i in range(4)]
        seed_comments(conn, texts + filler, aids=aids + [713 + i for i in range(4)],
                      round_id=rid, rpid_base=50000 + rid * 100)
        update_signals(conn, cfg, rid)
        transition_candidates(conn, cfg.lifecycle, rid)
    cand = candidates.by_head(conn, "难绷")
    assert cand is not None, "低频真梗跨轮未入榜"
    assert cand.distinct_videos >= 5, f"dv 应跨轮累积，实际 {cand.distinct_videos}"
    assert cand.surfs_seen >= 3
    assert cand.state == "triggered", "跨轮累积后应触发"


def test_generic_word_never_triggers(conn, cfg):
    """泛用词 dv 高但用例句句不同（零复读/零坍缩）→ 永不触发。"""
    # "不行" 出现在各种不同句子、跨视频跨轮——dv/du 都够，但 meme_score≈0
    variants = ["这也不行那也不行", "进度不行啊", "手感不行", "网络不行", "状态不行",
                "天气不行", "发挥不行", "队形不行", "成绩不行", "翻译不行"]
    for rid in (1, 2):
        texts = [variants[i % 10] + f"第{rid}{i}条" for i in range(10)]
        aids = [801 + i for i in range(10)]
        seed_comments(conn, texts, aids=aids, round_id=rid)
        update_signals(conn, cfg, rid)
        transition_candidates(conn, cfg.lifecycle, rid)
    cand = candidates.by_head(conn, "不行")
    if cand is not None:
        assert cand.state != "triggered", "泛用词被误触发"


# ---------- lookup 玩梗卡 ----------

def test_lookup_hit_inlines_card(conn, cfg):
    from click.testing import CliRunner

    from meme.cli import cli
    from meme.models import Constraints, MatcherSpec, PatternSpec

    m = Meme(id="m_0001", name="我软脚了", state="active",
             card=Card(gist="关键局操作变形的自嘲", usage=["决胜局我软脚了"],
                       taboo="别用于真实伤病", register="电竞圈", aggression="低"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["我软脚了", "软脚了"])],
                                 constraints=Constraints()))
    entries.save(conn, m)
    runner = CliRunner()
    res = runner.invoke(cli, ["--db", str(cfg.db_path), "lookup", "这波团战我软脚了"])
    assert res.exit_code == 0
    assert "关键局操作变形的自嘲" in res.output
    assert "决胜局我软脚了" in res.output
    assert "别用于真实伤病" in res.output


def test_lookup_json_card_field(conn, cfg):
    from click.testing import CliRunner

    from meme.cli import cli
    from meme.models import Constraints, MatcherSpec, PatternSpec

    m = Meme(id="m_0001", name="我软脚了", state="active",
             card=Card(gist="关键局操作变形的自嘲"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["我软脚了"])],
                                 constraints=Constraints()))
    entries.save(conn, m)
    runner = CliRunner()
    res = runner.invoke(cli, ["--db", str(cfg.db_path), "--json", "lookup", "我软脚了"])
    doc = json.loads(res.output)
    assert doc["result"] == "hit"
    assert doc["hits"][0]["card"]["gist"] == "关键局操作变形的自嘲"


def test_lookup_miss_includes_nearby(conn, cfg):
    from click.testing import CliRunner

    from meme.cli import cli
    from meme.models import Constraints, MatcherSpec, PatternSpec

    m = Meme(id="m_0001", name="警钟长鸣", state="active",
             card=Card(gist="时事警句复读"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["警钟长鸣"])],
                                 constraints=Constraints()))
    entries.save(conn, m)
    runner = CliRunner()
    res2 = runner.invoke(cli, ["--db", str(cfg.db_path), "--json", "lookup", "完全无关文本"])
    doc = json.loads(res2.output)
    assert doc["result"] == "miss"
    assert "suggestion" in doc


# ---------- 重名守卫 + iterate ----------

def _entry(name="我软脚了", aliases=None, gist="关键局操作变形的自嘲"):
    return {
        "name": name,
        "aliases": aliases or ["软脚了"],
        "class": "word",
        "birth_circa": None,
        "card": {"gist": gist, "usage": ["决胜局我软脚了"], "taboo": None,
                 "register": "电竞圈", "aggression": "低"},
        "examples": ["决胜局我软脚了"],
        "matcher": {"patterns": [{"kind": "lex", "terms": [name] + (aliases or [])}],
                    "constraints": {}},
        "lineage_parent": None,
        "lineage_mutation": None,
        "notes": None,
    }


def test_add_duplicate_guard_and_iterate(conn, cfg, tmp_path):
    from meme.induct.inductor import run_add_entry, run_iterate

    p1 = tmp_path / "e1.json"
    p1.write_text(json.dumps(_entry(), ensure_ascii=False), encoding="utf-8")
    res = run_add_entry(conn, cfg, json.loads(p1.read_text(encoding="utf-8")), text="我软脚了")
    assert res.meme.id == "m_0001"

    # 同名再 add → MEME_DUPLICATE 引导 iterate
    try:
        run_add_entry(conn, cfg, _entry(), text="我软脚了")
        raise AssertionError("重名未被拦截")
    except MemeError as e:
        assert e.code == "MEME_DUPLICATE"
        assert "iterate m_0001" in (e.suggestion or "")

    # iterate 原位修订：id/state 保留，释义变化 → drift 留痕
    m_before = entries.get(conn, "m_0001")
    e2 = _entry(gist="修正版释义：不限电竞，泛指关键时刻掉链子", aliases=["软脚了", "脚软了"])
    p2 = tmp_path / "e2.json"
    p2.write_text(json.dumps(e2, ensure_ascii=False), encoding="utf-8")
    res2 = run_iterate(conn, cfg, "m_0001", entry_path=str(p2))
    assert res2.meme.id == "m_0001", "iterate 必须原位更新"
    assert res2.meme.state == m_before.state
    assert res2.meme.card.gist.startswith("修正版释义")
    assert any(d.evidence == "iterate" for d in res2.meme.drift), "释义变化未留 drift"
    assert "脚软了" in res2.meme.aliases

    # 审计含 iterate 动作
    logs = conn.execute(
        "SELECT action FROM audit_log WHERE meme_id='m_0001' ORDER BY seq"
    ).fetchall()
    assert [r["action"] for r in logs] == ["induct", "iterate"]


def test_iterate_collects_wild_hits(conn, cfg):
    """iterate 证据收集：当前 matcher 在湖中的野外命中文本进入证据包。"""
    from meme.induct.inductor import _collect_iterate_evidence
    from meme.models import Constraints, MatcherSpec, PatternSpec

    m = Meme(id="m_0001", name="难绷", state="observing",
             card=Card(gist="无语到绷不住"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["难绷"])],
                                 constraints=Constraints()))
    entries.save(conn, m)
    seed_comments(conn, ["真的难绷", "难绷时刻", "无关评论"], aids=[901, 902, 903], round_id=1)
    ev = _collect_iterate_evidence(conn, m)
    texts = [u["text"] for u in ev["usages"]]
    assert "真的难绷" in texts and "难绷时刻" in texts
    assert "无关评论" not in texts
