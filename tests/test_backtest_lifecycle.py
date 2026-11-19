"""backtest 闸门与生命周期状态机（§7.4、§4.5）。"""

from meme import entries, lifecycle
from meme.induct.backtest import run_backtest
from meme.match.pipeline import CompiledMatcher
from meme.models import Card, Constraints, Meme, PatternSpec


def _meme_with_matcher() -> Meme:
    return Meme(
        id="m_0001", name="一眼X鉴定为Y", **{"class": "formula"},
        card=Card(gist="公式梗"),
        matcher=__import__("meme.models", fromlist=["MatcherSpec"]).MatcherSpec(
            patterns=[PatternSpec(kind="skeleton", tokens=["一眼", "<ent>", "鉴定为", "<ent>"])],
            constraints=Constraints(),
        ),
    )


def test_backtest_pass_on_good_matcher(conn):
    from conftest import seed_comments

    m = _meme_with_matcher()
    positives = [f"一眼{i}鉴定为{i}玩家" for i in range(1, 15)]
    # 负例：原始湖灌入普通评论
    seed_comments(conn, [f"普通评论第{i}条，今天天气不错" for i in range(300)])
    res = run_backtest(conn, m, CompiledMatcher(m), positives,
                       min_hit=0.7, max_fp=0.02, negatives=200)
    assert res.passed, res.to_dict()
    assert res.hit_rate >= 0.7
    assert res.fp_rate <= 0.02


def test_backtest_fails_on_broad_matcher(conn):
    from conftest import seed_comments

    m = Meme(
        id="m_0002", name="太宽了", **{"class": "word"},
        card=Card(gist="无约束词表，必误报"),
        matcher=__import__("meme.models", fromlist=["MatcherSpec"]).MatcherSpec(
            patterns=[PatternSpec(kind="lex", terms=["的"])],  # 泛用虚词 → 高误报
            constraints=Constraints(),
        ),
    )
    positives = ["我的的看法", "你的意思"]
    seed_comments(conn, [f"这是第{i}条很普通很普通的评论" for i in range(300)])
    res = run_backtest(conn, m, CompiledMatcher(m), positives,
                       min_hit=0.7, max_fp=0.02, negatives=200)
    assert not res.passed
    assert res.false_hits  # 误报样本被收集（修订轮的输入）


def test_candidate_trigger_gate(cfg, conn):
    from meme.candidates import upsert_from_signal
    from meme.lifecycle import candidate_should_trigger
    from meme.models import UsageSample

    cand = upsert_from_signal(conn, head="绷", channel="phrase", kind_guess="word",
                              usages=[UsageSample(text="绷不住了")],
                              video_pairs=[(1, 1)], round_id=1)
    assert not candidate_should_trigger(cand, cfg.lifecycle)  # 单视频不足
    for aid in range(2, 18):  # 造到 17 个视频，越过 wide 通道阈值 15
        cand = upsert_from_signal(conn, head="绷", channel="phrase", kind_guess="word",
                                  usages=[], video_pairs=[(aid, aid)], round_id=2)
    assert cand.distinct_videos >= cfg.lifecycle.trigger_videos_alt
    assert candidate_should_trigger(cand, cfg.lifecycle)  # 视频数走 wide 通道


def test_observing_promotes_after_consecutive_rounds(conn, cfg):
    m = Meme(id="m_0010", name="急", card=Card(gist="急了"),
             matcher=__import__("meme.models", fromlist=["MatcherSpec"]).MatcherSpec(
                 patterns=[PatternSpec(kind="lex", terms=["急"])],
                 constraints=Constraints(standalone=True)))
    entries.save(conn, m)
    import datetime

    day = datetime.date.today().isoformat()
    lifecycle.note_wild_match(conn, m, 1, day, 3, cfg.lifecycle.promote_rounds)
    assert entries.get(conn, "m_0010").state == "observing"  # 1 轮不够
    lifecycle.note_wild_match(conn, entries.get(conn, "m_0010"), 2, day, 2,
                              cfg.lifecycle.promote_rounds)
    assert entries.get(conn, "m_0010").state == "active"  # 连续 2 轮 → 升格


def test_fade_and_tombstone(conn, cfg):
    import datetime

    m = Meme(id="m_0020", name="过气梗", state="active", card=Card(gist="凉了"))
    entries.save(conn, m)
    today = datetime.date.today()
    # 90 天窗口：第 60~31 天前每天 10 次，近 30 天归零
    for d in range(60, 30, -1):
        day = (today - datetime.timedelta(days=d)).isoformat()
        conn.execute("INSERT OR REPLACE INTO meme_hit_daily VALUES(?,?,?)", (m.id, day, 10))
    conn.commit()
    changes = lifecycle.check_fade(conn, cfg.lifecycle)
    assert any(c["id"] == "m_0020" and c["to"] == "fading" for c in changes)
    m2 = entries.get(conn, "m_0020")
    assert m2.state == "fading"
    # 持续衰减至近零 → tombstone
    changes = lifecycle.check_fade(conn, cfg.lifecycle)
    assert entries.get(conn, "m_0020").state == "tombstone"


def test_revive_flow(conn):
    m = Meme(id="m_0030", name="考古梗", state="tombstone", card=Card(gist="复活测试"))
    entries.save(conn, m)
    m2 = lifecycle.revive(conn, entries.get(conn, "m_0030"), "edit", "野外重现")
    assert m2.state == "active" and m2.revived_pending
    from meme.render.cards import card as render_card

    text, d = render_card(entries.get(conn, "m_0030"))  # 第一次 show → 最小卡
    assert d["minimal"] is True
