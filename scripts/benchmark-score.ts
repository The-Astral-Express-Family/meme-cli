/**
 * 候选判定 benchmark 的离线评分器（评估专用，不进入运行时）。
 *
 * 用法：
 *   npx tsx scripts/benchmark-score.ts
 *   npx tsx scripts/benchmark-score.ts --format markdown --output benchmarks/candidate-judgment-v1/report.md
 *
 * 评分刻意分两层：
 * - candidate_verdict：候选词头本身是否立为梗（截断头/宿主词在这里可以是 not-meme）；
 * - family/canonical：证据属于哪个家族、完整形是什么（“拒绝爆但没补出爆了”不会得到完整形分）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_DATASET = join(ROOT, 'benchmarks', 'candidate-judgment-v2')

const VerdictSchema = z.enum(['meme', 'not-meme', 'conditional', 'abstain'])
const GoldVerdictSchema = z.enum(['meme', 'not-meme', 'conditional'])

const EvidenceSchema = z.object({
  evidence_id: z.string(),
  text: z.string(),
  aid: z.number(),
  rpid: z.number(),
  mid: z.number(),
  is_reply: z.boolean(),
  is_chain: z.boolean(),
})

const CaseSchema = z.object({
  case_id: z.string(),
  source_cid: z.string(),
  head: z.string(),
  kind_guess: z.string(),
  channel: z.string(),
  state: z.string(),
  videos: z.number(),
  ups: z.number(),
  burst: z.number().nullable(),
  surfs_seen: z.number(),
  related: z.array(z.unknown()),
  sources: z.array(z.object({
    aid: z.number(), title: z.string(), up_name: z.string().nullable(),
  })),
  evidence: z.array(EvidenceSchema),
}).passthrough()

const LabelSchema = z.object({
  case_id: z.string(),
  source_cid: z.string(),
  candidate_verdict: GoldVerdictSchema,
  resolved_verdict: z.enum(['meme', 'not-meme']),
  family_id: z.string().nullable(),
  canonical_head: z.string().nullable(),
  accepted_canonical_forms: z.array(z.string()),
  rationale: z.string(),
}).strict()

const OutputSchema = z.object({
  case_id: z.string(),
  source_cid: z.string(),
  head: z.string(),
  verdict: VerdictSchema,
  family_id: z.string().nullable(),
  canonical_head: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  rationale: z.string(),
  evidence_ids: z.array(z.string()),
}).strict()

const ManifestSchema = z.object({
  dataset_id: z.string(),
  version: z.number(),
  case_count: z.number(),
  hashes: z.record(z.string()),
  labels_are_evaluation_only: z.literal(true),
}).passthrough()

export type BenchmarkCase = z.infer<typeof CaseSchema>
export type BenchmarkLabel = z.infer<typeof LabelSchema>
export type BenchmarkOutput = z.infer<typeof OutputSchema>
export type BenchmarkVerdict = z.infer<typeof VerdictSchema>

export interface Dataset {
  root: string
  manifest: z.infer<typeof ManifestSchema>
  cases: BenchmarkCase[]
  labels: BenchmarkLabel[]
}

export interface CaseScore {
  case_id: string
  source_cid: string
  head: string
  gold_candidate_verdict: 'meme' | 'not-meme' | 'conditional'
  gold_resolved_verdict: 'meme' | 'not-meme'
  output_verdict: BenchmarkVerdict
  candidate_correct: boolean | null
  gold_family: string | null
  output_family: string | null
  family_correct: boolean | null
  gold_canonical: string | null
  output_canonical: string | null
  canonical_correct: boolean | null
  evidence_valid: boolean
  rationale: string
}

export interface ModelScore {
  model: string
  total: number
  decided: number
  abstained: number
  invalid: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number
  recall: number
  f1: number
  accuracy: number
  coverage: number
  conditional_correct: number
  conditional_total: number
  family_tp: number
  family_fp: number
  family_fn: number
  family_precision: number
  family_recall: number
  family_f1: number
  canonical_correct: number
  canonical_total: number
  canonical_accuracy: number
  evidence_invalid: number
  cases: CaseScore[]
}

export interface BenchmarkReport {
  dataset_id: string
  version: number
  case_count: number
  models: ModelScore[]
  agreement: Array<{ a: string; b: string; same: number; total: number; rate: number }>
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')
const norm = (s: string): string => s.trim().toLowerCase()
const safeDiv = (a: number, b: number): number => b ? a / b : 0
const f1 = (precision: number, recall: number): number => safeDiv(2 * precision * recall, precision + recall)

function readJsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  const text = readFileSync(file, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line, i) => {
    let value: unknown
    try { value = JSON.parse(line) } catch (e) {
      throw new Error(`${file}:${i + 1} JSON 解析失败：${e instanceof Error ? e.message : e}`)
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new Error(`${file}:${i + 1} schema 校验失败：${parsed.error.message}`)
    return parsed.data
  })
}

function assertUnique<T extends { case_id: string }>(rows: T[], name: string): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.case_id)) throw new Error(`${name} 含重复 case_id：${row.case_id}`)
    seen.add(row.case_id)
  }
}

export function loadDataset(root: string = DEFAULT_DATASET): Dataset {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')))
  for (const [file, expected] of Object.entries(manifest.hashes)) {
    const path = join(root, file)
    if (!existsSync(path)) throw new Error(`manifest 文件缺失：${file}`)
    const actual = sha256(readFileSync(path))
    if (actual !== expected) throw new Error(`manifest 哈希不匹配：${file}`)
  }
  const cases = readJsonl(join(root, 'cases.jsonl'), CaseSchema)
  const labels = readJsonl(join(root, 'labels.jsonl'), LabelSchema)
  assertUnique(cases, 'cases')
  assertUnique(labels, 'labels')
  if (cases.length !== manifest.case_count || labels.length !== manifest.case_count) {
    throw new Error(`case_count 不匹配：manifest=${manifest.case_count} cases=${cases.length} labels=${labels.length}`)
  }
  const caseIds = new Set(cases.map((c) => c.case_id))
  const labelIds = new Set(labels.map((l) => l.case_id))
  if (caseIds.size !== labelIds.size || [...caseIds].some((id) => !labelIds.has(id))) {
    throw new Error('cases 与 labels 的 case_id 集合不一致')
  }
  const caseById = new Map(cases.map((c) => [c.case_id, c]))
  for (const l of labels) {
    const c = caseById.get(l.case_id)!
    if (l.source_cid !== c.source_cid) throw new Error(`${l.case_id} source_cid 不一致`)
  }
  return { root, manifest, cases, labels }
}

export function validateOutput(dataset: Dataset, outputs: BenchmarkOutput[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  const caseById = new Map(dataset.cases.map((c) => [c.case_id, c]))
  const labelById = new Map(dataset.labels.map((l) => [l.case_id, l]))
  for (const o of outputs) {
    if (seen.has(o.case_id)) errors.push(`重复 case_id：${o.case_id}`)
    seen.add(o.case_id)
    const c = caseById.get(o.case_id)
    const l = labelById.get(o.case_id)
    if (!c) { errors.push(`未知 case_id：${o.case_id}`); continue }
    if (!l) { errors.push(`${o.case_id} 缺金标`); continue }
    if (o.source_cid !== c.source_cid) errors.push(`${o.case_id} source_cid 不一致`)
    if (o.head !== c.head) errors.push(`${o.case_id} head 不一致`)
    const ids = new Set(c.evidence.map((e) => e.evidence_id))
    for (const id of o.evidence_ids) if (!ids.has(id)) errors.push(`${o.case_id} 引用不存在证据：${id}`)
  }
  for (const c of dataset.cases) if (!seen.has(c.case_id)) errors.push(`缺少 case_id：${c.case_id}`)
  return errors
}

function resolvedPrediction(label: BenchmarkLabel, verdict: BenchmarkVerdict): boolean | null {
  if (verdict === 'abstain') return null
  // conditional = 候选词头不能无条件立梗，候选级按否定计；条件题另有 conditional_* 指标。
  return verdict === 'meme'
}

export function scoreModel(dataset: Dataset, model: string, outputs: BenchmarkOutput[]): ModelScore {
  const errors = validateOutput(dataset, outputs)
  if (errors.length) throw new Error(`${model} 输出无效：\n- ${errors.join('\n- ')}`)
  const labelById = new Map(dataset.labels.map((l) => [l.case_id, l]))
  const outById = new Map(outputs.map((o) => [o.case_id, o]))
  const cases: CaseScore[] = []
  let tp = 0, fp = 0, fn = 0, tn = 0, abstained = 0
  let conditionalCorrect = 0, conditionalTotal = 0
  let familyTp = 0, familyFp = 0, familyFn = 0
  let canonicalCorrect = 0, canonicalTotal = 0, evidenceInvalid = 0
  for (const c of dataset.cases) {
    const l = labelById.get(c.case_id)!
    const o = outById.get(c.case_id)!
    const pred = resolvedPrediction(l, o.verdict)
    let candidateCorrect: boolean | null = null
    if (pred === null) abstained++
    else {
      candidateCorrect = pred === (l.resolved_verdict === 'meme')
      if (pred && l.resolved_verdict === 'meme') tp++
      else if (pred && l.resolved_verdict === 'not-meme') fp++
      else if (!pred && l.resolved_verdict === 'meme') fn++
      else tn++
    }
    if (l.candidate_verdict === 'conditional') {
      conditionalTotal++
      if (candidateCorrect) conditionalCorrect++
    }
    let canonicalHit: boolean | null = null
    if (l.canonical_head) {
      canonicalTotal++
      canonicalHit = o.canonical_head != null
        && l.accepted_canonical_forms.some((f) => norm(f) === norm(o.canonical_head!))
      if (canonicalHit) canonicalCorrect++
    }
    // family_id 是模型自起标识，不能用字符串相等判分；以完整形命中作为家族识别依据。
    let familyCorrect: boolean | null = null
    if (l.family_id) {
      familyCorrect = canonicalHit === true
      if (familyCorrect) familyTp++
      else { familyFn++; if (o.family_id || o.canonical_head) familyFp++ }
    } else if (o.family_id || o.canonical_head) familyFp++
    const ids = new Set(c.evidence.map((e) => e.evidence_id))
    const valid = o.evidence_ids.every((id) => ids.has(id))
    if (!valid) evidenceInvalid++
    cases.push({
      case_id: c.case_id, source_cid: c.source_cid, head: c.head,
      gold_candidate_verdict: l.candidate_verdict, gold_resolved_verdict: l.resolved_verdict,
      output_verdict: o.verdict, candidate_correct: candidateCorrect,
      gold_family: l.family_id, output_family: o.family_id, family_correct: familyCorrect,
      gold_canonical: l.canonical_head, output_canonical: o.canonical_head,
      canonical_correct: canonicalHit, evidence_valid: valid, rationale: o.rationale,
    })
  }
  const precision = safeDiv(tp, tp + fp)
  const recall = safeDiv(tp, tp + fn)
  const familyPrecision = safeDiv(familyTp, familyTp + familyFp)
  const familyRecall = safeDiv(familyTp, familyTp + familyFn)
  const decided = tp + fp + fn + tn
  return {
    model, total: dataset.cases.length, decided, abstained, invalid: errors.length,
    tp, fp, fn, tn, precision, recall, f1: f1(precision, recall),
    accuracy: safeDiv(tp + tn, decided), coverage: safeDiv(decided, dataset.cases.length),
    conditional_correct: conditionalCorrect, conditional_total: conditionalTotal,
    family_tp: familyTp, family_fp: familyFp, family_fn: familyFn,
    family_precision: familyPrecision, family_recall: familyRecall, family_f1: f1(familyPrecision, familyRecall),
    canonical_correct: canonicalCorrect, canonical_total: canonicalTotal,
    canonical_accuracy: safeDiv(canonicalCorrect, canonicalTotal),
    evidence_invalid: evidenceInvalid, cases,
  }
}

export function scoreDataset(dataset: Dataset): BenchmarkReport {
  const dir = join(dataset.root, 'outputs')
  const runs: Array<{ name: string; model: string; order: number; file: string }> = []
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'output.jsonl')
    if (!existsSync(file)) continue
    const meta = JSON.parse(readFileSync(join(dir, name, 'meta.json'), 'utf8')) as {
      model?: string; run_order?: number
    }
    runs.push({ name, model: meta.model ?? name, order: meta.run_order ?? 999, file })
  }
  const models: ModelScore[] = []
  for (const run of runs.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
    const outputs = readJsonl(run.file, OutputSchema)
    models.push(scoreModel(dataset, run.model, outputs))
  }
  const agreement: BenchmarkReport['agreement'] = []
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = models[i], b = models[j]
      const same = a.cases.filter((c, k) => c.output_verdict === b.cases[k].output_verdict).length
      agreement.push({ a: a.model, b: b.model, same, total: a.total, rate: safeDiv(same, a.total) })
    }
  }
  return {
    dataset_id: dataset.manifest.dataset_id, version: dataset.manifest.version,
    case_count: dataset.manifest.case_count, models, agreement,
  }
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

export function renderMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# ${report.dataset_id} 评分报告`,
    '',
    `案例数：${report.case_count}；模型数：${report.models.length}。候选词头判断与家族/完整形识别分开计分。`,
  ]
  if (!report.models.length) {
    lines.push('', '暂无模型输出。先运行模型并写入 `outputs/<run>/output.jsonl`，再重新评分。')
    return lines.join('\n') + '\n'
  }
  lines.push(
    '',
    '| 模型 | 候选准确率 | Precision | Recall | F1 | 覆盖率 | 存疑 | 家族 F1 | 完整形准确率 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const m of report.models) {
    lines.push(`| ${m.model} | ${pct(m.accuracy)} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.coverage)} | ${m.abstained} | ${pct(m.family_f1)} | ${pct(m.canonical_accuracy)} |`)
  }
  lines.push('', '## 模型两两一致率', '', '| 模型 A | 模型 B | 一致率 |', '| --- | --- | --- |')
  for (const a of report.agreement) lines.push(`| ${a.a} | ${a.b} | ${pct(a.rate)} |`)
  lines.push('', '## 逐题对照', '', '| 案例 | 词头 | 金标候选 | 金标完整形 | ' + report.models.map((m) => m.model).join(' | ') + ' |',
    '| --- | --- | --- | --- | ' + report.models.map(() => '---').join(' | ') + ' |')
  for (let i = 0; i < report.case_count; i++) {
    const first = report.models[0].cases[i]
    const cells = report.models.map((m) => {
      const c = m.cases[i]
      const canonical = c.output_canonical ? ` → ${c.output_canonical}` : ''
      return `${c.output_verdict}${canonical}`
    })
    lines.push(`| ${first.case_id} | ${first.head} | ${first.gold_candidate_verdict} | ${first.gold_canonical ?? '—'} | ${cells.join(' | ')} |`)
  }
  return lines.join('\n') + '\n'
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const dataset = loadDataset(resolve(flag('--dataset', DEFAULT_DATASET)))
  const report = scoreDataset(dataset)
  const format = flag('--format', 'markdown')
  const text = format === 'json' ? JSON.stringify(report, null, 2) + '\n' : renderMarkdown(report)
  const output = flag('--output', '')
  if (output) writeFileSync(output, text)
  else process.stdout.write(text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
