/**
 * OJ lookup benchmark 评分器（评估专用，不进入运行时）。
 *
 * 逐 case 判定（期望来自 cases.jsonl 的 expect）：
 * - 正例命中目标家族且未命中任何 forbid 家族 → TP；否则 FN；
 * - 负例未命中任何 forbid 家族 → TN；命中 → FP；
 * - 其余命中（非目标/非 forbid 家族）记"额外无关命中"，单独统计，不进主混淆矩阵。
 * 报告 Overall + phrase/formula/interaction/conditional 四组；公式组补替换成功率
 * （正例 TP 占比），conditional 组补上下文区分率（组内准确率）。
 * tag 含 slot-literal-hard / literal 的失分单独列出（matcher 已知硬负例）。
 *
 * 用法：
 *   npx tsx scripts/oj-score.ts                       # 评 outputs/ 下全部运行
 *   npx tsx scripts/oj-score.ts --format json --output benchmarks/oj-lookup-v1/report.json
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_DATASET = join(ROOT, 'benchmarks', 'oj-lookup-v1')

interface CaseRow {
  id: string
  channel: 'phrase' | 'formula' | 'interaction' | 'conditional'
  family: string
  entry_ref: string
  input: { text: string; ctx?: string[] }
  expect: { hit: boolean; family?: string; forbid?: string[] }
  tags: string[]
  note?: string
}
interface OutputRow {
  case_id: string
  hit: boolean
  families: Array<string | { family: string; name?: string; confidence?: number; method?: string }>
}

interface CaseScore {
  case_id: string
  channel: string
  entry_ref: string
  verdict: 'TP' | 'FP' | 'FN' | 'TN'
  expected_family: string | null
  hit_families: string[]
  forbid_hit: string[]
  extra_hits: string[]
  hard_negative: boolean
  text: string
}

export interface RunScore {
  model: string
  total: number
  tp: number
  fp: number
  fn: number
  tn: number
  accuracy: number
  precision: number
  recall: number
  f1: number
  extra_hits: number
  hard_negative_errors: number
  channels: Record<string, { total: number; tp: number; fp: number; fn: number; tn: number; accuracy: number }>
  /** 公式通道正例召回（= 替换成立的比例；负例另算 FP）。 */
  formula_recall: number
  /** 公式正例按槽位标签分组：同类替换 / 跨域替换 / 多词 / 多槽 / 标点。 */
  formula_by_tag: Record<string, { total: number; tp: number; accuracy: number }>
  /** 同文异境成对：同一句文本分别以命中/不命中语境出现，两者都判对才算数。 */
  paired_context: { pairs: number; correct: number; accuracy: number }
  failed_cases: CaseScore[]
}

export interface OJReport {
  dataset_id: string
  case_count: number
  models: RunScore[]
}

function sha256(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
}

function readJsonl<T>(file: string): T[] {
  const text = readFileSync(file, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line, i) => {
    try { return JSON.parse(line) as T } catch (e) {
      throw new Error(`${file}:${i + 1} JSON 解析失败：${e instanceof Error ? e.message : e}`)
    }
  })
}

export function loadOJDataset(root: string = DEFAULT_DATASET): { manifest: Record<string, unknown>; cases: CaseRow[] } {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    hashes: Record<string, string>
    case_count: number
    dataset_id: string
  }
  for (const [file, expected] of Object.entries(manifest.hashes)) {
    const actual = sha256(readFileSync(join(root, file), 'utf8'))
    if (actual !== expected) throw new Error(`manifest 哈希不匹配：${file}`)
  }
  const cases = readJsonl<CaseRow>(join(root, 'cases.jsonl'))
  if (cases.length !== manifest.case_count) throw new Error(`case_count 不匹配：manifest=${manifest.case_count} cases=${cases.length}`)
  const ids = new Set(cases.map((c) => c.id))
  if (ids.size !== cases.length) throw new Error('cases 含重复 id')
  return { manifest, cases }
}

/** 模型作答的 families 允许字符串数组或对象数组，统一成家族字符串数组。 */
function familyStrings(families: OutputRow['families']): string[] {
  return families.map((f) => typeof f === 'string' ? f : f.family).filter(Boolean)
}

export function scoreRun(cases: CaseRow[], model: string, outputs: OutputRow[]): RunScore {
  const outById = new Map(outputs.map((o) => [o.case_id, o]))
  const missing = cases.filter((c) => !outById.has(c.id))
  const unknown = outputs.filter((o) => !cases.some((c) => c.id === o.case_id))
  if (missing.length || unknown.length) {
    throw new Error(`${model} 输出对不齐：缺 ${missing.length} 题（${missing.slice(0, 3).map((c) => c.id).join(',')}），未知 ${unknown.length} 题（${unknown.slice(0, 3).map((o) => o.case_id).join(',')}）`)
  }
  const score: RunScore = {
    model, total: cases.length, tp: 0, fp: 0, fn: 0, tn: 0,
    accuracy: 0, precision: 0, recall: 0, f1: 0,
    extra_hits: 0, hard_negative_errors: 0,
    channels: {}, formula_recall: 0, formula_by_tag: {}, paired_context: { pairs: 0, correct: 0, accuracy: 0 },
    failed_cases: [],
  }
  const chOf = (ch: string): { total: number; tp: number; fp: number; fn: number; tn: number; accuracy: number } => {
    if (!score.channels[ch]) score.channels[ch] = { total: 0, tp: 0, fp: 0, fn: 0, tn: 0, accuracy: 0 }
    return score.channels[ch]
  }
  const safeDiv = (a: number, b: number): number => b ? a / b : 0
  const verdictOf = new Map<string, CaseScore['verdict']>()
  for (const c of cases) {
    const o = outById.get(c.id)!
    const hitFamilies = familyStrings(o.families)
    const forbid = new Set(c.expect.forbid ?? [])
    const forbidHit = hitFamilies.filter((f) => forbid.has(f))
    const expectedHit = c.expect.hit && c.expect.family ? hitFamilies.includes(c.expect.family) : false
    const extra = hitFamilies.filter((f) => f !== c.expect.family && !forbid.has(f))
    score.extra_hits += extra.length
    let verdict: CaseScore['verdict']
    if (c.expect.hit) {
      if (expectedHit && !forbidHit.length) { verdict = 'TP'; score.tp++; chOf(c.channel).tp++ }
      else {
        verdict = 'FN'; score.fn++; chOf(c.channel).fn++
        if (c.tags.includes('slot-literal-hard') || c.tags.includes('literal')) score.hard_negative_errors++
      }
    } else {
      if (!forbidHit.length) { verdict = 'TN'; score.tn++; chOf(c.channel).tn++ }
      else {
        verdict = 'FP'; score.fp++; chOf(c.channel).fp++
        if (c.tags.includes('slot-literal-hard') || c.tags.includes('literal')) score.hard_negative_errors++
      }
    }
    chOf(c.channel).total++
    verdictOf.set(c.id, verdict)
    if (verdict === 'TP' || verdict === 'TN') chOf(c.channel).accuracy = safeDiv(chOf(c.channel).tp + chOf(c.channel).tn, chOf(c.channel).total)
    if (verdict !== 'TP' && verdict !== 'TN') {
      score.failed_cases.push({
        case_id: c.id, channel: c.channel, entry_ref: c.entry_ref, verdict,
        expected_family: c.expect.family ?? null, hit_families: hitFamilies,
        forbid_hit: forbidHit, extra_hits: extra,
        hard_negative: c.tags.includes('slot-literal-hard') || c.tags.includes('literal'),
        text: c.input.text,
      })
    }
  }
  for (const ch of Object.values(score.channels)) ch.accuracy = safeDiv(ch.tp + ch.tn, ch.total)
  const precision = safeDiv(score.tp, score.tp + score.fp)
  const recall = safeDiv(score.tp, score.tp + score.fn)
  score.precision = precision
  score.recall = recall
  score.f1 = safeDiv(2 * precision * recall, precision + recall)
  score.accuracy = safeDiv(score.tp + score.tn, score.total)
  score.formula_recall = formulaRecall(cases, verdictOf)
  score.formula_by_tag = formulaByTag(cases, verdictOf)
  score.paired_context = pairedContext(cases, verdictOf)
  return score
}

/** 公式通道正例召回：TP / 正例数（负例由整体 FP 与通道准确率承担）。 */
function formulaRecall(cases: CaseRow[], verdictOf: Map<string, CaseScore['verdict']>): number {
  const pos = cases.filter((c) => c.channel === 'formula' && c.expect.hit)
  return pos.length ? pos.filter((c) => verdictOf.get(c.id) === 'TP').length / pos.length : 0
}

/** 公式正例的替换类型分组：一条题只归入优先级最高的一个槽位标签，组间不重叠。 */
const SLOT_TAGS = ['slot-same-domain', 'slot-cross-domain', 'multi-slot', 'slot-multi-word', 'punctuation'] as const

function formulaByTag(
  cases: CaseRow[], verdictOf: Map<string, CaseScore['verdict']>,
): Record<string, { total: number; tp: number; accuracy: number }> {
  const out: Record<string, { total: number; tp: number; accuracy: number }> = {}
  const pos = cases.filter((c) => c.channel === 'formula' && c.expect.hit)
  for (const tag of SLOT_TAGS) out[tag] = { total: 0, tp: 0, accuracy: 0 }
  for (const c of pos) {
    const tag = SLOT_TAGS.find((t) => c.tags.includes(t))
    if (!tag) continue
    out[tag].total += 1
    if (verdictOf.get(c.id) === 'TP') out[tag].tp += 1
  }
  for (const v of Object.values(out)) v.accuracy = v.total ? v.tp / v.total : 0
  return out
}

/**
 * 同文异境成对：同一句文本既出现在"该命中"语境，也出现在"不该命中"语境。
 * 只判对其中一边不算区分成功——这类样本正是 conditional/交互要证明的能力。
 */
function pairedContext(
  cases: CaseRow[], verdictOf: Map<string, CaseScore['verdict']>,
): { pairs: number; correct: number; accuracy: number } {
  const groups = new Map<string, CaseRow[]>()
  for (const c of cases) {
    const key = c.input.text
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  let pairs = 0
  let correct = 0
  for (const rows of groups.values()) {
    if (rows.length < 2) continue
    if (!rows.some((r) => r.expect.hit) || !rows.some((r) => !r.expect.hit)) continue
    pairs += 1
    const ok = rows.every((r) => {
      const v = verdictOf.get(r.id)
      return v === 'TP' || v === 'TN'
    })
    if (ok) correct += 1
  }
  return { pairs, correct, accuracy: pairs ? correct / pairs : 0 }
}

export function scoreOJDataset(root: string = DEFAULT_DATASET): OJReport {
  const { manifest, cases } = loadOJDataset(root)
  const outDir = join(root, 'outputs')
  const models: RunScore[] = []
  if (existsSync(outDir)) {
    const runs: Array<{ name: string; model: string; order: number; file: string }> = []
    for (const name of readdirSync(outDir)) {
      const file = join(outDir, name, 'output.jsonl')
      if (!existsSync(file)) continue
      const meta = JSON.parse(readFileSync(join(outDir, name, 'meta.json'), 'utf8')) as { model?: string; run_order?: number }
      runs.push({ name, model: meta.model ?? name, order: meta.run_order ?? 999, file })
    }
    runs.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    for (const run of runs) models.push(scoreRun(cases, run.model, readJsonl<OutputRow>(run.file)))
  }
  return { dataset_id: String(manifest.dataset_id), case_count: cases.length, models }
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

export function renderOJMarkdown(report: OJReport): string {
  const lines = [
    `# ${report.dataset_id} 行为评分报告`,
    '',
    `案例数：${report.case_count}；运行数：${report.models.length}。TP/TN/FP/FN 按 forbid 家族判定；额外无关命中单独统计。`,
  ]
  if (!report.models.length) {
    lines.push('', '暂无运行输出。先跑 `npx tsx scripts/oj-run.ts`（系统行）或模型作答，再评分。')
    return lines.join('\n') + '\n'
  }
  lines.push(
    '',
    '| 运行 | 准确率 | Precision | Recall | F1 | 额外命中 | 已知硬负例失分 | 公式正例召回 | 同文异境成对 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const m of report.models) {
    const pair = m.paired_context.pairs ? `${pct(m.paired_context.accuracy)}（${m.paired_context.correct}/${m.paired_context.pairs}）` : '无成对样本'
    lines.push(`| ${m.model} | ${pct(m.accuracy)} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${m.extra_hits} | ${m.hard_negative_errors} | ${pct(m.formula_recall)} | ${pair} |`)
  }
  // 公式替换按槽位类型拆开：同类替换会做、跨域替换不会做，是两类不同的失败。
  const tagNames = Object.keys(report.models[0].formula_by_tag)
  if (tagNames.length) {
    lines.push('', '## 公式替换分组（正例召回）', '', '| 运行 | ' + tagNames.join(' | ') + ' |', '| --- | ' + tagNames.map(() => '---').join(' | ') + ' |')
    for (const m of report.models) {
      lines.push(`| ${m.model} | ${tagNames.map((t) => {
        const g = m.formula_by_tag[t]
        return g && g.total ? `${pct(g.accuracy)}（${g.tp}/${g.total}）` : '—'
      }).join(' | ')} |`)
    }
  }
  const channelNames = Object.keys(report.models[0].channels)
  lines.push('', '## 分通道', '', '| 运行 | ' + channelNames.join(' | ') + ' |', '| --- | ' + channelNames.map(() => '---').join(' | ') + ' |')
  for (const m of report.models) {
    lines.push(`| ${m.model} | ${channelNames.map((ch) => {
      const c = m.channels[ch]
      return c ? pct(c.accuracy) : '—'
    }).join(' | ')} |`)
  }
  for (const m of report.models) {
    lines.push('', `## ${m.model} 失败 case（${m.failed_cases.length}）`, '', '| case | 通道 | 词条 | 判定 | 期望家族 | 实际命中 | 标签句 |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const f of m.failed_cases) {
      lines.push(`| ${f.case_id} | ${f.channel} | ${f.entry_ref} | ${f.verdict} | ${f.expected_family ?? '—'} | ${f.hit_families.join(',') || '（无）'} | ${f.text.slice(0, 40)} |`)
    }
  }
  return lines.join('\n') + '\n'
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const report = scoreOJDataset(resolve(flag('--dataset', DEFAULT_DATASET)))
  const format = flag('--format', 'markdown')
  const text = format === 'json' ? JSON.stringify(report, null, 2) + '\n' : renderOJMarkdown(report)
  const output = flag('--output', '')
  if (output) {
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, text)
  } else process.stdout.write(text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
