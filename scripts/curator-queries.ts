/** curator-v1 查询集：合并出题片段 + 机械校验。
 *
 *   merge  读 authoring/frag-T1..T6.jsonl → 重编号 → queries.jsonl
 *   check  对 queries.jsonl 跑全部机械检查（金标合法性/包含关系/去重/覆盖/配对）
 *
 * 校验以 v4 labels.jsonl 为权威：family 集合、候选 cid、每家族金标形式。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_ROOT, QUERIES_FILE, loadGold, readJsonl, positiveContains, negativeViolations } from './curator-lib.ts'

export interface Query {
  query_id: string
  channel: string
  text: string
  ctx: string[] | null
  expect: { hit: boolean; family: string | null }
  from_candidate: string | null
  tags: string[]
}

const CHANNELS = ['phrase', 'formula', 'interaction', 'conditional']

function validateShape(q: unknown, where: string): Query {
  const o = q as Record<string, unknown>
  const errs: string[] = []
  for (const key of ['query_id', 'channel', 'text', 'ctx', 'expect', 'from_candidate', 'tags']) {
    if (!(key in o)) errs.push(`缺字段 ${key}`)
  }
  if (errs.length) throw new Error(`${where}: ${errs.join('; ')}`)
  const expect = o.expect as { hit?: unknown; family?: unknown }
  if (typeof expect?.hit !== 'boolean') errs.push('expect.hit 必须是 boolean')
  if (typeof o.text !== 'string') errs.push('text 必须是 string')
  if (!CHANNELS.includes(o.channel as string)) errs.push(`channel 非法: ${o.channel}`)
  if (o.ctx !== null && !Array.isArray(o.ctx)) errs.push('ctx 必须是 null 或 string[]')
  if (!Array.isArray(o.tags)) errs.push('tags 必须是 string[]')
  if (errs.length) throw new Error(`${where}: ${errs.join('; ')}`)
  return o as unknown as Query
}

export function mergeFragments(): void {
  const dir = `${BENCH_ROOT}/authoring`
  const frags = readdirSync(dir).filter((f) => /^frag-T\d+\.jsonl$/.test(f)).sort()
  if (!frags.length) throw new Error(`${dir} 下没有 frag-T*.jsonl`)
  const all: Query[] = []
  for (const f of frags) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim())
    lines.forEach((line, i) => {
      try {
        all.push(validateShape(JSON.parse(line), `${f}:${i + 1}`))
      } catch (e) {
        throw new Error(`${f}:${i + 1} ${(e as Error).message}`)
      }
    })
    console.log(`${f}: ${lines.length} 条`)
  }
  // 重编号：q-0001..（保持片段顺序）
  const renumbered = all.map((q, i) => ({ ...q, query_id: `q-${String(i + 1).padStart(4, '0')}` }))
  writeFileSync(QUERIES_FILE, renumbered.map((q) => JSON.stringify(q)).join('\n') + '\n', 'utf8')
  console.log(`queries.jsonl 已写入：${renumbered.length} 条（${frags.join(' + ')}）`)
}

export function checkQueries(path = QUERIES_FILE): boolean {
  const gold = loadGold()
  const allForms: Array<{ form: string; family: string }> = []
  for (const [f, forms] of gold.familyForms) for (const form of forms) allForms.push({ form, family: f })
  const qs = readJsonl<Query>(path)
  const errors: string[] = []
  const warnings: string[] = []
  const err = (m: string) => errors.push(m)
  const warn = (m: string) => warnings.push(m)

  const seen = new Map<string, Query>()
  const perFamily = new Map<string, { pos: number; neg: number; hard: number; queries: Query[] }>()
  const noiseCoverage = new Map<string, number>()
  const constraintNegatives: string[] = []

  for (const q of qs) {
    const tag = q.query_id
    const fullText = [q.text, ...(q.ctx ?? [])].join('\n')
    // 基本形状
    if (q.expect.hit) {
      if (!q.expect.family) err(`${tag}: 正例缺 expect.family`)
      else if (!gold.families.includes(q.expect.family)) err(`${tag}: family 非法 ${q.expect.family}`)
      if (!q.from_candidate) err(`${tag}: 正例缺 from_candidate`)
      else {
        const info = gold.byCid.get(q.from_candidate)
        if (!info) err(`${tag}: from_candidate 不在 72 候选内 ${q.from_candidate}`)
        else if (q.expect.family && !info.families.includes(q.expect.family)) {
          err(`${tag}: from_candidate ${q.from_candidate} 属 [${info.families.join(',')}] ≠ expect.family ${q.expect.family}`)
        }
      }
      // 正例 containment：词法层只扫末行 text；conditional/interaction 通道的触发形式允许落在 ctx
      const forms = q.expect.family ? gold.familyForms.get(q.expect.family) ?? [] : []
      const ctxOk = q.channel === 'conditional' || q.channel === 'interaction'
      const hitInText = forms.length > 0 && positiveContains(q.text, forms)
      const hitInCtx = ctxOk && (q.ctx ?? []).some((line) => positiveContains(line, forms))
      if (forms.length && !hitInText && !hitInCtx) {
        err(`${tag}: 正例 text${ctxOk ? '/ctx' : ''} 不含家族 ${q.expect.family} 任何金标形式`)
      }
    } else {
      // 负例：不得含任何家族任何非槽形式；constraint-dependent 负例显式豁免（满分库须用约束/交互词条兜住）
      const viols = negativeViolations(fullText, allForms.map((a) => a.form))
      if (viols.length) {
        const detail = viols.map((v) => `${v}(${allForms.find((a) => a.form === v)?.family})`).join(',')
        if (q.tags.includes('constraint-dependent')) constraintNegatives.push(`${tag}: ${detail}`)
        else err(`${tag}: 负例含金标形式 ${detail}`)
      }
      if (q.expect.family && !gold.families.includes(q.expect.family)) {
        err(`${tag}: family 非法 ${q.expect.family}`)
      }
      if (q.from_candidate) {
        const info = gold.byCid.get(q.from_candidate)
        if (!info) err(`${tag}: from_candidate 不在 72 候选内 ${q.from_candidate}`)
        else if (info.verdict === 'not-meme') {
          // 噪音候选的负例（含家族负例取材于噪音候选的情况）：计入该候选的噪音覆盖
          noiseCoverage.set(q.from_candidate, (noiseCoverage.get(q.from_candidate) ?? 0) + 1)
        } else if (q.expect.family && !info.families.includes(q.expect.family)) {
          err(`${tag}: from_candidate ${q.from_candidate} 属 [${info.families.join(',')}] ≠ expect.family ${q.expect.family}`)
        }
      } else if (!q.expect.family) {
        err(`${tag}: 负例既无 from_candidate 也无 expect.family（噪音负例需 from_candidate，家族负例需 family）`)
      }
    }
    // channel/ctx 匹配
    if ((q.channel === 'interaction' || q.channel === 'conditional') && !q.ctx) {
      err(`${tag}: ${q.channel} 必须带 ctx`)
    }
    if ((q.channel === 'phrase' || q.channel === 'formula') && q.ctx) {
      err(`${tag}: ${q.channel} 不应带 ctx`)
    }
    if (q.text.length < 2 || q.text.length > 60) warn(`${tag}: text 长度异常（${q.text.length}）`)
    const unknownTags = q.tags.filter((t) => !['canonical', 'hard', 'pair', 'noise'].includes(t))
    if (unknownTags.length) warn(`${tag}: 自由标签 ${unknownTags.join(',')}（允许，仅提示）`)
    // 查重
    const key = q.text + '\u0000' + (q.ctx?.join('|') ?? '')
    if (seen.has(key)) err(`${tag}: 与 ${seen.get(key)!.query_id} 的 (text,ctx) 完全相同`)
    seen.set(key, q)
    // 覆盖统计
    if (q.expect.family) {
      const st = perFamily.get(q.expect.family) ?? { pos: 0, neg: 0, hard: 0, queries: [] }
      if (q.expect.hit) st.pos++
      else {
        st.neg++
        if (q.tags.includes('hard')) st.hard++
      }
      st.queries.push(q)
      perFamily.set(q.expect.family, st)
    }
  }

  // 覆盖检查
  for (const f of gold.families) {
    const st = perFamily.get(f)
    if (!st) {
      err(`家族 ${f}: 零覆盖`)
      continue
    }
    if (st.pos < 2) err(`家族 ${f}: 正例 ${st.pos} < 2`)
    if (st.neg < 3) err(`家族 ${f}: 负例 ${st.neg} < 3`)
    if (st.hard < 2) err(`家族 ${f}: 硬负例 ${st.hard} < 2`)
    if (st.pos + st.neg < 5) err(`家族 ${f}: 总数 ${st.pos + st.neg} < 5`)
  }
  for (const cid of gold.noiseCids) {
    const n = noiseCoverage.get(cid) ?? 0
    if (n < 2) err(`噪音候选 ${cid}（${gold.byCid.get(cid)?.head}）: 负例 ${n} < 2`)
  }
  if (qs.length < 200 || qs.length > 400) err(`总量 ${qs.length} 不在 200–400`)

  // 同文异境 pair 统计：同一 text 出现在 ≥2 条查询
  const byText = new Map<string, Query[]>()
  for (const q of qs) byText.set(q.text, [...(byText.get(q.text) ?? []), q])
  const pairGroups = [...byText.values()].filter((g) => g.length >= 2)
  for (const g of pairGroups) {
    const mixed = g.some((q) => q.ctx) && g.some((q) => !q.ctx)
    if (mixed) warn(`同文异境组 "${g[0].text.slice(0, 20)}…"：${g.length} 条中 ctx 有无不一致（合法但请确认成对设计）`)
  }

  // 报告
  console.log(`\n=== 校验报告（${path}） ===`)
  console.log(`总查询 ${qs.length}；家族 ${gold.families.length} 个；同文异境组 ${pairGroups.length} 组`)
  const famRows = [...perFamily.entries()].map(([f, st]) => `${f}:${st.pos}正/${st.neg}负(${st.hard}硬)`).join('  ')
  console.log(`逐家族：${famRows}`)
  console.log(`噪音覆盖：${noiseCoverage.size}/${gold.noiseCids.length} 个候选有负例`)
  if (constraintNegatives.length) {
    console.log(`约束依赖负例 ${constraintNegatives.length} 条（含金标形式但声明依赖满分库约束/交互词条兜住）：`)
    for (const c of constraintNegatives) console.log(`  ◆ ${c}`)
  }
  if (warnings.length) {
    console.log(`\n警告 ${warnings.length} 条：`)
    for (const w of warnings) console.log(`  ⚠ ${w}`)
  }
  if (errors.length) {
    console.log(`\n错误 ${errors.length} 条：`)
    for (const e of errors) console.log(`  ✗ ${e}`)
    return false
  }
  console.log('\n全部机械检查通过 ✓')
  return true
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)
if (isMain) {
  const cmd = process.argv[2]
  if (cmd === 'merge') mergeFragments()
  else if (cmd === 'check') {
    const ok = checkQueries(process.argv[3] ?? QUERIES_FILE)
    if (!ok) process.exitCode = 1
  } else {
    console.error('用法: npx tsx scripts/curator-queries.ts merge | check [path]')
    process.exitCode = 2
  }
}
