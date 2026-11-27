/** curator-v1 种子候选：从 v4 cases.jsonl 提取白名单字段 → seed/candidates.jsonl → 写入 run 库。
 *
 * 导入前扫描禁止字段（设计 §5/§6）：白名单外的字段一律拒绝；序列化文本里出现任何
 * 金标字段名（candidate_verdict 等）也拒绝。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { connect } from '../src/db.ts'
import { SEED_FILE, V4_DIR, SEED_FIELDS, FORBIDDEN_KEYS, loadGold, readJsonl } from './curator-lib.ts'

interface V4Case {
  case_id: string
  source_cid: string
  head: string
  kind_guess: string
  channel: string
  state: string
  videos: number
  ups: number
  evidence: Array<{ text: string; aid: number; rpid: number; mid: number; is_chain: boolean; is_reply?: boolean; root?: number; parent?: number; ctime?: number }>
}

export interface SeedCandidate {
  cid: string
  head: string
  channel: string
  kind_guess: string
  state: string
  videos: number
  ups: number
  evidence_usages: Array<{ text: string; aid: number; rpid: number; root: number; parent: number; mid: number; ctime: number; chain: boolean }>
}

/** v4 case → 种子对象（白名单字段，与生产 surf 后的候选同形）。 */
export function toSeed(c: V4Case): SeedCandidate {
  const out: SeedCandidate = {
    cid: c.source_cid,
    head: c.head,
    channel: c.channel,
    kind_guess: c.kind_guess,
    state: c.state,
    videos: c.videos,
    ups: c.ups,
    evidence_usages: c.evidence.slice(0, 40).map((e) => ({
      text: e.text, aid: e.aid, rpid: e.rpid, root: e.root ?? 0, parent: e.parent ?? 0, mid: e.mid, ctime: e.ctime ?? 0, chain: !!e.is_chain,
    })),
  }
  return out
}

/** 白名单 + 禁止字段扫描。违规抛错。 */
export function scanForbidden(obj: Record<string, unknown>): void {
  const keys = Object.keys(obj)
  const extra = keys.filter((k) => !(SEED_FIELDS as readonly string[]).includes(k))
  if (extra.length) throw new Error(`白名单外字段: ${extra.join(',')}（cid=${obj.cid}）`)
  const line = JSON.stringify(obj)
  for (const bad of FORBIDDEN_KEYS) {
    if (line.includes(bad)) throw new Error(`种子候选含金标字段 "${bad}"（cid=${obj.cid}）`)
  }
}

/** 导出 seed/candidates.jsonl（入库产物，可复现）。
 *
 * cases/labels 先做一一校验；同一 cid 多条 case（如 v4 的 c_70855）按首条建种子行，
 * 其余家族信息只保留在金标侧。
 */
export function exportSeed(): void {
  const cases = readFileSync(`${V4_DIR}/cases.jsonl`, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as V4Case)
  if (!cases.length) throw new Error('cases.jsonl 不能为空')
  const labels = readJsonl<{ case_id: string; source_cid: string }>(`${V4_DIR}/labels.jsonl`)
  if (cases.length !== labels.length) throw new Error(`cases/labels 条数不一致：${cases.length}/${labels.length}`)
  const caseById = new Map(cases.map((c) => [c.case_id, c]))
  for (const l of labels) {
    const c = caseById.get(l.case_id)
    if (!c) throw new Error(`label ${l.case_id} 缺对应 case`)
    if (c.source_cid !== l.source_cid) throw new Error(`label ${l.case_id} cid ${l.source_cid} ≠ case ${c.source_cid}`)
  }
  const gold = loadGold()
  const caseCids = new Set(cases.map((c) => c.source_cid))
  for (const cid of gold.byCid.keys()) if (!caseCids.has(cid)) throw new Error(`金标候选 ${cid} 缺 case`)
  for (const cid of caseCids) if (!gold.byCid.has(cid)) throw new Error(`case 候选 ${cid} 缺金标`)
  const seen = new Map<string, number>()
  const kept: V4Case[] = []
  for (const c of cases) {
    const n = seen.get(c.source_cid) ?? 0
    seen.set(c.source_cid, n + 1)
    if (n === 0) kept.push(c)
    else console.warn(`重复 cid ${c.source_cid}：case ${c.case_id}（${c.head}）与已收录候选同证据，跳过建行`)
  }
  const seeds = kept.map(toSeed)
  for (const s of seeds) scanForbidden(s as unknown as Record<string, unknown>)
  mkdirSync(dirname(SEED_FILE), { recursive: true })
  writeFileSync(SEED_FILE, seeds.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8')
  console.log(`seed/candidates.jsonl 已导出：${cases.length} 条 case → ${seeds.length} 行候选（白名单字段 ${SEED_FIELDS.join('/')}，无金标字段）`)
}

const FIXED_TS = '2026-11-01T00:00:00.000Z'

/** 把 seed/candidates.jsonl 写进一个全新 run 库。库不存在则创建。 */
export function seedRunDb(dbPath: string): number {
  const seeds = readFileSync(SEED_FILE, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SeedCandidate)
  for (const s of seeds) scanForbidden(s as unknown as Record<string, unknown>)
  const db = connect(dbPath)
  const ins = db.prepare(
    'INSERT INTO candidates(cid,head,kind_guess,channel,state,z_score,distinct_videos,distinct_ups,'
    + 'first_seen,last_seen,surfs_seen,last_round,evidence_usages,related,provenance,created_at,updated_at)'
    + " VALUES(?,?,?,?,?,NULL,?,?,?,?,0,0,?,'[]','bilibili',?,?)",
  )
  let n = 0
  for (const s of seeds) {
    ins.run(
      s.cid, s.head, s.kind_guess, s.channel, s.state, s.videos, s.ups,
      FIXED_TS, FIXED_TS, JSON.stringify(s.evidence_usages), FIXED_TS, FIXED_TS,
    )
    n++
  }
  const total = (db.prepare('SELECT COUNT(*) AS n FROM candidates').get() as { n: number }).n
  db.close()
  if (total !== seeds.length) throw new Error(`写入 ${total} 行 ≠ seed ${seeds.length}`)
  return n
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)
if (isMain) {
  const arg = process.argv[2]
  if (arg === '--export') {
    exportSeed()
  } else if (arg === '--db') {
    const n = seedRunDb(process.argv[3]!)
    console.log(`已写入 ${n} 条候选 → ${process.argv[3]}`)
  } else {
    console.error('用法: npx tsx scripts/curator-seed.ts --export | --db <path>')
    process.exitCode = 2
  }
}
