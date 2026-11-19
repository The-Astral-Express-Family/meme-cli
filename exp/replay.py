"""重放工具：用真实湖数据按轮重放信号管线，量化发现质量。

用法：
  python exp/replay.py            # 重放当前实现
  python exp/replay.py --top 40   # 榜单看 40 条

指标：
  - 每轮入榜候选数 / 触发数
  - 真梗标注集的入榜召回与触发召回
  - 榜首垃圾率（人工目检 top N）
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from meme.config import Config  # noqa: E402
from meme.db import connect  # noqa: E402

# 真梗标注集 v2：经语料验证（≥2 次 ≥2 视频才算可发现；语料中不存在的已剔除）
TRUTH = [
    # 已验证在语料中有跨视频证据
    "绷不住", "赢麻", "开香槟", "香槟", "难绷", "乐子", "赚麻", "一眼",
    "启动", "红温", "蚌埠", "米哈游", "警钟长鸣", "我软脚了", "老铁", "润",
    "抽象", "电子", "赢麻了",
    # 公式族（骨架通道应坍缩出含这些字面的形状）
    "X麻了",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--db", default=r"C:/Users/25943/.meme/memes.db")
    ap.add_argument("--rounds", type=int, default=6,
                    help="只重放前 N 轮（基准固定：真网轮次会污染过期动态，默认 6）")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp()) / "replay.db"
    shutil.copy(args.db, tmp)

    # 清空派生状态：候选/日聚合/序列，只留原始湖
    conn = sqlite3.connect(tmp)
    for t in ("candidates", "cand_video", "phrase_daily", "skel_daily",
              "meme_hit_daily", "induction_queue"):
        conn.execute(f"DELETE FROM {t}")
    conn.execute("DELETE FROM kv_meta WHERE key LIKE 'seq_%'")
    conn.commit()
    conn.close()

    conn = connect(tmp)
    cfg = Config()
    from meme.detect.signals import update_signals
    from meme.lifecycle import transition_candidates
    from meme.surf.present import order_key

    rounds = [r["round_id"] for r in conn.execute(
        "SELECT DISTINCT round_id FROM lake_comments WHERE round_id>0 ORDER BY round_id")][: args.rounds]
    total_created = 0
    for rid in rounds:
        sig = update_signals(conn, cfg, rid)
        trans = transition_candidates(conn, cfg.lifecycle, rid)
        total_created += sig.phrase_candidates + sig.skeleton_candidates
        print(f"round {rid}: scanned={sig.scanned} phrase={sig.phrase_candidates} "
              f"skel={sig.skeleton_candidates} img={sig.image_candidates} "
              f"triggered={len(trans['triggered'])} expired={len(trans['expired'])}")

    cands = [c for c in __import__("meme.candidates", fromlist=["all_active"]).all_active(conn)
             if c.state in ("pending", "triggered")]
    cands.sort(key=order_key)
    print(f"\n总入榜候选 {total_created}，当前队列 {len(cands)}")

    print(f"\n=== 榜单 top {args.top}（order_key 排序）===")
    from meme.detect.evidence import meme_features
    for c in cands[:args.top]:
        f = meme_features(c.evidence_usages)
        print(f"  {c.cid} [{c.state:9s}] [{c.channel:8s}] dv={c.distinct_videos:3d} du={c.distinct_ups:3d} "
              f"z={c.z_score if c.z_score is not None else '-':>6} "
              f"score={f.meme_score:5.2f} copy={f.copy_pairs} skel={f.skel_top_share:.2f} "
              f"sa={f.standalone_rate:.2f}  \"{c.head[:36]}\"")

    print("\n=== 真梗标注集召回 ===")
    heads = {c.head for c in cands}
    all_heads = {r["head"] for r in conn.execute("SELECT head FROM candidates")}
    triggered_heads = {c.head for c in cands if c.state == "triggered"}

    def _found(t: str) -> str:
        if t == "X麻了":  # 公式族：合成候选 head 形如 "<X>麻了"
            sk = [h for h in all_heads if "麻了" in h and h.startswith("<X>")]
            if sk:
                return f"✓ 公式族 {sk[0][:30]}"
            return "✗ 公式未合成"
        if t in triggered_heads:
            return "✓✓ 已触发"
        if t in heads:
            return "✓ 入榜"
        if t in all_heads:
            return "○ 曾入榜（已过期/被拒）"
        # 同为子串的 gram 也算（"赢麻" ⊂ "赢麻了"）
        if any(t in h for h in heads):
            return "✓ 子串入榜"
        return "✗ 从未入榜"

    n_hit = 0
    for t in TRUTH:
        r = _found(t)
        n_hit += r.startswith("✓")
        print(f"  {r:24s} {t}")
    print(f"\n入榜召回 {n_hit}/{len(TRUTH)}")
    conn.close()


if __name__ == "__main__":
    main()
