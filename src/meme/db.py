"""SQLite 单文件存储：application_id 守卫 + 单调 user_version 迁移（DSH 房子风格）。

逻辑分区（§3.3）：原始湖 / 候选队列 / 词条库 / 笔记 / 审计日志 / surf 轮次 / 向量 / FTS。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from . import SCHEMA_VERSION
from .errors import db_foreign

APP_ID = 0x4D454D45  # 'MEME'

DDL = """
CREATE TABLE IF NOT EXISTS kv_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS surf_runs (
  round_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  fetched     INTEGER NOT NULL DEFAULT 0,
  new_videos  INTEGER NOT NULL DEFAULT 0,
  new_comments INTEGER NOT NULL DEFAULT 0,
  degraded    INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS lake_videos (
  aid         INTEGER PRIMARY KEY,
  bvid        TEXT,
  title       TEXT,
  rid         INTEGER,
  up_mid      INTEGER,
  up_name     TEXT,
  pubdate     INTEGER,
  reply_count INTEGER,
  fetched_at  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'popular'
);

CREATE TABLE IF NOT EXISTS lake_comments (
  rpid       INTEGER PRIMARY KEY,
  oid        INTEGER NOT NULL,
  root       INTEGER NOT NULL DEFAULT 0,
  parent     INTEGER NOT NULL DEFAULT 0,
  mid        INTEGER NOT NULL DEFAULT 0,
  message    TEXT NOT NULL,
  ctime      INTEGER NOT NULL,
  likes      INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  round_id   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lake_oid ON lake_comments(oid);
CREATE INDEX IF NOT EXISTS idx_lake_ctime ON lake_comments(ctime);

-- 图梗发现（v3）：评论图片的 pHash——梗图的本质是跨视频复现，重复即信号
CREATE TABLE IF NOT EXISTS lake_comment_images (
  rpid      INTEGER NOT NULL,
  url       TEXT NOT NULL,
  phash     TEXT,
  width     INTEGER NOT NULL DEFAULT 0,
  height    INTEGER NOT NULL DEFAULT 0,
  round_id  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rpid, url)
);
CREATE INDEX IF NOT EXISTS idx_img_round ON lake_comment_images(round_id);

-- 增量日聚合：爆发检测的基线语料（避免每轮重扫原始湖）
CREATE TABLE IF NOT EXISTS phrase_daily (
  phrase TEXT NOT NULL,
  day    TEXT NOT NULL,
  cnt    INTEGER NOT NULL DEFAULT 0,
  videos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phrase, day)
);
CREATE TABLE IF NOT EXISTS skel_daily (
  skel  TEXT NOT NULL,
  day    TEXT NOT NULL,
  cnt    INTEGER NOT NULL DEFAULT 0,
  videos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (skel, day)
);

-- 词条野外命中日聚合：衰减检测（active→fading→tombstone）的数据基础
CREATE TABLE IF NOT EXISTS meme_hit_daily (
  meme_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  cnt     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (meme_id, day)
);

CREATE TABLE IF NOT EXISTS candidates (
  cid        TEXT PRIMARY KEY,
  head       TEXT NOT NULL,
  kind_guess TEXT NOT NULL DEFAULT 'word',
  channel    TEXT NOT NULL DEFAULT 'phrase',  -- phrase|skeleton
  state      TEXT NOT NULL DEFAULT 'pending', -- pending|triggered|inducted|rejected
  z_score    REAL,
  distinct_videos INTEGER NOT NULL DEFAULT 0,
  distinct_ups    INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  surfs_seen INTEGER NOT NULL DEFAULT 0,
  last_round INTEGER NOT NULL DEFAULT 0,
  triggered_at TEXT,
  rejected_at  TEXT,
  reject_reason TEXT,
  evidence_usages TEXT NOT NULL DEFAULT '[]',
  related     TEXT NOT NULL DEFAULT '[]',
  provenance  TEXT NOT NULL DEFAULT 'bilibili',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cand_state ON candidates(state);

CREATE TABLE IF NOT EXISTS cand_video (
  cid   TEXT NOT NULL,
  aid   INTEGER NOT NULL,
  up_mid INTEGER NOT NULL DEFAULT 0,
  ts    TEXT NOT NULL,
  PRIMARY KEY (cid, aid)
);

CREATE TABLE IF NOT EXISTS memes (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  aliases   TEXT NOT NULL DEFAULT '[]',
  class     TEXT NOT NULL DEFAULT 'word',
  lineage   TEXT NOT NULL DEFAULT '{}',
  platform  TEXT NOT NULL DEFAULT '["bilibili"]',
  state     TEXT NOT NULL DEFAULT 'observing',
  birth     TEXT NOT NULL DEFAULT '{}',
  matcher   TEXT,                       -- JSON 编译产物；null = 纯向量词条
  card      TEXT NOT NULL,
  examples  TEXT NOT NULL DEFAULT '[]',
  drift     TEXT NOT NULL DEFAULT '[]',
  stats     TEXT NOT NULL DEFAULT '{}',
  wild_rounds TEXT NOT NULL DEFAULT '[]',
  revived_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meme_state ON memes(state);

CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
  meme_id UNINDEXED,
  name, aliases, gist, examples,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS meme_vectors (
  meme_id TEXT NOT NULL,
  idx     INTEGER NOT NULL,
  text    TEXT NOT NULL,
  dim     INTEGER NOT NULL,
  vec     BLOB NOT NULL,
  PRIMARY KEY (meme_id, idx)
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meme_id    TEXT,
  head       TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  meme_id  TEXT NOT NULL,
  action   TEXT NOT NULL,
  source   TEXT NOT NULL,
  payload  TEXT NOT NULL,
  ts       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS induction_queue (
  cid       TEXT PRIMARY KEY,
  ctx       TEXT,
  queued_at TEXT NOT NULL
);
"""


def _migrate_v2_reindex_fts(conn: sqlite3.Connection) -> None:
    """v1→v2：FTS 文档重建为分词格式。v1 存量文档是未分词原文，
    unicode61 把连续汉字串当单 token，BM25 对查询侧的分词短语基本失配。"""
    import json as _json

    import jieba

    def seg(s: str) -> str:
        return " ".join(jieba.lcut(s or ""))

    rows = conn.execute("SELECT id, name, aliases, card, examples FROM memes").fetchall()
    for r in rows:
        card = _json.loads(r["card"] or "{}")
        aliases = _json.loads(r["aliases"] or "[]")
        examples = _json.loads(r["examples"] or "[]") + (card.get("usage") or [])
        conn.execute("DELETE FROM memes_fts WHERE meme_id=?", (r["id"],))
        conn.execute(
            "INSERT INTO memes_fts(meme_id,name,aliases,gist,examples) VALUES(?,?,?,?,?)",
            (r["id"], seg(r["name"]), seg(" ".join(aliases)),
             seg(card.get("gist") or ""), seg(" ".join(examples))),
        )


def connect(db_path: Path | str, readonly: bool = False) -> sqlite3.Connection:
    """打开（必要时创建）数据库并执行守卫与迁移。"""
    path = Path(db_path)
    fresh = not path.exists()
    if fresh:
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    if not fresh:
        app = conn.execute("PRAGMA application_id").fetchone()[0]
        if app != 0 and app != APP_ID:
            conn.close()
            raise db_foreign(str(path))
    conn.execute(f"PRAGMA application_id={APP_ID}")
    ver = conn.execute("PRAGMA user_version").fetchone()[0]
    if ver > SCHEMA_VERSION:
        conn.close()
        raise db_foreign(f"{path} (user_version={ver} > 支持版本 {SCHEMA_VERSION})")
    if ver < SCHEMA_VERSION:
        had_tables = ver >= 1
        conn.executescript(DDL)
        if had_tables and SCHEMA_VERSION >= 2:
            _migrate_v2_reindex_fts(conn)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        conn.commit()
    return conn


def kv_get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM kv_meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def kv_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO kv_meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    conn.commit()
