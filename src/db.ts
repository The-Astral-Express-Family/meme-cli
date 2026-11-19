/**
 * SQLite 单文件存储（node:sqlite）：application_id 守卫 + 单调 user_version 迁移。
 *
 * 逻辑分区：原始湖 / 候选队列 / 词条库 / 笔记 / 审计日志 / surf 轮次 / 向量 / FTS。
 * DDL 与 Python v0.2 逐字节一致——两端的库文件可直接共享。
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { segment } from './tokenize.ts'
import { dbForeign } from './errors.ts'
import { SCHEMA_VERSION } from './version.ts'

export const APP_ID = 0x4d454d45 // 'MEME'

/** 行对象（node:sqlite 返回列名键控的普通对象）。 */
export type Row = Record<string, any>

const DDL = `
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

-- 图梗发现：评论图片的 pHash——梗图的本质是跨视频复现，重复即信号
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
  day   TEXT NOT NULL,
  cnt   INTEGER NOT NULL DEFAULT 0,
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
  channel    TEXT NOT NULL DEFAULT 'phrase',
  state      TEXT NOT NULL DEFAULT 'pending',
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
  matcher   TEXT,
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
`

/** v1→v2：FTS 文档重建为分词格式（unicode61 把连续汉字串当单 token）。 */
function migrateV2ReindexFts(db: DatabaseSync): void {
  const seg = (s: string) => (s ? segment(s).join(' ') : '')
  const rows = db.prepare('SELECT id, name, aliases, card, examples FROM memes').all() as Row[]
  for (const r of rows) {
    const card = JSON.parse(r.card || '{}')
    const aliases = JSON.parse(r.aliases || '[]')
    const examples = JSON.parse(r.examples || '[]').concat(card.usage || [])
    db.prepare('DELETE FROM memes_fts WHERE meme_id=?').run(r.id)
    db.prepare('INSERT INTO memes_fts(meme_id,name,aliases,gist,examples) VALUES(?,?,?,?,?)')
      .run(r.id, seg(r.name), seg(aliases.join(' ')), seg(card.gist || ''), seg(examples.join(' ')))
  }
}

/** 打开（必要时创建）数据库并执行守卫与迁移。 */
export function connect(dbPath: string): DatabaseSync {
  const fresh = !exists(dbPath)
  if (fresh) mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  if (!fresh) {
    const app = (db.prepare('PRAGMA application_id').get() as Row).application_id as number
    if (app !== 0 && app !== APP_ID) {
      db.close()
      throw dbForeign(dbPath)
    }
  }
  db.exec(`PRAGMA application_id=${APP_ID}`)
  const ver = (db.prepare('PRAGMA user_version').get() as Row).user_version as number
  if (ver > SCHEMA_VERSION) {
    db.close()
    throw dbForeign(`${dbPath} (user_version=${ver} > 支持版本 ${SCHEMA_VERSION})`)
  }
  if (ver < SCHEMA_VERSION) {
    const hadTables = ver >= 1
    db.exec(DDL)
    if (hadTables && SCHEMA_VERSION >= 2) {
      migrateV2ReindexFts(db)
    }
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
  }
  return db
}

/** 批量写事务：失败整体回滚（node:sqlite 默认逐句自动提交）。 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function kvGet(db: DatabaseSync, key: string, defaultValue: string | null = null): string | null {
  const row = db.prepare('SELECT value FROM kv_meta WHERE key=?').get(key) as Row | undefined
  return row ? (row.value as string) : defaultValue
}

export function kvSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO kv_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value)
}

function exists(path: string): boolean {
  try {
    // node:sqlite 对空文件也视为新建库；与 Python 的 path.exists() 语义对齐要看大小
    return statSync(path).size > 0
  } catch {
    return false
  }
}
