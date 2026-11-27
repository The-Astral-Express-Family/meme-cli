/** curator-v1 评分：
 *
 *   --run <id>   对 run 产物打分 → runs/<id>/score.json（默认 policy=family, balance=full）
 *                可用 --policy any / --balance neg2x 输出变体文件（v5.1 消融入口）
 *   --ablation   扫全部已完成 run × {A 家族, B any-hit} × {full, neg2x} → ablation.json
 *
 * 判定（设计 §4.1）：
 *   正例  命中词条归属期望家族 → TP；否则 FN。未归属/跨家族词条的命中单列为额外命中，不进主矩阵。
 *   负例  任何命中 → FP（含未归属/跨家族词条——噪音词条必须被抓出来）；未命中 → TN。
 * 消融（设计 §8）：B any-hit 只放宽"正例算不算命中"（命中任一单家族词条即 TP）；
 *   跨家族/未归属词条在两种口径下都不参与正例计分；负例两口径相同。
 *   subtask（family_pass/noise_pass）分组与通过条件固定，只有正例判定随 policy 变。
 *   neg2x：每条负例计两次（FP×2、TN×2），P/R/F1 相应重算，结果确定无需采样。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { connect } from '../src/db.ts'
import { BENCH_ROOT, QUERIES_FILE, RUNS_DIR, loadGold, readJsonl, buildAttribution, parseTranscriptLinks } from './curator-lib.ts'

process.env.MEME_EMBED_OFF = '1'

type Policy = 'family' | 'any'
type Balance = 'full' | 'neg2x'

export interface Query {
  query_id: string
  channel: string
  text: string
  ctx: string[] | null
  expect: { hit: boolean; family: string | null }
  from_candidate: string | null
  tags: string[]
}

interface HitRow { meme_id: string; name: string; tier: number; confidence: number; method: string; family: string | null; attribution: string; via: string | null }
export interface LookupRow { query_id: string; hit: boolean; hits: HitRow[] }
type Verdict = 'TP' | 'FP' | 'FN' | 'TN'

interface QueryResult {
  query_id: string
  verdict: Verdict
  expected_family: string | null
  hit_families: Array<string | null>
  extra_hits: Array<{ meme_id: string; name: string; kind: 'unattributed' | 'cross-family' | 'wrong-family' }>
  noise_built_hits: string[]
}

interface GroupStat { tp: number; fp: number; fn: number; tn: number; precision: number; recall: number; f1: number }

function prf(tp: number, fp: number, fn: number, tn: number): GroupStat {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  return { tp, fp, fn, tn, precision, recall, f1 }
}

export interface ScoreOutput {
  run_id: string
  policy: Policy
  balance: Balance
  note: string
  matrix: GroupStat
  channels: Record<string, GroupStat>
  extra_hits_total: number
  unattributed_hits_total: number
  cross_family_hits_total: number
  family_pass: { passed: number; total: number; failures: Array<{ family: string; labels: string[]; first_failed_query: string }> }
  noise_pass: { passed: number; total: number; failures: Array<{ cid: string; head: string; failed_query_ids: string[]; stepped_by: string[] }> }
  paired_context: { groups: number; correct: number }
  per_query: QueryResult[]
}

/** 纯评分核心（IO 无关，测试直用）。 */
export function computeScore(
  runId: string,
  queries: Query[],
  lookups: Map<string, LookupRow>,
  gold: ReturnType<typeof loadGold>,
  attr: ReturnType<typeof buildAttribution>,
  policy: Policy = 'family',
  balance: Balance = 'full',
): ScoreOutput {
  const results: QueryResult[] = []
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0 }
  const channels: Record<string, { tp: number; fp: number; fn: number; tn: number }> = {}
  let extraHits = 0
  let unattributedHits = 0
  let crossFamilyHits = 0

  for (const q of queries) {
    const r = lookups.get(q.query_id)
    if (!r) throw new Error(`lookups.jsonl 缺 ${q.query_id}`)
    const famHits = r.hits.filter((h) => h.attribution === 'family')
    const res: QueryResult = {
      query_id: q.query_id,
      verdict: 'TN',
      expected_family: q.expect.family,
      hit_families: r.hits.map((h) => h.family),
      extra_hits: [],
      noise_built_hits: [],
    }
    for (const h of r.hits) {
      if (h.attribution === 'family') {
        if (q.expect.hit && h.family !== q.expect.family) res.extra_hits.push({ meme_id: h.meme_id, name: h.name, kind: 'wrong-family' })
      } else if (h.attribution === 'none') {
        res.extra_hits.push({ meme_id: h.meme_id, name: h.name, kind: 'unattributed' })
        unattributedHits++
        if (attr.noiseMemes.has(h.meme_id)) res.noise_built_hits.push(h.meme_id)
      } else {
        res.extra_hits.push({ meme_id: h.meme_id, name: h.name, kind: 'cross-family' })
        crossFamilyHits++
      }
    }
    extraHits += res.extra_hits.length

    if (q.expect.hit) {
      const tp = policy === 'family'
        ? famHits.some((h) => h.family === q.expect.family)
        : famHits.length > 0
      res.verdict = tp ? 'TP' : 'FN'
    } else {
      res.verdict = r.hits.length > 0 ? 'FP' : 'TN'
    }
    matrix[res.verdict.toLowerCase() as 'tp' | 'fp' | 'fn' | 'tn']++
    const ch = channels[q.channel] ?? { tp: 0, fp: 0, fn: 0, tn: 0 }
    ch[res.verdict.toLowerCase() as 'tp' | 'fp' | 'fn' | 'tn']++
    channels[q.channel] = ch
    results.push(res)
  }

  const negW = balance === 'neg2x' ? 2 : 1
  const mainStat = prf(matrix.tp, matrix.fp * negW, matrix.fn, matrix.tn * negW)
  const channelStats: Record<string, GroupStat> = {}
  for (const [c, m] of Object.entries(channels)) channelStats[c] = prf(m.tp, m.fp * negW, m.fn, m.tn * negW)

  // ---- subtask：family_pass（分组/通过条件固定；仅正例判定随 policy）----
  const familyFailures: ScoreOutput['family_pass']['failures'] = []
  let familyPassed = 0
  for (const f of gold.families) {
    const qs = queries.filter((q) => q.expect.family === f)
    const failed = qs.filter((q) => {
      const v = results.find((r) => r.query_id === q.query_id)!.verdict
      return v === 'FP' || v === 'FN'
    })
    if (!failed.length) {
      familyPassed++
      continue
    }
    const labels: string[] = []
    if (attr.bannedFamilies.has(f)) labels.push('banned')
    const built = [...attr.byMeme.values()].some((a) => a.kind === 'family' && a.family === f)
    if (!built && !labels.length) labels.push('unbuilt')
    const noiseTouched = failed.some((q) => {
      const r = results.find((x) => x.query_id === q.query_id)!
      return r.noise_built_hits.length > 0
    })
    if (noiseTouched) labels.push('noise')
    if (!labels.length) labels.push('matcher_wrong')
    familyFailures.push({ family: f, labels, first_failed_query: failed[0].query_id })
  }

  // ---- subtask：noise_pass（45 条 not-meme 候选，按 from_candidate 分组）----
  const noiseFailures: ScoreOutput['noise_pass']['failures'] = []
  let noisePassed = 0
  for (const cid of gold.noiseCids) {
    const qs = queries.filter((q) => q.from_candidate === cid && !q.expect.hit)
    if (!qs.length) continue
    const failed = qs.filter((q) => results.find((r) => r.query_id === q.query_id)!.verdict === 'FP')
    if (!failed.length) {
      noisePassed++
      continue
    }
    const steppedBy = new Set<string>()
    for (const q of failed) {
      const r = lookups.get(q.query_id)!
      for (const h of r.hits) steppedBy.add(h.name)
    }
    noiseFailures.push({ cid, head: gold.byCid.get(cid)?.head ?? '', failed_query_ids: failed.map((q) => q.query_id), stepped_by: [...steppedBy] })
  }

  // ---- 同文异境成对 ----
  const byText = new Map<string, Query[]>()
  for (const q of queries) byText.set(q.text, [...(byText.get(q.text) ?? []), q])
  const groups = [...byText.values()].filter((g) => g.length >= 2)
  let pairsCorrect = 0
  for (const g of groups) {
    const ok = g.every((q) => {
      const v = results.find((r) => r.query_id === q.query_id)!.verdict
      return v === 'TP' || v === 'TN'
    })
    if (ok) pairsCorrect++
  }

  return {
    run_id: runId,
    policy,
    balance,
    note: '正例计分只用归属唯一家族的词条；未归属/跨家族词条的命中单列为额外命中。负例任何命中=FP。policy=any 仅放宽正例的家族匹配。balance=neg2x 将每条负例计两次。',
    matrix: mainStat,
    channels: channelStats,
    extra_hits_total: extraHits,
    unattributed_hits_total: unattributedHits,
    cross_family_hits_total: crossFamilyHits,
    family_pass: { passed: familyPassed, total: gold.families.length, failures: familyFailures },
    noise_pass: { passed: noisePassed, total: gold.noiseCids.length, failures: noiseFailures },
    paired_context: { groups: groups.length, correct: pairsCorrect },
    per_query: results,
  }
}

export function scoreRun(runId: string, policy: Policy = 'family', balance: Balance = 'full'): ScoreOutput {
  const dir = `${RUNS_DIR}/${runId}`
  const lookups = new Map(readJsonl<LookupRow>(`${dir}/lookups.jsonl`).map((r) => [r.query_id, r]))
  const queries = readJsonl<Query>(QUERIES_FILE)
  const gold = loadGold()
  const dbPath = `${dir}/db/memes.db`
  if (!existsSync(dbPath)) throw new Error(`${dbPath} 不存在`)
  const db = connect(dbPath)
  const attr = buildAttribution(db, gold, parseTranscriptLinks(`${dir}/transcript.jsonl`))
  db.close()
  return computeScore(runId, queries, lookups, gold, attr, policy, balance)
}

function writeScore(runId: string, policy: Policy, balance: Balance): ScoreOutput {
  const out = scoreRun(runId, policy, balance)
  const file = policy === 'family' && balance === 'full'
    ? `${RUNS_DIR}/${runId}/score.json`
    : `${RUNS_DIR}/${runId}/score-${policy}-${balance}.json`
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  const m = out.matrix
  console.log(`${runId} [${policy}/${balance}] P=${m.precision.toFixed(3)} R=${m.recall.toFixed(3)} F1=${m.f1.toFixed(3)} `
    + `TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn} | family_pass ${out.family_pass.passed}/${out.family_pass.total} `
    + `noise_pass ${out.noise_pass.passed}/${out.noise_pass.total} | extra=${out.extra_hits_total} (未归属 ${out.unattributed_hits_total} 跨族 ${out.cross_family_hits_total})`)
  if (out.family_pass.failures.length) {
    console.log(`  family_pass 失败：${out.family_pass.failures.map((f) => `${f.family}[${f.labels.join('+')}]@${f.first_failed_query}`).join('  ')}`)
  }
  if (out.noise_pass.failures.length) {
    console.log(`  noise_pass 失败：${out.noise_pass.failures.map((f) => `${f.head}(${f.cid}) 踩雷词条[${f.stepped_by.join('/')}]`).join('  ')}`)
  }
  return out
}

// ---- v5.1 消融 ----

interface AblationRow {
  run_id: string
  model: string | null
  finish_reason?: string
  /** A 口径下为 TP/FN，B 口径下翻转的题数；为 0 说明该 run 无法区分两种口径 */
  policy_divergent_queries: number
  variants: Record<Policy, Record<Balance, { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; tn: number; family_pass: string; noise_pass: string; extra_hits: number; unattributed_hits: number }>>
}

function rankingOf(rows: AblationRow[], policy: Policy, balance: Balance): string[] {
  return [...rows].sort((a, b) =>
    b.variants[policy][balance].f1 - a.variants[policy][balance].f1 || a.run_id.localeCompare(b.run_id),
  ).map((r) => r.run_id)
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function cmdAblation(): void {
  const entries = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  const rows: AblationRow[] = []
  for (const e of entries) {
    const dir = `${RUNS_DIR}/${e.name}`
    if (!existsSync(`${dir}/lookups.jsonl`)) continue
    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) as Record<string, unknown>
    const variants = {} as AblationRow['variants']
    let divergent = 0
    for (const balance of ['full', 'neg2x'] as Balance[]) {
      // 同一批 lookup 结果：A/B 只差"正例算不算命中"的判定，跑两次纯计算
      const sA = scoreRun(e.name, 'family', balance)
      const sB = scoreRun(e.name, 'any', balance)
      const aByQuery = new Map(sA.per_query.map((r) => [r.query_id, r.verdict]))
      const diff = sB.per_query.filter((r) => aByQuery.get(r.query_id) !== r.verdict).length
      if (balance === 'full') divergent = diff
      variants.family = variants.family ?? ({} as Record<Balance, AblationRow['variants']['family']['full']>)
      variants.any = variants.any ?? ({} as Record<Balance, AblationRow['variants']['any']['full']>)
      variants.family[balance] = {
        precision: sA.matrix.precision, recall: sA.matrix.recall, f1: sA.matrix.f1,
        // computeScore 已按 negW 缩放过 fp/tn，这里不能再乘一次
        tp: sA.matrix.tp, fp: sA.matrix.fp, fn: sA.matrix.fn, tn: sA.matrix.tn,
        family_pass: `${sA.family_pass.passed}/${sA.family_pass.total}`,
        noise_pass: `${sA.noise_pass.passed}/${sA.noise_pass.total}`,
        extra_hits: sA.extra_hits_total,
        unattributed_hits: sA.unattributed_hits_total,
      }
      variants.any[balance] = {
        precision: sB.matrix.precision, recall: sB.matrix.recall, f1: sB.matrix.f1,
        tp: sB.matrix.tp, fp: sB.matrix.fp, fn: sB.matrix.fn, tn: sB.matrix.tn,
        family_pass: `${sB.family_pass.passed}/${sB.family_pass.total}`,
        noise_pass: `${sB.noise_pass.passed}/${sB.noise_pass.total}`,
        extra_hits: sB.extra_hits_total,
        unattributed_hits: sB.unattributed_hits_total,
      }
    }
    rows.push({
      run_id: e.name,
      model: (meta.model as string | null) ?? null,
      finish_reason: meta.finish_reason as string | undefined,
      policy_divergent_queries: divergent,
      variants,
    })
  }
  const rankAfull = rankingOf(rows, 'family', 'full')
  const rankBfull = rankingOf(rows, 'any', 'full')
  const rankAneg = rankingOf(rows, 'family', 'neg2x')
  const maxGapFull = rows.length
    ? Math.max(...rows.map((r) => Math.abs(r.variants.family.full.f1 - r.variants.any.full.f1)))
    : 0
  // 自检：空库/满分库在两口径下必须一致
  const selfCheck: Record<string, string> = {}
  for (const base of ['empty', 'perfect']) {
    const row = rows.find((r) => r.run_id === base)
    if (!row) continue
    const a = row.variants.family.full
    const b = row.variants.any.full
    selfCheck[base] = Math.abs(a.f1 - b.f1) < 1e-9 && a.family_pass === b.family_pass
      ? 'ok：两口径一致'
      : `FAIL：两口径不一致（A f1=${a.f1} B f1=${b.f1} family_pass ${a.family_pass} vs ${b.family_pass}）`
  }
  // 只有基线时不出结论：A/B 只在"正例被错误家族命中"时分叉，空库（无词条）与
  // 满分库（零误配）必然同分，ΔF1=0 是构造结果，不是"归属可放宽"的证据（设计 §8.4）。
  const nonBaseline = rows.filter((r) => r.model !== 'baseline' && r.run_id !== 'empty' && r.run_id !== 'perfect')
  const discriminating = nonBaseline.filter((r) => r.policy_divergent_queries > 0)
  const conclusion = nonBaseline.length === 0
    ? 'insufficient_runs：只有基线，A/B 在两端点上必然同分，不能据此判断归属是否必要'
    : discriminating.length === 0
      ? 'insufficient_signal：所有非基线 run 在 A/B 下逐题判定完全相同（没有"正例只被错误家族命中"的题），ΔF1=0 不能区分归属必要与过严'
      : sameOrder(rankAfull, rankBfull) && maxGapFull < 0.05
        ? 'relax-any：排序一致且分差 <5 个百分点，归属可考虑放宽（policy=any）'
        : 'keep-family：归属必要（B 口径改变排序或分差显著），保留 family 归属'
  const out = {
    generated_at: new Date().toISOString(),
    note: 'A=家族口径（v5 默认）；B=any-hit（正例命中任一单家族词条即 TP）。跨家族/未归属词条两种口径都不参与正例计分；负例相同。neg2x=每条负例计两次。排序按 F1 降序（同分按 run_id）。policy_divergent_queries 是 A/B 判定翻转的题数：它为 0 的 run 对"归属是否必要"没有区分力，此时 ΔF1=0 不能当作"归属可放宽"的证据。',
    runs: rows,
    rankings: {
      A_full: rankAfull,
      B_full: rankBfull,
      A_neg2x: rankAneg,
      ranking_stable_A_vs_B: sameOrder(rankAfull, rankBfull),
      ranking_stable_full_vs_neg2x: sameOrder(rankAfull, rankAneg),
      max_f1_gap_A_vs_B_full: Math.round(maxGapFull * 10000) / 10000,
    },
    self_check: selfCheck,
    non_baseline_runs: nonBaseline.length,
    runs_with_policy_divergence: discriminating.length,
    conclusion,
  }
  const file = `${BENCH_ROOT}/ablation.json`
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(`\nablation.json → ${file}`)
  console.log(`排序 A(full)=${rankAfull.join(' > ')}`)
  console.log(`排序 B(full)=${rankBfull.join(' > ')}`)
  console.log(`ranking_stable(A vs B)=${out.rankings.ranking_stable_A_vs_B}  max Δf1=${out.rankings.max_f1_gap_A_vs_B_full}`)
  for (const [k, v] of Object.entries(selfCheck)) console.log(`自检 ${k}: ${v}`)
  console.log(`结论：${conclusion}`)
}

function main(): number {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--ablation')) {
    cmdAblation()
    return 0
  }
  const runId = flag('run')
  if (!runId) {
    console.error('用法: npx tsx scripts/curator-score.ts --run <id> [--policy family|any] [--balance full|neg2x] | --ablation')
    return 2
  }
  const policy = (flag('policy') as Policy) ?? 'family'
  const balance = (flag('balance') as Balance) ?? 'full'
  if (!['family', 'any'].includes(policy) || !['full', 'neg2x'].includes(balance)) {
    console.error('policy ∈ {family,any}, balance ∈ {full,neg2x}')
    return 2
  }
  writeScore(runId, policy, balance)
  return 0
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)
if (isMain) process.exitCode = main()
