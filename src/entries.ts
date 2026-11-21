/** 词条库：CRUD + FTS 同步 + 例句向量锚点同步（例句级而非词条级）。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import {
  MemeSchema, MatcherSpecSchema, type Meme, nowIso,
} from './models.ts'
import { segment } from './tokenize.ts'

export interface VectorAnchor { idx: number; text: string; dim: number; vec: Uint8Array }

/** FTS 文档必须预分词：unicode61 把连续汉字串当单 token，不切分则查询侧与文档侧 token 空间错位。 */
function ftsDoc(meme: Meme): [string, string, string, string] {
  const seg = (s: string) => (s ? segment(s).join(' ') : '')
  return [
    seg(meme.name),
    seg(meme.aliases.join(' ')),
    seg(meme.card.gist || ''),
    seg([...meme.examples, ...meme.card.usage].join(' ')),
  ]
}

function syncFts(db: DatabaseSync, meme: Meme): void {
  db.prepare('DELETE FROM memes_fts WHERE meme_id=?').run(meme.id)
  const [name, aliases, gist, examples] = ftsDoc(meme)
  db.prepare('INSERT INTO memes_fts(meme_id, name, aliases, gist, examples) VALUES(?,?,?,?,?)')
    .run(meme.id, name, aliases, gist, examples)
}

export function fromRow(row: Row): Meme {
  return MemeSchema.parse({
    id: row.id,
    name: row.name,
    aliases: JSON.parse(row.aliases || '[]'),
    class: row.class,
    lineage: JSON.parse(row.lineage || '{}'),
    platform: JSON.parse(row.platform || '[]'),
    state: row.state,
    birth: JSON.parse(row.birth || '{}'),
    matcher: row.matcher ? MatcherSpecSchema.parse(JSON.parse(row.matcher)) : null,
    card: JSON.parse(row.card || '{}'),
    examples: JSON.parse(row.examples || '[]'),
    drift: JSON.parse(row.drift || '[]'),
    stats: JSON.parse(row.stats || '{}'),
    wild_rounds: JSON.parse(row.wild_rounds || '[]'),
    revived_pending: row.revived_pending ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

export function get(db: DatabaseSync, mid: string): Meme | null {
  const row = db.prepare('SELECT * FROM memes WHERE id=?').get(mid) as Row | undefined
  return row ? fromRow(row) : null
}

/** 按 id 或名字/别名解析词条（LIKE 元字符转义——ref 来自用户输入）。 */
export function resolve(db: DatabaseSync, ref: string): Meme | null {
  const direct = get(db, ref)
  if (direct) return direct
  const esc = ref.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const row = db.prepare(
    "SELECT id FROM memes WHERE name=? OR aliases LIKE ? ESCAPE '\\' "
    + "ORDER BY state!='tombstone', id LIMIT 1",
  ).get(ref, `%"${esc}"%`) as Row | undefined
  return row ? get(db, row.id as string) : null
}

export function allMemes(db: DatabaseSync, states?: string[]): Meme[] {
  const rows = states?.length
    ? db.prepare(`SELECT * FROM memes WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`).all(...states)
    : db.prepare('SELECT * FROM memes ORDER BY id').all()
  return (rows as Row[]).map(fromRow)
}

/** 全量保存 + FTS 同步；vectors 非空时重建该词条的例句向量。 */
export function save(db: DatabaseSync, meme: Meme, vectors: VectorAnchor[] | null = null): void {
  meme.updated_at = nowIso()
  db.prepare(
    'INSERT INTO memes(id,name,aliases,class,lineage,platform,state,birth,matcher,card,'
    + 'examples,drift,stats,wild_rounds,revived_pending,created_at,updated_at) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) '
    + 'ON CONFLICT(id) DO UPDATE SET name=excluded.name, aliases=excluded.aliases,'
    + 'class=excluded.class, lineage=excluded.lineage, platform=excluded.platform,'
    + 'state=excluded.state, birth=excluded.birth, matcher=excluded.matcher,'
    + 'card=excluded.card, examples=excluded.examples, drift=excluded.drift,'
    + 'stats=excluded.stats, wild_rounds=excluded.wild_rounds,'
    + 'revived_pending=excluded.revived_pending, updated_at=excluded.updated_at',
  ).run(
    meme.id, meme.name, JSON.stringify(meme.aliases), meme.class, JSON.stringify(meme.lineage),
    JSON.stringify(meme.platform), meme.state, JSON.stringify(meme.birth),
    meme.matcher === null ? null : JSON.stringify(meme.matcher), JSON.stringify(meme.card),
    JSON.stringify(meme.examples), JSON.stringify(meme.drift), JSON.stringify(meme.stats),
    JSON.stringify(meme.wild_rounds), meme.revived_pending, meme.created_at, meme.updated_at,
  )
  syncFts(db, meme)
  if (vectors !== null) {
    db.prepare('DELETE FROM meme_vectors WHERE meme_id=?').run(meme.id)
    const ins = db.prepare('INSERT OR REPLACE INTO meme_vectors(meme_id,idx,text,dim,vec) VALUES(?,?,?,?,?)')
    for (const v of vectors) ins.run(meme.id, v.idx, v.text, v.dim, v.vec)
  }
}

export function recordWildHit(db: DatabaseSync, memeId: string, day: string, cnt: number): void {
  db.prepare(
    'INSERT INTO meme_hit_daily(meme_id,day,cnt) VALUES(?,?,?) '
    + 'ON CONFLICT(meme_id,day) DO UPDATE SET cnt=cnt+excluded.cnt',
  ).run(memeId, day, cnt)
}

/** 词条命中日序列（窗口内逐日，缺日补零）。 */
export function dailySeries(db: DatabaseSync, memeId: string, days: number): number[] {
  const start = new Date(Date.now() - (days - 1) * 86400_000)
  const cutoff = todayIsoLocal(start)
  const rows = new Map<string, number>()
  for (const r of db.prepare('SELECT day, cnt FROM meme_hit_daily WHERE meme_id=? AND day>=?').all(memeId, cutoff) as Row[]) {
    rows.set(r.day as string, r.cnt as number)
  }
  const out: number[] = []
  for (let d = new Date(start); d <= new Date(); d = new Date(d.getTime() + 86400_000)) {
    out.push(rows.get(todayIsoLocal(d)) ?? 0)
  }
  return out
}

function todayIsoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 复活确认流：第 1 次非 brief show 见最小卡（记 2）→ 第 2 次恢复完整卡。
 * brief 不推进确认（快速浏览不该消耗确认机会）。
 */
export function confirmRevival(db: DatabaseSync, meme: Meme, level: string): Meme {
  if (!meme.revived_pending || level === 'brief') return meme
  if (meme.revived_pending === 1) {
    meme.revived_pending = 2
  } else {
    meme.revived_pending = 0
  }
  save(db, meme)
  return meme
}
