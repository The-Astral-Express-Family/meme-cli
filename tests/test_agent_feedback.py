"""subagent 实战反馈修复的回归：forbid_context 语义、向量回声抑制、
客套成分检测、批量 reject 幂等、ID 不烧、对话式例句拆 ctx。"""

from conftest import seed_comments
from meme import candidates
from meme.detect.signals import update_signals
from meme.errors import MemeError
from meme.models import Card, Constraints, MatcherSpec, Meme, PatternSpec


def _meme(mid, name, terms, cons=None, gist="测试梗"):
    return Meme(
        id=mid, name=name, state="active", card=Card(gist=gist),
        matcher=MatcherSpec(patterns=[PatternSpec(kind="lex", terms=terms)],
                            constraints=cons or Constraints()))


# ---------- forbid_context 语义（subagent 8 发黑盒探测校准） ----------

def test_forbid_context_overlapping_span():
    """forbid 词与命中词重叠时，检查去掉重叠后的剩余部分（"回答我吗"→查"吗"）。"""
    from meme.match.lexicon import find_terms

    cons = Constraints(forbid_context=["回答我吗", "回答我吧", "回答我一下"])
    assert find_terms("为什么不回答我吗？", ["回答我"], cons) is None, "疑问用法应被否决"
    assert find_terms("回答我！look in my eyes", ["回答我"], cons) is not None, "祈使咆哮应命中"
    assert find_terms("老师回答我一下吧", ["回答我"], cons) is None
    assert find_terms("回答我，为什么改设定", ["回答我"], cons) is not None


def test_forbid_context_plain_window():
    """不重叠的 forbid 词照旧用两侧窗口（"古典"否决"典"）。"""
    from meme.match.lexicon import find_terms

    cons = Constraints(forbid_context=["古典"])
    assert find_terms("这个太典了", ["典"], cons) is not None
    assert find_terms("古典文学", ["典"], cons) is None


# ---------- 向量层回声抑制 ----------

def test_vector_echo_suppressed_when_vetoed(conn, cfg):
    """词典层含词但约束否决 → 向量层不得再为该词条报低置信回声。"""
    from meme import entries
    from meme.match.pipeline import lookup as do_lookup

    cons = Constraints(forbid_context=["为什么"])
    m = _meme("m_0001", "回答我", ["回答我"], cons)
    entries.save(conn, m, vectors=[])  # 不给例句向量，避免真实向量层干扰
    hits = do_lookup(conn, "为什么不回答我", None, embedder=_NoEmbed())
    assert hits == [], "约束否决的词条不得有向量回声"


class _NoEmbed:
    available = False

    def embed(self, texts):
        return None


# ---------- 客套成分检测 ----------

def test_etiquette_phrases_not_admitted(conn, cfg):
    """纯客套组合（支持up主/视频做得真不错）复读再跨视频也不入榜。"""
    texts, aids = [], []
    for i in range(6):
        texts.append(f"视频做得真不错，支持up主")
        aids.append(1001 + i)
    texts += ["支持up主"] * 2
    aids += [1007, 1008]
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "支持up主") is None, "客套复读入榜了"
    assert candidates.by_head(conn, "视频做得真不错") is None


def test_etiquette_not_overreach(conn, cfg):
    """含任意真内容词的短语不受客套检测影响（"支持up主挖坟考古"照常）。"""
    texts, aids = [], []
    for i in range(6):
        texts.append(f"第{i}条：支持up主挖到坟了，前来考古")
        aids.append(1101 + i)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "前来考古") is not None


# ---------- 批量 reject 幂等 ----------

def test_reject_idempotent(conn, cfg):
    """已出队候选的重复 reject 不报错（幂等）；不存在才报错。"""
    texts = ["我记下了"] * 3
    seed_comments(conn, texts, aids=[1201, 1202, 1203], round_id=1)
    update_signals(conn, cfg, 1)
    cand = next(iter(candidates.all_active(conn)))
    assert candidates.reject(conn, cand.cid) is True
    assert candidates.reject(conn, cand.cid) is False  # 幂等
    try:
        candidates.reject(conn, "c_9999")
        raise AssertionError("不存在的 cid 应报错")
    except KeyError:
        pass


# ---------- add 失败不烧 ID ----------

def test_failed_add_does_not_burn_id(conn, cfg):
    from meme.induct.inductor import run_add_entry

    bad = {
        "name": "测试梗",
        "aliases": [],
        "class": "word",
        "card": {"gist": "x"},
        "examples": ["测试梗例句"],
        # matcher 用纯槽位骨架 → 编译失败 → 严格路径报错
        "matcher": {"patterns": [{"kind": "skeleton", "tokens": ["<ent>", "<num>"]}],
                    "constraints": {}},
    }
    try:
        run_add_entry(conn, cfg, bad, text="测试梗")
        raise AssertionError("编译失败应报错")
    except MemeError:
        pass
    # 紧接着成功入库的词条应拿到 m_0001（没有烧掉的空洞）
    good = {
        "name": "好梗", "aliases": [], "class": "word",
        "card": {"gist": "好"},
        "examples": ["好梗"],
        "matcher": None,
    }
    res = run_add_entry(conn, cfg, good, text="好梗")
    assert res.meme.id == "m_0001", f"ID 被烧：{res.meme.id}"


# ---------- 对话式例句自动拆 ctx ----------

def test_dialogue_examples_split_ctx():
    """含"上句：X 本句：Y"的留出文本在 backtest 中自动拆出会话上下文。"""
    from meme.induct.backtest import _split_dialogue

    texts = ["上句：华强买瓜什么水平\n本句：你说得对", "普通文本"]
    out_texts, out_ctxs = _split_dialogue(texts, None)
    assert out_texts[0] == "你说得对"
    assert out_ctxs[0] == ["华强买瓜什么水平", "你说得对"]
    assert out_texts[1] == "普通文本" and out_ctxs[1] is None
