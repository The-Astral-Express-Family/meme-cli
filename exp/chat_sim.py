"""群聊场景模拟：量化 read path 在"理解梗"与"接话找梗"两个方向的效果。

理解向 = lookup（别人发了含梗的话，agent 要识别）
接话向 = search（情境描述，agent 要想起恰当的梗）——检索方向与 lookup 相反，
         是"根据别人的话想到一个梗"的路径（hybrid_search：BM25+向量 RRF）。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from meme.config import load_config  # noqa: E402
from meme.db import connect  # noqa: E402
from meme.match.pipeline import lookup  # noqa: E402
from meme.match.vector import Embedder  # noqa: E402
from meme.retrieve.fuse import hybrid_search  # noqa: E402

# (话语, 期望命中的词条名, 方向)   direction: understand=lookup / recall=search
CASES = [
    # ---- 理解向：字面与真实变体 ----
    ("这波啊，这波是赢麻了", ["赢麻了"], "understand"),
    ("真的难绷，他真敢说", ["难绷"], "understand"),
    ("绷不住了兄弟们", ["难绷"], "understand"),  # 别名改写
    ("警钟长鸣", ["警钟长鸣"], "understand"),
    ("急了急了，破防了属于是", ["急了急了"], "understand"),
    ("回答我！look in my eyes! tell me why!", ["回答我"], "understand"),
    ("显卡又降价了，等等党狂喜", ["等等党"], "understand"),
    ("评论区全是大肥鱼", ["大肥鱼"], "understand"),
    ("2026年11月前来考古", ["前来考古"], "understand"),
    ("我才是最晚的人", ["最晚之人"], "understand"),  # 变体改写（词条名"最晚之人"）
    # ---- 理解向：含梗词的非梗用法（应 miss/低置信，负例） ----
    ("为什么不回答我？", [], "understand"),
    ("今天中午吃什么", [], "understand"),
    # ---- 接话向：情境 → 想起梗（search） ----
    ("股价又跌了，我心态崩了", ["赢麻了", "难绷"], "recall"),
    ("这视频也太离谱了", ["难绷"], "recall"),
    ("他又在群里炫耀战绩了", ["赢麻了"], "recall"),
    ("去老视频底下盖楼打卡", ["前来考古", "最晚之人"], "recall"),
    ("你倒是给我个解释啊", ["回答我"], "recall"),
    ("看完这新闻我人麻了", ["赢麻了"], "recall"),
    ("都别吵了，楼里盖成这样了", ["你说得对"], "recall"),
]


def main() -> None:
    cfg = load_config()
    conn = connect(cfg.db_path)
    emb = Embedder.get(cfg.retrieval.embed_model)

    n_vec = conn.execute("SELECT COUNT(*) FROM meme_vectors").fetchone()[0]
    n_memes = conn.execute("SELECT COUNT(*) FROM memes").fetchone()[0]
    t0 = time.perf_counter()
    emb.embed(["预热"])
    warm = (time.perf_counter() - t0) * 1000

    print(f"库内词条 {n_memes}，向量锚点 {n_vec} 条，embed 预热 {warm:.0f}ms\n")

    lu_ok = lu_miss_expected = 0
    rc_ok = rc_fail = 0
    lat = []
    for text, expected, mode in CASES:
        t0 = time.perf_counter()
        if mode == "understand":
            hits = lookup(conn, text, None,
                          vector_threshold=cfg.retrieval.vector_threshold, embedder=emb)
            ms = (time.perf_counter() - t0) * 1000
            lat.append(ms)
            got = [h.name for h in hits[:3]]
            if expected:
                hit_ok = any(e in got for e in expected)
                lu_ok += hit_ok
                flag = "✓" if hit_ok else "✗漏"
                if not hits:
                    got = ["(miss)"]
            else:
                hit_ok = not hits or all(h.tier == 4 for h in hits)
                lu_miss_expected += hit_ok
                flag = "✓正确miss" if hit_ok else "✗误报"
            print(f"{flag} lookup {ms:6.1f}ms  「{text[:22]}」→ {got}")
        else:
            rs = hybrid_search(conn, text, cfg, top=3, embedder=emb)
            ms = (time.perf_counter() - t0) * 1000
            lat.append(ms)
            got = [r["meme"].name for r in rs[:3]]
            hit_ok = any(e in got for e in expected)
            rc_ok += hit_ok
            rc_fail += not hit_ok
            print(f"{'✓' if hit_ok else '✗'} recall {ms:6.1f}ms  「{text[:22]}」→ {got or ['(empty)']}")

    n_u = sum(1 for _, _, m in CASES if m == "understand")
    n_u_pos = sum(1 for t, e, m in CASES if m == "understand" and e)
    n_u_neg = n_u - n_u_pos
    n_r = sum(1 for _, _, m in CASES if m == "recall")
    print(f"\n理解向：命中 {lu_ok}/{n_u_pos}，负例正确miss {lu_miss_expected}/{n_u_neg}")
    print(f"接话向：recall@3 命中 {rc_ok}/{n_r}")
    lat_u = [l for l, (t, e, m) in zip(lat, CASES) if m == "understand"]
    print(f"延迟：平均 {sum(lat)/len(lat):.0f}ms  最大 {max(lat):.0f}ms（含首次）")
    conn.close()


if __name__ == "__main__":
    main()
