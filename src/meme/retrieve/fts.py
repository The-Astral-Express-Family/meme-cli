"""FTS5 检索（BM25）：查询文本转义为惰性短语（DSH 房子风格），OR 连接求召回。"""

from __future__ import annotations

import sqlite3

import jieba

from ..detect.ngram import _keep_token
from ..detect.skel import FUNC_WORDS


def build_match_query(query: str) -> str:
    terms = [t for t in jieba.lcut(query) if _keep_token(t) and t not in FUNC_WORDS]
    if not terms:
        terms = [query.strip()]
    # 每个词转义为一个 FTS5 短语（内部双引号翻倍），OR 连接
    phrases = ['"' + t.replace('"', '""') + '"' for t in terms if t.strip()]
    return " OR ".join(phrases)


def search_fts(conn: sqlite3.Connection, query: str, top: int = 8) -> list[tuple[str, float]]:
    """返回 [(meme_id, bm25_rank)]；bm25() 越小越好，此处归一为越大越好的分数。"""
    mq = build_match_query(query)
    if not mq:
        return []
    rows = conn.execute(
        "SELECT meme_id, bm25(memes_fts) AS rank FROM memes_fts "
        "WHERE memes_fts MATCH ? ORDER BY rank LIMIT ?",
        (mq, top * 2),
    ).fetchall()
    out = []
    for r in rows:
        rank = float(r["rank"])  # 负值越小越相关
        out.append((r["meme_id"], -rank))
    return out[:top]
