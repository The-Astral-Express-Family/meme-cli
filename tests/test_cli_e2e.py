"""CLI 端到端（click runner）：7 命令、--json 稳定 schema、错误即引导。"""

import json

from click.testing import CliRunner

from meme.cli import cli


def _run(cfg, args, expect_exit=0):
    runner = CliRunner()
    result = runner.invoke(cli, ["--db", str(cfg.db_path), *args])
    text = result.output + (getattr(result, "stderr", "") or "")
    assert result.exit_code == expect_exit, (
        f"exit={result.exit_code} args={args}\nstdout={result.stdout}\n"
        f"stderr={getattr(result, 'stderr', '')}\n"
        f"exception={result.exception}"
    )
    result.all_output = text  # 人类模式错误走 stderr，断言用合并文本
    return result


def _install_word_meme(conn, cfg):
    from meme import entries
    from meme.models import Card, Constraints, MatcherSpec, Meme, PatternSpec

    m = Meme(
        id="m_0001", name="典", aliases=["典中典"], **{"class": "word"},
        state="active", card=Card(gist="单字反讽\"经典\"", usage=["这波是典"],
                                  taboo="真诚场合慎用", register="泛B站", aggression="中"),
        examples=["这就是典中典吧"],
        matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=["典", "典中典"])],
                            constraints=Constraints(standalone=True, forbid_context=["古典", "经典"])),
    )
    entries.save(conn, m)
    return m


def test_help_has_examples():
    runner = CliRunner()
    for cmd in ["surf", "add", "edit", "lookup", "search", "show", "note"]:
        r = runner.invoke(cli, [cmd, "--help"])
        assert r.exit_code == 0
        assert "示例" in r.output, f"{cmd} help 缺示例"


def test_show_levels_and_json(cfg, conn):
    _install_word_meme(conn, cfg)
    r = _run(cfg, ["show", "m_0001"])
    assert "m_0001" in r.output and "反讽" in r.output
    r = _run(cfg, ["show", "典", "--brief"])
    assert "词梗" in r.output
    r = _run(cfg, ["show", "m_0001", "--full"])
    assert "审计" in r.output
    r = _run(cfg, ["--json", "show", "m_0001"])
    doc = json.loads(r.output)
    assert doc["schema_version"] == 1 and doc["command"] == "show"
    assert doc["meme"]["id"] == "m_0001"


def test_not_found_is_guidance_not_noise(cfg, conn):
    _install_word_meme(conn, cfg)
    # show 不存在的 ID 是真错误（exit 1），但报错自带近似词条与下一步建议
    r = _run(cfg, ["show", "不存在的梗"], expect_exit=1)
    assert "meme: MEME_NOT_FOUND" in r.all_output
    assert "建议" in r.all_output or "~" in r.all_output
    r = _run(cfg, ["--json", "show", "不存在的梗"], expect_exit=1)
    doc = json.loads(r.output)
    assert doc["error"]["code"] == "MEME_NOT_FOUND"


def test_lookup_hit_and_miss(cfg, conn):
    _install_word_meme(conn, cfg)
    r = _run(cfg, ["lookup", "这波啊，这波是典"])
    assert "m_0001" in r.output and "lexicon" in r.output
    r = _run(cfg, ["lookup", "普通得不能再普通的一句话"])
    assert "未知" in r.output  # miss 是合法答案，exit 0
    r = _run(cfg, ["--json", "lookup", "普通得不能再普通的一句话"])
    assert json.loads(r.output)["result"] == "miss"


def test_search_hybrid(cfg, conn):
    _install_word_meme(conn, cfg)
    r = _run(cfg, ["search", "单字反讽经典"])
    assert "m_0001" in r.all_output
    r = _run(cfg, ["search", "完全无关的查询词xyzq"])
    assert "无结果" in r.all_output  # 空结果是合法答案


def test_add_no_credential_is_typed_error(cfg, conn, monkeypatch):
    """add 无凭证 → 响亮类型化报错（read path 不受影响）；--ctx 参数不与 click ctx 撞名。"""
    import os

    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    r = _run(cfg, ["add", "某梗", "--ctx", "游戏区热评"], expect_exit=1)
    assert "MEME_LLM_NO_CREDENTIAL" in r.all_output
    r = _run(cfg, ["--json", "add", "某梗", "--ctx", "出处"], expect_exit=1)
    doc = json.loads(r.output)
    assert doc["error"]["code"] == "MEME_LLM_NO_CREDENTIAL"
    assert os.environ.get("DEEPSEEK_API_KEY") is None


def test_note_crud(cfg, conn):
    _install_word_meme(conn, cfg)
    _run(cfg, ["note", "add", "m_0001", "观察：疑似新变体“孝典”"])
    r = _run(cfg, ["note", "list", "m_0001"])
    assert "疑似新变体" in r.output
    r = _run(cfg, ["note", "list"])
    assert "m_0001" in r.output
    _run(cfg, ["note", "edit", "1", "更新后的笔记"])
    r = _run(cfg, ["note", "show", "1"])
    assert "更新后的笔记" in r.output
    _run(cfg, ["note", "rm", "1"])
    r = _run(cfg, ["note", "list"])
    assert "更新后的笔记" not in r.output


def test_edit_variant_and_gist(cfg, conn):
    m = _install_word_meme(conn, cfg)
    _run(cfg, ["edit", "m_0001", "--variant", "孝典", "--gist", "单字反讽：经典（升级版）"])
    r = _run(cfg, ["show", "m_0001"])
    assert "孝典" in r.output
    assert "升级版" in r.output


def test_surf_no_fetch_still_presents(cfg, conn):
    """surf --no-fetch：不触网也能照常呈现（§6.6 降级形态）。"""
    r = _run(cfg, ["surf", "--no-fetch"])
    assert "新候选" in r.output
    assert "降级" in r.output or "存量模式" in r.output
    r = _run(cfg, ["--json", "surf", "--no-fetch"])
    doc = json.loads(r.output)
    assert doc["command"] == "surf" and "counts" in doc
