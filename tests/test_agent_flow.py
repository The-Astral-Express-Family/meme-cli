"""操作员流程回归（agent 冷启动实战反馈）：

内置黑名单与 --allow 豁免、骨架变体预算、图片字段（content.pictures）、
--json 全量输出、批量 --reject、add --entry 操作员亲写词条路径。
"""

import json

import pytest

from conftest import seed_comments
from meme import audit, candidates, entries
from meme.detect.signals import GENERIC, _generic_set, update_signals
from meme.detect.skel import skeleton_variants
from meme.errors import MemeError
from meme.fetch.sampler import _reply_images
from meme.models import UsageSample


# ---------- 黑名单与豁免 ----------

def test_builtin_blacklist_content():
    """v2 黑名单哲学：只收零梗义语法虚词；泛用实词（会/说/看/想）不入列——
    它们的治理交给 evidence 统计判别（复读/坍缩/独立成评），不再打地鼠。"""
    for w in ("的", "了", "没有", "是什么", "的时候", "一个", "什么"):
        assert w in GENERIC, f"{w} 应在核心语法表"
    for w in ("绷", "典", "麻", "蚌", "孝", "急", "寄", "润", "燃", "乐", "拉", "艹", "6",
              "会", "说", "看", "想", "决赛", "版本"):
        assert w not in GENERIC, f"{w} 不该被手工拉黑（统计判别负责）"
    assert "我记下了" not in GENERIC  # 多字句式梗头不受影响


def test_blacklist_blocks_noise_keeps_memes(conn, cfg):
    """实战形态回归：单字梗与多字句式梗照常创建；泛用实词入榜但证据分沉底。"""
    from meme.detect.evidence import meme_features

    texts, aids = [], []
    for i in range(200):  # filler 撑起 df 分母
        texts.append(f"普通观众留言第{i}号没有任何梗")
        aids.append(1000 + i % 4)
    for i in range(9):
        texts.append(f"绷不住了第{i}次")  # 单字梗"绷"：句中+独立混合
        aids.append(2000 + i % 3)
    texts.append("绷")  # 独立成评
    aids.append(2000)
    for i in range(5):
        texts.append("我记下了。")  # 功能词头多字句式梗（4 token gram）
        aids.append(3000 + i % 2)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    assert candidates.by_head(conn, "绷") is not None, "单字梗绷被误杀"
    assert candidates.by_head(conn, "我记下了") is not None, "句式梗被误杀"


def test_generic_allow_rescue(conn, cfg):
    """--allow 豁免表：核心语法表/沉淀停用词误杀真梗时的可逆逃生口。"""
    from meme.db import kv_set

    g = _generic_set(conn, cfg)
    assert "没有" in g
    kv_set(conn, "generic_allow", '["没有", "绷"]')
    g2 = _generic_set(conn, cfg)
    assert "没有" not in g2 and "绷" not in g2


# ---------- 骨架通道：不同文本复现门 ----------

def test_skeleton_variants_shape_unchanged():
    """发射层保持全变体（坍缩路径不受预算裁剪）：全骨架在前、含双槽与单槽。"""
    cp = "还是shy哥操作干净，奈何队友不争气[笑哭]"
    vs = skeleton_variants(cp)
    assert vs[0] == skeleton_variants(cp)[0]  # 确定性
    assert any(v.count("<ent>") >= 2 for v in vs[1:])  # 双槽坍缩路径在


def test_skeleton_family_no_explosion(conn, cfg):
    """复制粘贴热评家族（同文本跨视频）：候选资格门 = ≥2 种不同文本，
    家族变体全部不建候选（修复前 ~48 条近重复候选霸占整榜）。"""
    cp = "还是shy哥操作干净，奈何队友不争气[笑哭]"
    texts = [cp, cp]  # 同文本复制粘贴
    aids = [4001, 4002]
    for i in range(200):
        texts.append(f"普通评论第{i}号")
        aids.append(4003 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    rows = conn.execute(
        "SELECT head FROM candidates WHERE channel='skeleton' AND head LIKE '%奈何%'"
    ).fetchall()
    assert rows == [], f"复制粘贴家族仍产出骨架候选：{[r['head'] for r in rows]}"


def test_skeleton_cross_text_formula_fires(conn, cfg):
    """真公式梗：同一坍缩形状出现在不同措辞的多条评论 → 候选照常建立。"""
    texts = [
        "一眼原神鉴定为云玩家",
        "一眼华为鉴定为遥遥领先",
    ]
    aids = [5001, 5002]
    for i in range(200):
        texts.append(f"普通评论第{i}号")
        aids.append(5004 + i % 4)
    seed_comments(conn, texts, aids=aids, round_id=1)
    update_signals(conn, cfg, 1)
    rows = conn.execute(
        "SELECT head FROM candidates WHERE channel='skeleton' AND head LIKE '%鉴定%'"
    ).fetchall()
    assert rows, "跨文本公式坍缩形状未被建立候选"


# ---------- 图片字段 ----------

def test_reply_images_pictures_and_fallback():
    """实探校准：真实字段是 content.pictures（img_src）；content.image 仅兜底。"""
    r1 = {"content": {"pictures": [{"img_src": "http://x/a.png", "img_width": 10, "img_height": 20}]}}
    assert _reply_images(r1) == [("http://x/a.png", 10, 20)]
    r2 = {"content": {"image": [{"image_url": "http://x/b.jpg"}]}}
    assert _reply_images(r2) == [("http://x/b.jpg", 0, 0)]
    assert _reply_images({"content": {}}) == []
    assert _reply_images({}) == []
    assert _reply_images({"content": {"pictures": ["垃圾元素", {"img_src": "http://x/c.webp"}]}}) == [
        ("http://x/c.webp", 0, 0)
    ]


# ---------- --json 全量 / 批量治理 ----------

def _seed_n_candidates(conn, n: int) -> None:
    for i in range(n):
        candidates.upsert_from_signal(
            conn, head=f"独特测试词{i:02d}", channel="phrase", kind_guess="word",
            usages=[], video_pairs=[(9000 + i, 0)], day="2026-11-09", round_id=1,
        )


def test_json_full_dump(conn, cfg):
    """--json 全量：机器输出一次给全（agent 工效）；人类分页路径不受影响。"""
    from meme.surf.run import run_surf

    _seed_n_candidates(conn, 15)
    zones = run_surf(conn, cfg, no_fetch=True, full=True, round_size=10)["payload"]
    assert len(zones["new_candidates_raw"]) == 15
    assert zones["has_more"] is False
    conn.execute("UPDATE kv_meta SET value='0' WHERE key='surf_page'")
    conn.commit()
    zones2 = run_surf(conn, cfg, no_fetch=True, more=True, round_size=10)["payload"]
    assert len(zones2["new_candidates_raw"]) == 5  # 第 2 页 = 剩余 5 条，分页照旧
    assert zones2["has_more"] is False


def test_cli_batch_reject_ban(tmp_path):
    """--reject 支持逗号分隔批量；--ban 沉淀每个词头。"""
    from click.testing import CliRunner

    from meme.cli import cli
    from meme.db import connect

    db = tmp_path / "t.db"
    conn = connect(db)
    _seed_n_candidates(conn, 3)
    heads = {candidates.get(conn, f"c_{i:04d}").head for i in (1, 2)}
    conn.close()
    runner = CliRunner()
    res = runner.invoke(cli, ["--db", str(db), "surf", "--reject", "c_0001,c_0002", "--ban"])
    assert res.exit_code == 0, res.output
    conn2 = connect(db)
    assert candidates.get(conn2, "c_0001").state == "rejected"
    assert candidates.get(conn2, "c_0002").state == "rejected"
    assert candidates.get(conn2, "c_0003").state == "pending"
    kv = json.loads(conn2.execute(
        "SELECT value FROM kv_meta WHERE key='generic_auto'").fetchone()[0])
    assert heads == set(kv)
    conn2.close()


# ---------- add --entry：操作员亲写词条 ----------

def _entry(name="青铜巨像"):
    return {
        "name": name,
        "aliases": ["青铜像"],
        "class": "word",
        "birth_circa": "2026",
        "card": {"gist": "测试用词梗", "usage": ["青铜巨像，名场面"], "taboo": None,
                 "register": None, "aggression": "低"},
        "examples": ["青铜巨像，第1个名场面", "真青铜巨像"],
        "matcher": {"patterns": [{"kind": "lex", "terms": [name, "青铜像"]}],
                    "constraints": {}},
        "notes": "操作员测试词条",
    }


def _seed_candidate_with_evidence(conn) -> str:
    usages = [UsageSample(text=f"青铜巨像名场面第{i}弹", aid=7000 + i % 2, rpid=8000 + i)
              for i in range(6)]
    candidates.upsert_from_signal(
        conn, head="青铜巨像", channel="phrase", kind_guess="word",
        usages=usages, video_pairs=[(7000, 0), (7001, 0)], day="2026-11-09", round_id=1,
    )
    return candidates.by_head(conn, "青铜巨像").cid


def test_add_entry_operator_path(conn, cfg):
    """--entry：零外部 LLM，闸门全保留；审计 model=operator；候选收口 inducted。"""
    from meme.induct.inductor import run_add_entry

    cid = _seed_candidate_with_evidence(conn)
    res = run_add_entry(conn, cfg, _entry(), cid=cid)
    assert res.model == "operator"
    assert res.meme.matcher is not None
    assert res.backtest is not None and res.backtest.passed
    assert entries.get(conn, res.meme.id) is not None
    assert candidates.get(conn, cid).state == "inducted"
    audits = audit.for_meme(conn, res.meme.id)
    assert audits and audits[0]["payload"]["model"] == "operator"


def test_add_entry_backtest_gate_blocks(conn, cfg):
    """backtest 未达标：不静默降级，报 MEME_BACKTEST_FAIL 附样例；词条不入库。"""
    from meme.induct.inductor import run_add_entry

    cid = _seed_candidate_with_evidence(conn)
    bad = _entry("绝不存在词")
    bad["matcher"] = {"patterns": [{"kind": "lex", "terms": ["绝不存在的词"]}], "constraints": {}}
    with pytest.raises(MemeError) as ei:
        run_add_entry(conn, cfg, bad, cid=cid)
    assert ei.value.code == "MEME_BACKTEST_FAIL"
    assert entries.get(conn, "m_0001") is None  # 未入库
    assert candidates.get(conn, cid).state != "inducted"


def test_add_entry_force_vector_only(conn, cfg):
    """--force：闸门不过仍入库（纯向量降级），进审计与警告。"""
    from meme.induct.inductor import run_add_entry

    cid = _seed_candidate_with_evidence(conn)
    bad = _entry("绝不存在词二")
    bad["matcher"] = {"patterns": [{"kind": "lex", "terms": ["绝不存在的词二"]}], "constraints": {}}
    res = run_add_entry(conn, cfg, bad, cid=cid, force=True)
    assert res.meme.matcher is None
    assert res.warnings
    audits = audit.for_meme(conn, res.meme.id)
    assert audits[0]["payload"]["forced_vector_only"] is True


def test_add_entry_invalid_json(conn, cfg):
    """schema 不合法 → MEME_ENTRY_INVALID（稳定错误码）。"""
    from meme.induct.inductor import run_add_entry

    with pytest.raises(MemeError) as ei:
        run_add_entry(conn, cfg, {"name": "只有名字"}, text="随便")
    assert ei.value.code == "MEME_ENTRY_INVALID"


def test_cli_add_entry_end_to_end(tmp_path):
    """CLI 接线：meme add <cid> --entry file.json 全链路。"""
    from click.testing import CliRunner

    from meme.cli import cli
    from meme.db import connect

    db = tmp_path / "t.db"
    conn = connect(db)
    cid = _seed_candidate_with_evidence(conn)
    conn.close()
    entry_file = tmp_path / "entry.json"
    entry_file.write_text(json.dumps(_entry(), ensure_ascii=False), encoding="utf-8")
    runner = CliRunner()
    res = runner.invoke(cli, ["--db", str(db), "add", cid, "--entry", str(entry_file)])
    assert res.exit_code == 0, res.output
    conn2 = connect(db)
    m = entries.get(conn2, "m_0001")
    assert m is not None and m.name == "青铜巨像"
    assert candidates.get(conn2, cid).state == "inducted"
    conn2.close()
