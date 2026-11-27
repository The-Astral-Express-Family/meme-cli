/** curator-v1 基准共享库：路径、v4 金标加载、词条归属（judge/score/perfect 共用）。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeHead } from '../src/detect/evidence.ts'

export const BENCH_ROOT = 'benchmarks/curator-v1'
export const V4_DIR = 'benchmarks/candidate-judgment-v4'
export const QUERIES_FILE = `${BENCH_ROOT}/queries.jsonl`
export const SEED_FILE = `${BENCH_ROOT}/seed/candidates.jsonl`
export const RUNS_DIR = `${BENCH_ROOT}/runs`
export const AGENT_PROMPT_FILE = `${BENCH_ROOT}/agent-prompt.md`

export const CHANNELS = ['phrase', 'formula', 'interaction', 'conditional'] as const
export type Channel = (typeof CHANNELS)[number]

/** 种子候选白名单字段（设计 §5）：多出的字段一律拒绝导入。 */
export const SEED_FIELDS = [
  'cid', 'head', 'channel', 'kind_guess', 'state', 'videos', 'ups', 'evidence_usages',
] as const

/** 金标字段：种子候选里一个都不能出现（自动扫描）。 */
export const FORBIDDEN_KEYS = [
  'candidate_verdict', 'resolved_verdict', 'family_id', 'canonical_head',
  'accepted_canonical_forms', 'rationale',
] as const

export interface LabelRow {
  case_id: string
  source_cid: string
  candidate_verdict: 'meme' | 'not-meme' | 'conditional'
  resolved_verdict: 'meme' | 'not-meme'
  family_id: string | null
  canonical_head: string | null
  accepted_canonical_forms: string[]
  rationale: string
}

export interface CidInfo {
  cid: string
  head: string
  verdict: LabelRow['candidate_verdict']
  /** 该候选指向的全部金标家族（个别候选的证据支撑两个家族，如 c_70855） */
  families: string[]
  forms: string[]
}

export interface GoldData {
  rows: LabelRow[]
  byCid: Map<string, CidInfo>
  families: string[]
  /** family → 该家族全部候选 cid */
  familyCids: Map<string, string[]>
  /** family → 金标形式全集（含 canonical_head，去重保序） */
  familyForms: Map<string, string[]>
  /** cid → 家族列表（familyCids 的反向索引） */
  familiesOfCid: Map<string, string[]>
  noiseCids: string[]
}

export function readJsonl<T>(path: string): T[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
  return lines.map((l, i) => {
    try {
      return JSON.parse(l) as T
    } catch (e) {
      throw new Error(`${path}:${i + 1} JSON 解析失败: ${(e as Error).message}`)
    }
  })
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 加载 v4 金标（评测专用数据，答题 agent 不可见）。 */
export function loadGold(): GoldData {
  const rows = readJsonl<LabelRow>(`${V4_DIR}/labels.jsonl`)
  const byCid = new Map<string, CidInfo>()
  const familyCids = new Map<string, string[]>()
  const familyForms = new Map<string, string[]>()
  const familiesOfCid = new Map<string, string[]>()
  const families: string[] = []
  const noiseCids: string[] = []
  for (const r of rows) {
    const forms = [...new Set([r.canonical_head, ...r.accepted_canonical_forms].filter((f): f is string => !!f))]
    const info = byCid.get(r.source_cid)
    if (info) {
      // 同 cid 多行（c_70855 被拆成两个 case）：head/verdict 取首行，家族与形式取并集
      if (r.family_id && !info.families.includes(r.family_id)) info.families.push(r.family_id)
      for (const f of forms) if (!info.forms.includes(f)) info.forms.push(f)
    } else {
      byCid.set(r.source_cid, {
        cid: r.source_cid,
        head: r.canonical_head ?? '',
        verdict: r.candidate_verdict,
        families: r.family_id ? [r.family_id] : [],
        forms,
      })
      if (r.candidate_verdict === 'not-meme') noiseCids.push(r.source_cid)
    }
    if (r.family_id) {
      if (!families.includes(r.family_id)) families.push(r.family_id)
      const cids = familyCids.get(r.family_id) ?? []
      if (!cids.includes(r.source_cid)) cids.push(r.source_cid)
      familyCids.set(r.family_id, cids)
      const fs = familyForms.get(r.family_id) ?? []
      for (const f of forms) if (!fs.includes(f)) fs.push(f)
      familyForms.set(r.family_id, fs)
      const fc = familiesOfCid.get(r.source_cid) ?? []
      if (!fc.includes(r.family_id)) fc.push(r.family_id)
      familiesOfCid.set(r.source_cid, fc)
    }
  }
  return { rows, byCid, families, familyCids, familyForms, familiesOfCid, noiseCids }
}

/** 判定文本里是否出现金标形式。纯 ASCII/数字 ≤4 字符的形式按整词边界（防 NBA 吃掉 nb）。 */
export function containsForm(rawText: string, form: string): boolean {
  const norm = form.trim().toLowerCase().replace(/\s+/g, '')
  if (!norm) return false
  const stripped = rawText.toLowerCase().replace(/\s+/g, '')
  if (/^[a-z0-9]{1,4}$/.test(norm)) {
    // 整词边界：字母数字两侧不得紧邻字母数字
    const re = new RegExp(`(?<![a-z0-9])${norm}(?![a-z0-9])`, 'i')
    return re.test(rawText)
  }
  return stripped.includes(norm)
}

/** 槽位形式拆 prefix/suffix：「天不生<X>万古如长夜」→ 天不生 + 万古如长夜。 */
export function slotFormParts(form: string): { prefix: string; suffix: string } | null {
  const m = form.match(/^(.*)<[^>]+>(.*)$/)
  if (!m) return null
  return { prefix: m[1].trim(), suffix: m[2].trim() }
}

/** 正例 containment：非槽形式直接查；槽形式查 prefix+suffix 都在。 */
export function positiveContains(raw: string, forms: string[]): boolean {
  const hay = raw.toLowerCase().replace(/\s+/g, '')
  for (const f of forms) {
    if (slotFormParts(f)) {
      const p = slotFormParts(f)!
      const pre = p.prefix.toLowerCase().replace(/\s+/g, '')
      const suf = p.suffix.toLowerCase().replace(/\s+/g, '')
      if (suf && hay.includes(suf) && (!pre || hay.includes(pre))) return true
    } else if (containsForm(raw, f)) {
      return true
    }
  }
  return false
}

/** 负例 violation 检查：只查非槽形式（槽形式实例化后过宽，会误伤一切负例）。 */
export function negativeViolations(raw: string, allForms: string[]): string[] {
  const hits: string[] = []
  for (const f of allForms) {
    if (slotFormParts(f)) continue
    if (containsForm(raw, f)) hits.push(f)
  }
  return hits
}

// ---- 词条归属（设计 §4.1：--cid 关联优先，词条名与候选 head 字面相等兜底）----

export type Attribution =
  | { kind: 'family'; family: string; via: 'cid' | 'name' }
  | { kind: 'cross'; families: string[] }
  | { kind: 'none' }

export interface MemeInfo { id: string; name: string }

export interface DbAttribution {
  /** meme_id → 归属 */
  byMeme: Map<string, Attribution>
  /** meme_id → 关联到的全部 cid（related ∪ 名字兜底） */
  cidsOf: Map<string, string[]>
  /** 由噪音候选建出来的 meme（关联 cid 全部 family=null）——noise 失败标签用 */
  noiseMemes: Set<string>
  /** 被误封的家族（存在 cid state=rejected 且 reject_reason=banned） */
  bannedFamilies: Set<string>
}

/** 从冻结库构建词条归属表。gold：v4 金标。 */
export function buildAttribution(db: DatabaseSync, gold: GoldData): DbAttribution {
  const candRows = db.prepare('SELECT cid, head, state, reject_reason, related FROM candidates').all() as Array<{
    cid: string; head: string; state: string; reject_reason: string | null; related: string
  }>
  const memeRows = db.prepare('SELECT id, name, aliases FROM memes').all() as unknown as Array<MemeInfo & { aliases: string }>

  const relatedCids = new Map<string, string[]>()
  for (const c of candRows) {
    let rel: Array<{ id: string }> = []
    try { rel = JSON.parse(c.related || '[]') } catch { rel = [] }
    for (const r of rel) {
      const arr = relatedCids.get(r.id) ?? []
      if (!arr.includes(c.cid)) arr.push(c.cid)
      relatedCids.set(r.id, arr)
    }
  }
  // 名字兜底：词条名与任一有家族的候选 head 归一化后字面相等
  const headToCids = new Map<string, string[]>()
  for (const c of candRows) {
    if (!(gold.familiesOfCid.get(c.cid)?.length)) continue
    const key = normalizeHead(c.head)
    const arr = headToCids.get(key) ?? []
    if (!arr.includes(c.cid)) arr.push(c.cid)
    headToCids.set(key, arr)
  }

  const byMeme = new Map<string, Attribution>()
  const cidsOf = new Map<string, string[]>()
  const noiseMemes = new Set<string>()
  for (const m of memeRows) {
    const viaCid = relatedCids.get(m.id) ?? []
    const viaName = headToCids.get(normalizeHead(m.name)) ?? []
    const cids = [...new Set([...viaCid, ...viaName])]
    cidsOf.set(m.id, cids)
    let fams = [...new Set(cids.flatMap((c) => gold.familiesOfCid.get(c) ?? []))]
    // 少数候选指向多个家族（c_70855 的证据同时支撑 x-da-xue-xi 与 325-event 两个金标家族）：
    // 按词条名收窄——词条名（含别名）命中哪个家族的金标形式，就归属哪个家族；仍不唯一才判跨家族。
    if (fams.length > 1) {
      let aliases: string[] = []
      try { aliases = JSON.parse(m.aliases || '[]') } catch { aliases = [] }
      const normed = [m.name, ...aliases].map((n) => n.toLowerCase().replace(/\s+/g, ''))
      const narrowed = fams.filter((f) => (gold.familyForms.get(f) ?? []).some((form) => normed.includes(form.toLowerCase().replace(/\s+/g, ''))))
      if (narrowed.length) fams = narrowed
    }
    if (fams.length === 1) byMeme.set(m.id, { kind: 'family', family: fams[0], via: viaCid.length ? 'cid' : 'name' })
    else if (fams.length >= 2) byMeme.set(m.id, { kind: 'cross', families: fams })
    else {
      byMeme.set(m.id, { kind: 'none' })
      // 全部关联 cid 都是无家族候选（或无关联）→ 由噪音候选建出来的词条
      if (cids.length && cids.every((c) => !(gold.familiesOfCid.get(c)?.length))) noiseMemes.add(m.id)
    }
  }
  const bannedFamilies = new Set<string>()
  for (const c of candRows) {
    if (c.state === 'rejected' && c.reject_reason === 'banned') {
      for (const f of gold.familiesOfCid.get(c.cid) ?? []) bannedFamilies.add(f)
    }
  }
  return { byMeme, cidsOf, noiseMemes, bannedFamilies }
}

export function jsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}
