/**
 * SQLite 单文件存储（node:sqlite）：application_id + user_version 双守卫。
 *
 * 逻辑分区：原始湖 / 候选队列 / 词条库 / 笔记 / 审计日志 / surf 轮次 / 向量 / FTS。
 * 无迁移路径：库结构只随版本演进，旧库一律拒收（删除重建，schema 见 DDL）。
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dbForeign } from './errors.ts'
import { SCHEMA_VERSION } from './version.ts'

export const APP_ID = 0x4d454d46 // 'MEMF'——dsh-meme 独立谱系，异构旧库在此即被拒

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
  source      TEXT NOT NULL DEFAULT 'popular',
  round_id    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lvideo_round ON lake_videos(round_id);

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
  platform  TEXT NOT NULL DEFAULT '[]',
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
`

/** 打开（必要时创建）数据库并执行守卫；无迁移路径，版本不符一律拒收。 */
export function connect(dbPath: string): DatabaseSync {
  const fresh = !exists(dbPath)
  if (fresh) mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  // bot 进程（群聊采集）与 surf CLI 进程并发写同一文件：写锁冲突时等待而非报错
  db.exec('PRAGMA busy_timeout=5000')
  if (fresh) {
    db.exec(DDL)
    db.exec(`PRAGMA application_id=${APP_ID}`)
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
    return db
  }
  const app = (db.prepare('PRAGMA application_id').get() as Row).application_id as number
  const ver = (db.prepare('PRAGMA user_version').get() as Row).user_version as number
  if (app !== APP_ID || ver !== SCHEMA_VERSION) {
    db.close()
    throw dbForeign(`${dbPath}（application_id=${app} user_version=${ver}）`)
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

/** 空文件不算已建库（node:sqlite 会把 0 字节文件当新库打开）。 */
function exists(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}
