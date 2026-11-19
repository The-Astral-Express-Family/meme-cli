"""add 归纳流（假 LLM）：triage、解析、修复、backtest 修订、降级、预算排队。"""

import json

import pytest

from meme.errors import MemeError
from meme.induct.inductor import extract_json, run_add
from meme.models import Card, Constraints, PatternSpec  # noqa: F401


GOOD_OUTPUT = json.dumps({
    "name": "典",
    "aliases": ["典中典", "太典了"],
    "class": "word",
    "birth_circa": "2021",
    "card": {"gist": "单字反讽\"经典\"，嘲讽对方发言陈旧套路化",
             "usage": ["这波啊，这波是典", "典中典"],
             "taboo": "对方真诚分享时用会显得刻薄", "register": "泛B站", "aggression": "中"},
    "examples": ["这就是典中典吧", "典，太典了"],
    "matcher": {"patterns": [{"kind": "lex", "terms": ["典", "典中典", "太典了"]}],
                "constraints": {"standalone": False, "forbid_inner": True,
                                "forbid_context": ["古典", "经典"], "require_context": []}},
    "lineage_parent": None, "lineage_mutation": None, "notes": None,
}, ensure_ascii=False)


def test_extract_json_fenced_and_bare():
    assert extract_json(f"前置说明\n```json\n{GOOD_OUTPUT}\n```\n后记")["name"] == "典"
    assert extract_json(GOOD_OUTPUT)["name"] == "典"


def test_add_bare_text_happy_path(conn, cfg):
    from conftest import FakeLLM, seed_comments

    seed_comments(conn, [f"完全无关的普通评论{i}" for i in range(300)])  # 负例语料
    llm = FakeLLM(["```json\n" + GOOD_OUTPUT + "\n```"])
    res = run_add(conn, cfg, text="典中典了属于是", ctx="游戏区热评", _llm=llm)
    assert res.meme.id.startswith("m_")
    assert res.meme.state == "observing"
    assert res.meme.matcher is not None
    assert res.backtest is not None
    # backtest 负例来自原始湖；词梗 standalone 约束应避免误报
    assert res.backtest.passed or res.backtest.fp_rate <= 0.02
    # 审计已记录
    from meme import audit

    logs = audit.for_meme(conn, res.meme.id)
    assert any(a["action"] == "induct" for a in logs)


def test_add_repair_round_on_bad_json(conn, cfg):
    from conftest import FakeLLM

    bad = "这不是JSON"
    llm = FakeLLM([bad, "```json\n" + GOOD_OUTPUT + "\n```"])
    res = run_add(conn, cfg, text="典", _llm=llm)
    assert res.meme.name == "典"
    assert len(llm.calls) == 2  # 修复轮发生了


def test_add_degrades_to_vector_only_on_bad_backtest(conn, cfg):
    from conftest import FakeLLM, seed_comments

    wide = json.dumps({
        "name": "泛词梗", "aliases": [], "class": "word", "birth_circa": None,
        "card": {"gist": "x", "usage": [], "taboo": None, "register": None, "aggression": "低"},
        "examples": ["哈哈出的"],
        "matcher": {"patterns": [{"kind": "lex", "terms": ["的"]}],
                    "constraints": {}},
    }, ensure_ascii=False)
    seed_comments(conn, [f"普通但是的评论{i}" for i in range(300)])
    llm = FakeLLM(["```json\n" + wide + "\n```",
                   "```json\n" + wide + "\n```"])  # 原始 + 修订轮仍然宽
    res = run_add(conn, cfg, text="的", _llm=llm)
    assert res.meme.matcher is None  # backtest 未达标 → 纯向量
    assert res.matcher_degraded
    assert any("纯向量" in w for w in res.warnings)


def test_budget_queueing(conn, cfg):
    from conftest import FakeLLM
    from meme.induct import budget

    cfg.induction.daily_call_budget = 1
    budget.spend(conn, 10**9)  # 耗尽预算
    with pytest.raises(MemeError) as ei:
        run_add(conn, cfg, text="典", _llm=FakeLLM([]))
    assert ei.value.code == "MEME_BUDGET_EXCEEDED"
    n = conn.execute("SELECT COUNT(*) FROM induction_queue").fetchone()[0]
    assert n == 1
