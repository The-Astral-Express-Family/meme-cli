"""词条库：CRUD + FTS 同步 + 例句向量锚点同步（D6：例句级而非词条级）。"""

from __future__ import annotations

import sqlite3

import jieba

from .models import Meme, j, mj, now_iso


def _fts_doc(meme: Meme) -> tuple[str, str, str, str]:
    """FTS 文档必须预分词：unicode61 会把连续汉字串当单个 token，
    不切分则查询侧（fts.py 按词构造短语）与文档侧 token 空间错位，BM25 基本失效。"""
    seg = lambda s: " ".join(jieba.lcut(s or ""))  # noqa: E731
    return (
        seg(meme.name),
        seg(" ".join(meme.aliases)),
        seg(meme.card.gist),
        seg(" ".join(meme.examples + meme.card.usage)),
    )


def _sync_fts(conn: sqlite3.Connection, meme: Meme) -> None:
    conn.execute("DELETE FROM memes_fts WHERE meme_id=?", (meme.id,))
    name, aliases, gist, examples = _fts_doc(meme)
    conn.execute(
        "INSERT INTO memes_fts(meme_id, name, aliases, gist, examples) VALUES(?,?,?,?,?)",
        (meme.id, name, aliases, gist, examples),
    )


def from_row(row: sqlite3.Row) -> Meme:
    import json

    return Meme(
        id=row["id"],
        name=row["name"],
        aliases=json.loads(row["aliases"]),
        **{"class": row["class"]},
        lineage=json.loads(row["lineage"]),
        platform=json.loads(row["platform"]),
        state=row["state"],
        birth=json.loads(row["birth"]),
        matcher=mj(row["matcher"], None),
        card=json.loads(row["card"]),
        examples=json.loads(row["examples"]),
        drift=json.loads(row["drift"]),
        stats=json.loads(row["stats"]),
        wild_rounds=json.loads(row["wild_rounds"]),
        revived_pending=int(row["revived_pending"] or 0),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def get(conn: sqlite3.Connection, mid: str) -> Meme | None:
    row = conn.execute("SELECT * FROM memes WHERE id=?", (mid,)).fetchone()
    return from_row(row) if row else None


def resolve(conn: sqlite3.Connection, ref: str) -> Meme | None:
    """按 id 或名字/别名解析词条。"""
    m = get(conn, ref)
    if m:
        return m
    # LIKE 元字符转义（ref 来自用户输入）
    esc = ref.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    row = conn.execute(
        "SELECT id FROM memes WHERE name=? OR aliases LIKE ? ESCAPE '\\' "
        "ORDER BY state!='tombstone', id LIMIT 1",
        (ref, f'%"{esc}"%'),
    ).fetchone()
    return get(conn, row["id"]) if row else None


def all_memes(conn: sqlite3.Connection, states: list[str] | None = None) -> list[Meme]:
    if states:
        q = ",".join("?" * len(states))
        rows = conn.execute(f"SELECT * FROM memes WHERE state IN ({q}) ORDER BY id", states)
    else:
        rows = conn.execute("SELECT * FROM memes ORDER BY id")
    return [from_row(r) for r in rows]


def save(conn: sqlite3.Connection, meme: Meme, vectors: list[tuple[int, str, int, bytes]] | None = None) -> None:
    """全量保存 + FTS 同步；vectors 非空时重建该词条的例句向量。"""
    meme.updated_at = now_iso()
    conn.execute(
        "INSERT INTO memes(id,name,aliases,class,lineage,platform,state,birth,matcher,card,"
        "examples,drift,stats,wild_rounds,revived_pending,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases,"
        "class=excluded.class, lineage=excluded.lineage, platform=excluded.platform,"
        "state=excluded.state, birth=excluded.birth, matcher=excluded.matcher,"
        "card=excluded.card, examples=excluded.examples, drift=excluded.drift,"
        "stats=excluded.stats, wild_rounds=excluded.wild_rounds,"
        "revived_pending=excluded.revived_pending, updated_at=excluded.updated_at",
        (meme.id, meme.name, j(meme.aliases), meme.class_, j(meme.lineage), j(meme.platform),
         meme.state, j(meme.birth), j(meme.matcher), j(meme.card), j(meme.examples),
         j(meme.drift), j(meme.stats), j(meme.wild_rounds), int(meme.revived_pending),
         meme.created_at, meme.updated_at),
    )
    _sync_fts(conn, meme)
    if vectors is not None:
        conn.execute("DELETE FROM meme_vectors WHERE meme_id=?", (meme.id,))
        for idx, text, dim, blob in vectors:
            conn.execute(
                "INSERT OR REPLACE INTO meme_vectors(meme_id,idx,text,dim,vec) VALUES(?,?,?,?,?)",
                (meme.id, idx, text, dim, blob),
            )
    conn.commit()


def record_wild_hit(conn: sqlite3.Connection, meme_id: str, day: str, cnt: int) -> None:
    conn.execute(
        "INSERT INTO meme_hit_daily(meme_id,day,cnt) VALUES(?,?,?) "
        "ON CONFLICT(meme_id,day) DO UPDATE SET cnt=cnt+excluded.cnt",
        (meme_id, day, cnt),
    )


def delete_vectors(conn: sqlite3.Connection, meme_id: str) -> None:
    conn.execute("DELETE FROM meme_vectors WHERE meme_id=?", (meme_id,))


def confirm_revival(conn: sqlite3.Connection, meme: Meme, level: str) -> Meme:
    """复活确认流：第 1 次 show 见最小卡（记 2）→ 第 2 次非 brief show 恢复完整卡。

    brief 不推进确认（快速浏览不该消耗确认机会）。返回（可能更新过的）词条；
    调用方在返回 revived_pending==0 且原值非 0 时重渲染完整卡。
    """
    if not meme.revived_pending or level == "brief":
        return meme
    if meme.revived_pending == 1:
        meme.revived_pending = 2
        save(conn, meme.model_copy(update={"revived_pending": 2}))
        return meme
    meme.revived_pending = 0
    save(conn, meme)
    return meme
