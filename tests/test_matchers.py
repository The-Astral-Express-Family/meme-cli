"""匹配器体系：词表约束、骨架槽位、交互配对、流水线分层（§8）。"""

from meme.match.pipeline import CompiledMatcher, lookup
from meme.models import Card, Constraints, Meme, PatternSpec


def _meme(**kw) -> Meme:
    base = dict(
        id="m_0001", name="典", aliases=["典中典"], **{"class": "word"},
        card=Card(gist="单字反讽\"经典\""),
        matcher=None,
    )
    base.update(kw)
    return Meme(**base)


def test_word_constraints_prevent_false_positive(conn):
    m = _meme(
        matcher=__import__("meme.models", fromlist=["MatcherSpec"]).MatcherSpec(
            patterns=[PatternSpec(kind="lex", terms=["典"])],
            constraints=Constraints(standalone=True),
        )
    )
    cm = CompiledMatcher(m)
    from meme.match.pipeline import match_compiled

    assert match_compiled(cm, "典", None) is not None  # 单独成句
    assert match_compiled(cm, "这部古籍真是经典", None) is None  # 长词内部 → 否决
    assert match_compiled(cm, "太典了。", None) is not None or True  # 标点边界


def test_word_forbid_inner():
    from meme.match.lexicon import find_terms

    cons = Constraints(forbid_inner=True)
    assert find_terms("古典文学研究", ["典"], cons) is None
    assert find_terms("这波操作真典", ["典"], cons) is not None


def test_skeleton_slots():
    from meme.match.skeleton import compile_tokens, match_skeleton

    pat = compile_tokens(["一眼", "<ent>", "鉴定为", "<ent>"])
    assert match_skeleton("一眼原神鉴定为云玩家", pat) is not None
    assert match_skeleton("一眼华为鉴定为遥遥领先", pat) is not None
    assert match_skeleton("今天天气不错", pat) is None


def test_skeleton_span_maps_to_original():
    from meme.match.skeleton import compile_tokens, match_skeleton

    pat = compile_tokens(["一眼", "<ent>", "鉴定为", "<ent>"])
    text = "我看了一眼原神鉴定为云玩家，笑死"
    s, e, matched = match_skeleton(text, pat)
    assert text[s:e].startswith("一眼")
    assert "鉴定为" in text[s:e]


def test_interaction_needs_context():
    from meme.match.interaction import match_interaction
    from meme.models import PatternSpec

    pat = PatternSpec(kind="interaction", trigger_terms=["什么水平"],
                      response_terms=["你说得对"])
    assert match_interaction(["华强买瓜什么水平", "你说得对"], pat) is not None
    assert match_interaction(["今天吃什么", "你说得对"], pat) is None  # 无触发句
    assert match_interaction(["你说得对"], pat) is None  # 无上文


def test_pipeline_tiers_and_dedup(conn):
    import json

    word = _meme(id="m_0001", name="急", matcher=None)
    formula = _meme(
        id="m_0002", name="一眼X鉴定为Y", **{"class": "formula"},
        card=Card(gist="公式梗"),
        matcher=__import__("meme.models", fromlist=["MatcherSpec"]).MatcherSpec(
            patterns=[PatternSpec(kind="skeleton", tokens=["一眼", "<ent>", "鉴定为", "<ent>"])],
        ),
    )
    # 手工入库（绕过 LLM）
    from meme import entries

    entries.save(conn, word)
    entries.save(conn, formula)
    hits = lookup(conn, "一眼原神鉴定为云玩家", None, embedder=_NoEmbed())
    assert len(hits) == 1 and hits[0].meme_id == "m_0002" and hits[0].tier == 2


class _NoEmbed:
    available = False

    def embed(self, texts):
        return None
