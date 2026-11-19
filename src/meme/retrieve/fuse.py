"""混合检索：BM25 + 例句级向量 + RRF 融合（§10.2）。

tombstone 退出默认检索权重（D7：检索权重才是被管理的稀缺资源）；
fading 减半权重。--all 可显式包含归档区。
"""

from __future__ import annotations

import sqlite3

from .. import entries
from ..match.pipeline import vector_nearest
from ..match.vector import Embedder


def hybrid_search(
    conn: sqlite3.Connection,
    query: str,
    cfg,
    top: int | None = None,
    include_archived: bool = False,
    embedder: Embedder | None = None,
) -> list[dict]:
    from .fts import search_fts

    top = top or cfg.retrieval.search_top
    bm = search_fts(conn, query, top=top * 2)
    vec: list[tuple[str, float]] = []
    if embedder is None:
        embedder = Embedder.get(cfg.retrieval.embed_model)
    if embedder.available:
        vec = vector_nearest(conn, query, embedder, topk=top * 2)

    k = cfg.retrieval.rrf_k
    scores: dict[str, float] = {}
    for rank, (mid, _) in enumerate(bm):
        scores[mid] = scores.get(mid, 0.0) + 1.0 / (k + rank + 1)
    for rank, (mid, _) in enumerate(vec):
        scores[mid] = scores.get(mid, 0.0) + 1.0 / (k + rank + 1)

    # 先按词条状态过滤并施加权重，再按加权分排序——
    # 权重在排序后施加则不改变名次，"fading 减半权重"（D7）形同虚设
    weighted: list[tuple[float, str, object]] = []
    for mid, fused in scores.items():
        m = entries.get(conn, mid)
        if m is None:
            continue
        if m.state == "tombstone" and not include_archived:
            continue
        w = 0.5 if m.state == "fading" else 1.0
        weighted.append((fused * w, mid, m))
    weighted.sort(key=lambda x: (-x[0], x[1]))

    out: list[dict] = []
    for score, _mid, m in weighted:
        out.append({"meme": m, "score": round(score, 5), "brief": _brief(m)})
        if len(out) >= top:
            break
    return out


def _brief(m) -> str:
    aggression = m.card.aggression or "-"
    return f"{m.id} {m.name} | {m.class_}梗 | {m.card.gist} | 攻击性{aggression} | {m.state}"
