"""独立评审第二批回归：FTS 分词、骨架通配校验、RelatedRef、融合权重、交互层上下文。"""

from meme import candidates, entries, notes
from meme.induct.backtest import run_backtest
from meme.induct.compile_matcher import validate_and_compile
from meme.models import Card, MatcherSpec, Meme, PatternSpec


def test_fts_doc_segmented(conn):
    """回归：FTS 文档未分词（seg 死代码）→ unicode61 整句成单 token，查询必 miss。"""
    from meme.retrieve.fts import search_fts

    m = Meme(id="m_0100", name="华强买瓜", card=Card(gist="你这瓜保熟吗"))
    entries.save(conn, m)
    hits = search_fts(conn, "华强", top=5)
    assert any(mid == "m_0100" for mid, _ in hits)


def test_v2_migration_reindexes_unsegmented_docs(tmp_path):
    """回归：v1 存量库（未分词 FTS 文档）升 v2 时自动重建索引。"""
    import json as _json
    import sqlite3

    from meme.db import APP_ID, connect
    from meme.retrieve.fts import search_fts

    db = tmp_path / "old.db"
    raw = sqlite3.connect(str(db))
    raw.executescript(
        "CREATE TABLE memes(id TEXT PRIMARY KEY, name TEXT, aliases TEXT, class TEXT,"
        "lineage TEXT, platform TEXT, state TEXT, birth TEXT, matcher TEXT, card TEXT,"
        "examples TEXT, drift TEXT, stats TEXT, wild_rounds TEXT, revived_pending INTEGER,"
        "created_at TEXT, updated_at TEXT);"
        "CREATE VIRTUAL TABLE memes_fts USING fts5(meme_id UNINDEXED, name, aliases, gist,"
        "examples, tokenize='unicode61');"
        "INSERT INTO memes VALUES('m_0001','华强买瓜','[]','word','{}','[\"bilibili\"]',"
        "'observing','{}',NULL,'" + _json.dumps({"gist": "你这瓜保熟吗"}) + "','[]','[]','{}','[]',0,'x','x');"
        "INSERT INTO memes_fts VALUES('m_0001','华强买瓜','','你这瓜保熟吗','');"  # v1 未分词原文
        f"PRAGMA application_id={APP_ID};"
        "PRAGMA user_version=1;"
    )
    raw.commit()
    raw.close()
    conn = connect(db)  # 打开即触发 v1→v2 迁移
    hits = search_fts(conn, "华强", top=5)
    assert any(mid == "m_0001" for mid, _ in hits)
    conn.close()


def test_skeleton_wildcard_rejected():
    """回归：纯槽位/空 token 模式曾通过校验，编译出匹配一切的正则（0.90 置信误报）。"""
    import pytest

    with pytest.raises(ValueError):
        validate_and_compile(MatcherSpec(patterns=[PatternSpec(kind="skeleton", tokens=["<any>"])]))
    with pytest.raises(ValueError):
        validate_and_compile(MatcherSpec(patterns=[PatternSpec(kind="skeleton", tokens=["<ent>", "<ent>"])]))
    with pytest.raises(ValueError):
        validate_and_compile(MatcherSpec(patterns=[PatternSpec(kind="skeleton", tokens=[""])]))
    with pytest.raises(ValueError):
        validate_and_compile(MatcherSpec(patterns=[PatternSpec(
            kind="interaction", trigger_tokens=[""], response_terms=["对"])]))
    # 合法模式不受影响
    spec = validate_and_compile(MatcherSpec(patterns=[PatternSpec(kind="skeleton", tokens=["一眼", "<ent>"])]))
    assert spec.patterns[0].tokens == ["一眼", "<ent>"]


def test_candidate_related_render_no_crash(conn):
    """回归：related 从库重载后是 RelatedRef 对象，呈现层 dict 下标访问曾 TypeError。"""
    from meme.surf.present import cand_dict, cand_line

    entries.save(conn, Meme(id="m_0101", name="典", card=Card(gist="x")))
    conn.execute(
        "INSERT INTO candidates(cid,head,kind_guess,channel,state,first_seen,last_seen,"
        "evidence_usages,related,created_at,updated_at) "
        "VALUES('c_0500','典中典','word','phrase','pending','2026-01-01','2026-01-01','[]',"
        "'[{\"id\":\"m_0101\",\"type\":\"same_form\",\"score\":0.9}]','2026-01-01','2026-01-01')"
    )
    cand = candidates.get(conn, "c_0500")
    assert cand_line(cand, {"m_0101": "典"})  # 修复前：TypeError: not subscriptable
    d = cand_dict(cand)
    assert d["related"][0]["id"] == "m_0101"


def test_fading_weight_reorders_search(conn, cfg):
    """回归：fading 减半权重曾在排序后施加，不改名次（D7 形同虚设）。"""
    from meme.retrieve.fuse import hybrid_search

    entries.save(conn, Meme(id="m_0110", name="独一无二甲", card=Card(gist="独一无二")))
    # fading 词条给更强的 FTS 信号（gist 双命中），加权后必须被 active 反超
    entries.save(conn, Meme(id="m_0111", name="独一无二乙", state="fading",
                            card=Card(gist="独一无二乙独一无二")))
    res = hybrid_search(conn, "独一无二", cfg, top=5)
    assert res[0]["meme"].id == "m_0110"


def test_notes_dedupe_respects_head(conn):
    """回归：去重键曾忽略 head，不同词头同内容的悬挂笔记被误删。"""
    notes.add(conn, "同内容", head="急孝")
    notes.add(conn, "同内容", head="急了")
    assert notes.dedupe(conn) == 0
    notes.add(conn, "同内容", head="急孝")
    assert notes.dedupe(conn) == 1


def test_interaction_backtest_counts_tier3(conn):
    """回归：backtest 曾恒传 ctx=None 且只认 tier 1/2，交互梗命中率恒 0、必然降级。"""
    meme = Meme(
        id="m_0120", name="对答", card=Card(gist="trigger-response"),
        matcher=MatcherSpec(patterns=[PatternSpec(
            kind="interaction", trigger_terms=["你说啥"], response_terms=["对"])]),
    )
    bt = run_backtest(
        conn, meme, __import__("meme.match.pipeline", fromlist=["CompiledMatcher"]).CompiledMatcher(meme),
        [],
        holdout_texts=["对"],
        holdout_ctx=[["你说啥", "对"]],
        min_hit=0.7, max_fp=0.02, negatives=50,
    )
    assert bt.hits == 1 and bt.hit_rate == 1.0


def test_interaction_lookup_uses_text_as_last_line(conn, cfg):
    """回归：lookup 曾不把待查文本追加进会话行，response 匹配的是最后一条 --ctx。"""
    from click.testing import CliRunner

    from meme.cli import cli

    entries.save(conn, Meme(
        id="m_0121", name="对答", card=Card(gist="trigger-response"),
        matcher=MatcherSpec(patterns=[PatternSpec(
            kind="interaction", trigger_terms=["你说啥"], response_terms=["对"])]),
    ))
    res = CliRunner().invoke(cli, ["--db", str(cfg.db_path), "lookup", "对", "--ctx", "你说啥"])
    assert res.exit_code == 0, res.output
    assert "m_0121" in res.output  # 修复前：response 去匹配 ctx 行，必然 miss
