/**
 * backtest 闸门：留出集命中率 + 负例误报率。
 * 归纳质量由此第一次成为可测量、可回归的工程指标；原始湖兼任负例语料。
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomNegativeComments, makeRng } from '../lake.ts'
import { CompiledMatcher, matchCompiled } from '../match/pipeline.ts'
import { matchTokensTerms } from '../match/skeleton.ts'
import type { Meme } from '../models.ts'

/** 含"上句：X 本句：Y"标记的文本拆为会话上下文（交互梗的对话式例句曾是单行文本，无 ctx 则 tier 3 永不触发）。 */
export function splitDialogue(
  texts: string[], ctxs: Array<string[] | null> | null,
): [string[], Array<string[] | null>] {
  const pat = /上句[:：]\s*(.+?)\s*[\n|｜;；]*\s*本句[:：]\s*(.+)$/
  const outTexts: string[] = []
  const outCtxs: Array<string[] | null> = []
  texts.forEach((t, i) => {
    const m = t.match(pat)
    if (m) {
      outTexts.push(m[2].trim())
      outCtxs.push([m[1].trim(), m[2].trim()])
    } else {
      outTexts.push(t)
      outCtxs.push(ctxs && i < ctxs.length ? ctxs[i] : null)
    }
  })
  return [outTexts, outCtxs]
}

export interface BacktestResult {
  holdout_size: number
  hits: number
  hit_rate: number
  negatives: number
  false_positives: number
  fp_rate: number
  passed: boolean
  missed: string[] // 漏报样本（修订用）
  false_hits: string[] // 误报样本（修订用）
}

export function backtestToDict(r: BacktestResult): Record<string, unknown> {
  return {
    holdout_size: r.holdout_size, hits: r.hits,
    hit_rate: Math.round(r.hit_rate * 1000) / 1000,
    negatives: r.negatives, false_positives: r.false_positives,
    fp_rate: Math.round(r.fp_rate * 1000) / 1000,
    passed: r.passed,
  }
}

export function runBacktest(
  db: DatabaseSync,
  meme: Meme,
  matcher: CompiledMatcher,
  positiveTexts: string[],
  opts: {
    holdout?: number
    holdout_texts?: string[] | null // 显式留出集（去污染：未进过归纳提示词）
    holdout_ctx?: Array<string[] | null> | null // 与 holdout_texts 平行的会话上下文（交互梗 tier 3）
    min_hit?: number
    max_fp?: number
    negatives?: number
    seed?: number
  } = {},
): BacktestResult {
  const {
    holdout = 0.3, min_hit = 0.7, max_fp = 0.02,
    negatives = 1000, seed = 42,
  } = opts
  const res: BacktestResult = {
    holdout_size: 0, hits: 0, hit_rate: 0, negatives: 0,
    false_positives: 0, fp_rate: 0, passed: false, missed: [], false_hits: [],
  }
  const pairedPositives: Array<[string, string[] | null]> = positiveTexts
    .map((t, i) => [t, opts.holdout_ctx?.[i] ?? null] as [string, string[] | null])
    .filter(([t]) => Boolean(t && t.trim()))
  let holdoutPairs: Array<[string, string[] | null]>
  if (opts.holdout_texts != null) {
    holdoutPairs = opts.holdout_texts
      .map((t, i) => [t, opts.holdout_ctx?.[i] ?? null] as [string, string[] | null])
      .filter(([t]) => Boolean(t && t.trim()))
  } else {
    // 确定性洗牌（mulberry32）：同种子同切分
    const rnd = makeRng(seed)
    for (let i = pairedPositives.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[pairedPositives[i], pairedPositives[j]] = [pairedPositives[j], pairedPositives[i]]
    }
    const nHold = pairedPositives.length ? Math.max(1, Math.floor(pairedPositives.length * holdout)) : 0
    holdoutPairs = pairedPositives.slice(0, nHold)
  }
  let [ht, hc] = splitDialogue(holdoutPairs.map(([t]) => t), holdoutPairs.map(([, ctx]) => ctx))
  const interaction = meme.class === 'interaction' || meme.matcher?.patterns.some((p) => p.kind === 'interaction')
  if (interaction) {
    const pairs = ht.map((t, i) => [t, hc[i] ?? null] as [string, string[] | null]).filter(([t, ctx]) =>
      Boolean(ctx && (meme.matcher?.patterns ?? []).some((p) => p.kind === 'interaction'
        && matchTokensTerms(ctx[0], p.trigger_tokens, p.trigger_terms))))
    ht = pairs.map(([t]) => t)
    hc = pairs.map(([, ctx]) => ctx)
  }
  res.holdout_size = ht.length
  ht.forEach((t, i) => {
    const ctx = hc[i] ?? null
    const hit = matchCompiled(matcher, t, ctx)
    if (hit && hit.tier >= 1 && hit.tier <= 3) res.hits += 1
    else res.missed.push(t)
  })
  res.hit_rate = res.holdout_size ? res.hits / res.holdout_size : 0

  // 负例既不含梗名/别名，也不含任何已知正例、留出文本及其会话上下文，避免正负例重叠。
  const knownTexts = new Set([
    ...positiveTexts,
    ...(opts.holdout_texts ?? []),
    ...ht,
    ...hc.flatMap((ctx) => ctx ?? []),
  ])
  const exclude = [...new Set([meme.name, ...meme.aliases, ...knownTexts])]
  const negs = randomNegativeComments(db, negatives, exclude, seed)
  res.negatives = negs.length
  for (const t of negs) {
    const hit = matchCompiled(matcher, t, null) // 负例无会话上下文，tier 3 天然不触发
    if (hit && hit.tier >= 1 && hit.tier <= 3) {
      res.false_positives += 1
      if (res.false_hits.length < 15) res.false_hits.push(t)
    }
  }
  res.fp_rate = res.negatives ? res.false_positives / res.negatives : 0
  // 冷启动：负例不足时不卡误报门（库会随 surf 增长，后续 edit 复检）
  const fpOk = res.negatives >= 200 ? res.fp_rate <= max_fp : true
  res.passed = Boolean(res.holdout_size) && res.hit_rate >= min_hit && fpOk
  return res
}
