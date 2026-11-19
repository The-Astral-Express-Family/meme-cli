/** 原始湖访问：内容寻址缓存的查询面（候选语料 + backtest 负例来源）。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'

export function commentsForRound(db: DatabaseSync, roundId: number): Row[] {
  return db.prepare('SELECT * FROM lake_comments WHERE round_id=? ORDER BY ctime').all(roundId) as Row[]
}

/** aid → up_mid（跨 up 新颖性计算）。 */
export function upMidMap(db: DatabaseSync): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of db.prepare('SELECT aid, up_mid FROM lake_videos').all() as Row[]) {
    out.set(r.aid as number, r.up_mid as number)
  }
  return out
}

/** 确定性伪随机（mulberry32）——负例采样与留出集切分可复现。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 随机采样不含目标词的评论作为 backtest 负例。 */
export function randomNegativeComments(
  db: DatabaseSync, n: number, excludeLike: string[], seed: number | null = null,
): string[] {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM lake_comments').get() as Row).c as number
  if (total === 0) return []
  const rnd = makeRng(seed ?? 42)
  const msgs: string[] = []
  const seenRp = new Set<number>()
  const getOne = db.prepare('SELECT rpid, message FROM lake_comments LIMIT 1 OFFSET ?')
  for (let tried = 0; msgs.length < n && tried < n * 10 + 200; tried++) {
    const row = getOne.get(Math.floor(rnd() * total)) as Row | undefined
    if (!row || seenRp.has(row.rpid as number)) continue
    seenRp.add(row.rpid as number)
    const m = row.message as string
    if (!excludeLike.some((t) => t && m.includes(t))) msgs.push(m)
  }
  return msgs
}
