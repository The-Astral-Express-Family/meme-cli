"""backtest 闸门（§7.4）：留出集命中率 + 负例误报率。

归纳质量由此第一次成为可测量、可回归的工程指标（D4）。
原始湖兼任负例语料（§3.1）。
"""

from __future__ import annotations

import random
import sqlite3
from dataclasses import dataclass, field

from .. import lake
from ..match.pipeline import CompiledMatcher, match_compiled
from ..models import Meme


def _split_dialogue(texts: list[str], ctxs: list[list[str] | None] | None) -> tuple[list[str], list[list[str] | None]]:
    """含"上句：X 本句：Y"标记的文本拆为会话上下文（subagent 实战反馈：交互梗的
    对话式例句曾是单行文本，无 ctx 则 tier 3 永不触发，backtest 恒 0%）。"""
    import re

    pat = re.compile(r"上句[:：]\s*(.+?)\s*[\n|｜;；]*\s*本句[:：]\s*(.+)$")
    out_texts, out_ctxs = [], []
    for i, t in enumerate(texts):
        m = pat.search(t)
        if m:
            out_texts.append(m.group(2).strip())
            out_ctxs.append([m.group(1).strip(), m.group(2).strip()])
        else:
            out_texts.append(t)
            out_ctxs.append(ctxs[i] if ctxs and i < len(ctxs) else None)
    return out_texts, out_ctxs


@dataclass
class BacktestResult:
    holdout_size: int = 0
    hits: int = 0
    hit_rate: float = 0.0
    negatives: int = 0
    false_positives: int = 0
    fp_rate: float = 0.0
    passed: bool = False
    missed: list[str] = field(default_factory=list)   # 漏报样本（修订用）
    false_hits: list[str] = field(default_factory=list)  # 误报样本（修订用）

    def to_dict(self) -> dict:
        return {
            "holdout_size": self.holdout_size,
            "hits": self.hits,
            "hit_rate": round(self.hit_rate, 3),
            "negatives": self.negatives,
            "false_positives": self.false_positives,
            "fp_rate": round(self.fp_rate, 3),
            "passed": self.passed,
        }


def run_backtest(
    conn: sqlite3.Connection,
    meme: Meme,
    matcher: CompiledMatcher,
    positive_texts: list[str],
    *,
    holdout: float = 0.3,
    holdout_texts: list[str] | None = None,  # 显式留出集（去污染：未进过归纳提示词）
    holdout_ctx: list[list[str] | None] | None = None,  # 与 holdout_texts 平行的会话上下文（交互梗 tier 3）
    min_hit: float = 0.7,
    max_fp: float = 0.02,
    negatives: int = 1000,
    seed: int = 42,
) -> BacktestResult:
    res = BacktestResult()
    texts = [t for t in positive_texts if t and t.strip()]
    if holdout_texts is not None:
        holdout_texts = [t for t in holdout_texts if t and t.strip()]
    else:
        rnd = random.Random(seed)
        rnd.shuffle(texts)
        n_hold = max(1, int(len(texts) * holdout)) if texts else 0
        holdout_texts = texts[:n_hold]
    holdout_texts, holdout_ctx = _split_dialogue(holdout_texts, holdout_ctx)
    res.holdout_size = len(holdout_texts)
    for i, t in enumerate(holdout_texts):
        ctx = holdout_ctx[i] if holdout_ctx and i < len(holdout_ctx) else None
        hit = match_compiled(matcher, t, ctx)
        if hit and hit.tier in (1, 2, 3):
            res.hits += 1
        else:
            res.missed.append(t)
    res.hit_rate = res.hits / res.holdout_size if res.holdout_size else 0.0

    # 负例 = 不含该梗本体（名字/别名）的评论——不能按全部模式词排除，
    # 否则泛用模式词（如"的"）会把负例语料掏空，误报门形同虚设
    exclude = [meme.name, *meme.aliases]
    negs = lake.random_negative_comments(conn, negatives, exclude, seed=seed)
    res.negatives = len(negs)
    for t in negs:
        hit = match_compiled(matcher, t, None)  # 负例无会话上下文，tier 3 天然不触发
        if hit and hit.tier in (1, 2, 3):
            res.false_positives += 1
            if len(res.false_hits) < 15:
                res.false_hits.append(t)
    res.fp_rate = res.false_positives / res.negatives if res.negatives else 0.0

    # 冷启动：负例不足时不卡误报门（库会随 surf 增长，后续 edit 复检）
    fp_ok = res.fp_rate <= max_fp if res.negatives >= 200 else True
    res.passed = bool(res.holdout_size) and res.hit_rate >= min_hit and fp_ok
    return res
