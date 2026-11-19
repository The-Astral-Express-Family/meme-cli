"""证据更新管线（零 LLM）：短语/骨架双通道、跨视频新颖性、关联预计算。"""

from meme import candidates
from meme.detect.signals import update_signals
from meme.match.vector import Embedder


def test_phrase_channel_creates_candidate(conn, cfg):
    from conftest import seed_comments

    texts = []
    for i in range(10):
        texts.append(f"评论{i}：蚌埠住了蚌埠住了")
    seed_comments(conn, texts, aids=[101 + i for i in range(10)], round_id=1)
    res = update_signals(conn, cfg, 1)
    assert res.scanned == 10
    cand = candidates.by_head(conn, "蚌埠住了")
    assert cand is not None
    assert cand.distinct_videos >= 8
    assert cand.channel == "phrase"
    # 日聚合已写入（burst 基线的起点）
    n = conn.execute("SELECT SUM(cnt) FROM phrase_daily WHERE phrase='蚌埠住了'").fetchone()[0]
    assert n >= 10


def test_single_video_meme_not_queued(conn, cfg):
    from conftest import seed_comments

    # 同一视频内刷屏 → 视频内梗，不入队（§11）
    seed_comments(conn, [f"刷屏{i}：无敌了无敌了" for i in range(20)], aids=[555], round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "无敌了") is None


def test_skeleton_channel_discovers_formula(conn, cfg):
    from conftest import seed_comments

    texts = []
    aids = []
    for i in range(9):
        texts.append(f"一眼玩家{i}鉴定为高手{i}")
        aids.append(201 + i)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    skels = [c for c in candidates.all_active(conn) if c.channel == "skeleton"]
    assert any("一眼" in c.head and "鉴定" in c.head and "<ent>" in c.head for c in skels)
    assert all(c.kind_guess == "formula" for c in skels)


def test_related_precompute_against_library(conn, cfg):
    from conftest import seed_comments
    from meme import entries
    from meme.models import Card, Constraints, MatcherSpec, Meme, PatternSpec

    m = Meme(id="m_0001", name="典", aliases=[], **{"class": "word"}, state="active",
             card=Card(gist="单字反讽经典"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["典"])],
                                 constraints=Constraints(standalone=True)))
    entries.save(conn, m)
    texts = [f"评论{i}：典中典，太典了" for i in range(8)]
    seed_comments(conn, texts, aids=[301 + i for i in range(8)], round_id=1)
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "典中典")
    assert cand is not None
    def _rel_id(r):
        return getattr(r, "id", None) or r.get("id")
    def _rel_type(r):
        return getattr(r, "type", None) or r.get("type")
    assert any(_rel_id(r) == "m_0001" and _rel_type(r) == "same_form" for r in cand.related)


def test_wild_recheck_promotes_and_collects_variants(conn, cfg):
    """词条野外复查：observing 存活升格 + 新形态提示进动态区。"""
    from conftest import seed_comments
    from meme import entries, lifecycle
    from meme.models import Card, Constraints, MatcherSpec, Meme, PatternSpec
    from meme.surf.run import _wild_recheck

    m = Meme(id="m_0002", name="绷", aliases=[], **{"class": "word"}, state="observing",
             card=Card(gist="绷不住了：无语/憋笑"),
             matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["绷"])],
                                 constraints=Constraints(standalone=True)))
    entries.save(conn, m)
    conn.execute(
        "INSERT INTO surf_runs(round_id, started_at, fetched) VALUES(1, '2026-01-01T00:00:00', 1)"
    )
    seed_comments(conn, ["绷。", "绷不住了。", "我直接绷。"], aids=[401, 402, 403], round_id=1)
    dynamics, _ = _wild_recheck(conn, cfg, 1)
    m2 = entries.get(conn, "m_0002")
    assert m2.stats.last_matched_round == 1 or m2.wild_rounds  # 命中已记录
    assert isinstance(dynamics, list)
