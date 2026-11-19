"""审计修复回归：白名单式误杀、跨标点 gram、队列丢行、bool 塌缩、单轮候选永不过期。"""

from meme import candidates, entries, lifecycle
from meme.detect.ngram import phrases
from meme.detect.signals import update_signals
from meme.induct import budget as budget_mod
from meme.models import Card, Meme
from meme.surf.run import _process_queue


def test_function_head_memes_survive_ngram():
    """回归：FUNC_WORDS 头/尾词表过滤曾误杀 9/23 真实热梗（含金标准 我记下了）。"""
    for m in ["我记下了", "乐子人", "属于是", "那咋了", "太抽象了",
              "你说得对", "什么水平", "绷不住了", "蚌埠住了"]:
        assert m in phrases(m), f"短语通道误杀：{m}"


def test_no_cross_punct_grams():
    """回归：gram 曾跨越标点拼接（"太酷辣，直接showhand"→"太酷辣直接"）。"""
    ps = phrases("太酷辣，直接showhand")
    assert "太酷辣直接" not in ps
    assert "辣直接" not in ps
    ps2 = phrases("不愧是你，典中典")
    assert "不愧是你典" not in ps2


def test_function_head_zombie_blocked_by_standalone(conn, cfg):
    """功能词头僵尸（低独立成评率）不入队；功能词头句式梗（高独立率）正常入队。

    判别只用词性 + 用法证据，不含任何梗词知识（反白名单纪律）。
    """
    from conftest import seed_comments

    texts, aids = [], []
    for i in range(9):
        texts.append(f"开头这里有人{i}接着聊别的")
        aids.append(701 + i)
    texts += ["我记下了", "我记下了", "我记下了"]
    aids += [801, 802, 803]
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "这里有人") is None  # 功能头 + 零独立成评
    assert candidates.by_head(conn, "我记下了") is not None  # 功能头 + 独立成评自证


def test_onehit_candidate_expires(conn, cfg):
    """回归：单轮候选（surfs_seen=1）曾因 surfs_seen>=2 豁免而永不过期。"""
    from conftest import seed_comments

    seed_comments(conn, ["我记下了"] * 3, aids=[811, 812, 813], round_id=1)
    update_signals(conn, cfg, 1)
    cand = candidates.by_head(conn, "我记下了")
    assert cand is not None
    summary = lifecycle.transition_candidates(conn, cfg.lifecycle, 1 + cfg.lifecycle.candidate_expire_rounds)
    assert cand.cid in summary["expired"]


def test_queue_survives_budget_exhaustion(conn, cfg):
    """回归：预算耗尽时 _process_queue 曾 break 丢弃未处理的排队行。"""
    cfg.induction.daily_call_budget = 0  # 立即触发预算闸门
    budget_mod.enqueue(conn, "c_0001", None)
    budget_mod.enqueue(conn, "c_0002", None)
    budget_mod.enqueue(conn, None, "测试裸文本归纳")
    done = _process_queue(conn, cfg)
    assert done == []
    remaining = conn.execute("SELECT COUNT(*) FROM induction_queue").fetchone()[0]
    assert remaining == 3  # 三行全部还在队里，一行未丢


def test_usage_samples_belong_to_head(conn, cfg):
    """回归（实战抓获）：用例收集循环曾用首循环遗留的 msg 变量，
    所有候选的用例文本都被替换成同一条最新评论。"""
    from conftest import seed_comments

    texts = [
        "我记下了", "我记下了", "我记下了",
        "结尾灵笼第二季真好看", "结尾灵笼第二季真好看", "结尾灵笼第二季真好看",
    ]
    seed_comments(conn, texts, aids=[901, 902, 903, 911, 912, 913], round_id=1)
    update_signals(conn, cfg, 1)
    for head in ("我记下了", "灵笼第二季"):
        cand = candidates.by_head(conn, head)
        assert cand is not None, head
        assert cand.evidence_usages, head
        for u in cand.evidence_usages:
            assert head in u.text, f"{head} 的用例文本错位：{u.text!r}"


def test_revived_pending_int_roundtrip(conn, cfg):
    """回归：revived_pending 曾是 bool，bool(2)=True 使二次确认永远走不到。"""
    m = Meme(id="m_0099", name="测试梗", state="fading", card=Card(gist="测试"))
    entries.save(conn, m)
    m2 = entries.get(conn, "m_0099")
    lifecycle.revive(conn, m2, "test")
    m3 = entries.get(conn, "m_0099")
    assert m3.revived_pending == 1
    m3.revived_pending = 2
    entries.save(conn, m3)
    assert entries.get(conn, "m_0099").revived_pending == 2  # bool 下这里会塌缩成 True
