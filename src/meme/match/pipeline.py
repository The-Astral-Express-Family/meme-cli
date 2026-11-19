"""匹配流水线（§8.2）：①词表 → ②骨架 → ③交互位 → ④向量兜底。

全本地执行；输出命中 span + 词条 ID + 分层置信度。
低置信或无命中 → 明确输出"未知"并建议 add --ctx 收录（由 CLI 层呈现）。
"""

from __future__ import annotations

import sqlite3
import sys
from dataclasses import dataclass

from ..models import Constraints, Meme, PatternSpec
from . import lexicon, skeleton
from .interaction import match_interaction
from .skeleton import compile_tokens
from .vector import Embedder

CONF = {1: 0.95, 2: 0.90, 3: 0.80}


@dataclass
class MatchHit:
    meme_id: str
    name: str
    klass: str
    start: int
    end: int
    excerpt: str
    tier: int  # 1 词表 | 2 骨架 | 3 交互 | 4 向量
    confidence: float
    method: str

    def to_dict(self) -> dict:
        return {
            "meme_id": self.meme_id,
            "name": self.name,
            "class": self.klass,
            "span": [self.start, self.end],
            "excerpt": self.excerpt,
            "tier": self.tier,
            "confidence": round(self.confidence, 3),
            "method": self.method,
        }


class CompiledMatcher:
    def __init__(self, meme: Meme):
        self.meme = meme
        spec = meme.matcher
        self.lex_terms: list[str] = []
        self.skeleton_patterns = []
        self.interaction_pats: list[PatternSpec] = []
        self.constraints = spec.constraints if spec else None
        if spec:
            for p in spec.patterns:
                if p.kind == "lex":
                    self.lex_terms.extend(p.terms or [])
                elif p.kind == "skeleton":
                    self.skeleton_patterns.append(compile_tokens(p.tokens or []))
                elif p.kind == "interaction":
                    self.interaction_pats.append(p)


def load_matchers(conn: sqlite3.Connection) -> list[CompiledMatcher]:
    from .. import entries

    return [CompiledMatcher(m) for m in entries.all_memes(conn) if m.matcher is not None]


def match_compiled(cm: CompiledMatcher, text: str, ctx_lines: list[str] | None) -> MatchHit | None:
    """对单个词条跑 ①②③，返回最高层命中。"""
    cons = cm.constraints or Constraints()
    if cm.lex_terms:
        hit = lexicon.find_terms(text, cm.lex_terms, cons)
        if hit:
            s, e, term = hit
            return MatchHit(cm.meme.id, cm.meme.name, cm.meme.class_, s, e, term, 1, CONF[1], "lexicon")
    for pat in cm.skeleton_patterns:
        hit = skeleton.match_skeleton(text, pat)
        if hit:
            s, e, matched = hit
            return MatchHit(cm.meme.id, cm.meme.name, cm.meme.class_, s, e, matched, 2, CONF[2], "skeleton")
    if cm.interaction_pats and ctx_lines:
        for p in cm.interaction_pats:
            hit = match_interaction(ctx_lines, p)
            if hit:
                s, e, matched = hit
                return MatchHit(cm.meme.id, cm.meme.name, cm.meme.class_, s, e, matched, 3, CONF[3], "interaction")
    return None


def _dedup(hits: list[MatchHit]) -> list[MatchHit]:
    """重叠 span 去重：按 tier 升序处理，先到先得（高 tier 必然先入 kept）。"""
    hits.sort(key=lambda h: (h.tier, -(h.end - h.start), h.meme_id))
    kept: list[MatchHit] = []
    for h in hits:
        if any(h.start < k.end and k.start < h.end for k in kept):
            continue
        kept.append(h)
    kept.sort(key=lambda h: (h.start, h.meme_id))
    return kept


def lookup(
    conn: sqlite3.Connection,
    text: str,
    ctx_lines: list[str] | None = None,
    vector_threshold: float = 0.60,
    embedder: Embedder | None = None,
    max_vector_hits: int = 3,
) -> list[MatchHit]:
    """read path 主入口：识别一段文本里的梗（命中 span + 置信度）。"""
    matchers = load_matchers(conn)
    hits = []
    # 约束否决集：词条含目标词但被位置/语境约束否决（"为什么不回答我？"）——
    # 向量层不得再为它报低置信回声（subagent 实战反馈的"回声残留"）
    vetoed: set[str] = set()
    for cm in matchers:
        h = match_compiled(cm, text, ctx_lines)
        if h:
            hits.append(h)
        elif cm.lex_terms and any(t and t in text for t in cm.lex_terms):
            vetoed.add(cm.meme.id)
    hits = _dedup(hits)
    # ④ 向量兜底：整段文本做例句近邻（捕获未见变体；span 恒为全文，置信 ≤0.7）
    if embedder is None:
        embedder = Embedder.get()
    if embedder.available:
        near = vector_nearest(conn, text, embedder, topk=max_vector_hits)
        for meme_id, score in near:
            if score < vector_threshold:
                continue
            if any(h.meme_id == meme_id for h in hits) or meme_id in vetoed:
                continue
            from .. import entries

            m = entries.get(conn, meme_id)
            if m is None:
                continue
            hits.append(
                MatchHit(meme_id, m.name, m.class_, 0, len(text), text[:40], 4, min(score, 0.70), "vector")
            )
        hits.sort(key=lambda h: (h.tier, -h.confidence, h.meme_id))
    return hits


def vector_nearest(
    conn: sqlite3.Connection, text: str, embedder: Embedder, topk: int = 5
) -> list[tuple[str, float]]:
    """查询向量 vs 全体例句向量（例句级，D6），每词条取最佳例句。"""
    import numpy as np

    rows = conn.execute(
        "SELECT meme_id, idx, dim, vec FROM meme_vectors ORDER BY meme_id, idx"
    ).fetchall()
    if not rows:
        return []
    q = embedder.embed([text])
    if q is None or q.shape[0] == 0:
        return []
    best: dict[str, float] = {}
    try:
        mat = np.stack([np.frombuffer(r["vec"], dtype=np.float32) for r in rows])
        sims = mat @ q[0]
    except ValueError:
        # 库内残留异维度向量（如更换 embed 模型后未重建）→ 向量层优雅降级，读路径不崩
        print("meme: 向量库维度不一致（曾更换 embed 模型？），本次跳过向量兜底", file=sys.stderr)
        return []
    for i, r in enumerate(rows):
        mid = r["meme_id"]
        s = float(sims[i])
        if s > best.get(mid, -1.0):
            best[mid] = s
    ranked = sorted(best.items(), key=lambda x: -x[1])[:topk]
    return ranked


def scan_texts(
    matchers: list[CompiledMatcher], texts: list[tuple[str, list[str] | None]]
) -> tuple[dict[str, int], dict[str, set[str]]]:
    """批量野外复查（surf 用）：①②③层。texts 为 (文本, 会话上下文|None) 对。

    返回 (meme_id → 命中数, meme_id → 命中摘录集)。
    """
    counts: dict[str, int] = {}
    excerpts: dict[str, set[str]] = {}
    for t, ctx in texts:
        for cm in matchers:
            h = match_compiled(cm, t, ctx)
            if h:
                counts[cm.meme.id] = counts.get(cm.meme.id, 0) + 1
                excerpts.setdefault(cm.meme.id, set()).add(h.excerpt)
    return counts, excerpts
