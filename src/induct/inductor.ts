/**
 * 入库管线：add（LLM/操作员两路）与 iterate（重归纳）共用一条闸门流水线。
 *
 * LLM 负责价值判断的落实，backtest 负责事实判断——两个判断正交。
 * ID 延迟分配：闸门全过之后才拿号，失败路径零消耗。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import * as audit from '../audit.ts'
import { byHead, get as getCand } from '../candidates.ts'
import type { ResolvedConfig } from '../config.ts'
import { budgetExceeded, candidateNotFound, llmCallFailed, MemeError } from '../errors.ts'
import { get as getMeme, save as saveMeme, allMemes } from '../entries.ts'
import type { VectorAnchor } from '../entries.ts'
import { nextId } from '../ids.ts'
import { makeRng } from '../lake.ts'
import { CompiledMatcher, matchCompiled } from '../match/pipeline.ts'
import { getEmbedder, vecToBlob } from '../match/vector.ts'
import {
  type Candidate, type InductionOutput, InductionOutputSchema, type MatcherSpec,
  MatcherSpecSchema, type Meme, nowIso, type UsageSample,
} from '../models.ts'
import * as budget from './budget.ts'
import * as prompts from './prompts.ts'
import { backtestToDict, runBacktest, type BacktestResult } from './backtest.ts'
import { validateAndCompile, MatcherError } from './compileMatcher.ts'
import type { LlmClient } from './llm.ts'
import { modelFor, triage } from './triage.ts'

export interface AddResult {
  meme: Meme
  model: string
  backtest: BacktestResult | null
  revisions: number
  matcher_degraded: boolean
  warnings: string[]
  usage_tokens: number
}

export function addResultToDict(res: AddResult): Record<string, unknown> {
  return {
    id: res.meme.id,
    name: res.meme.name,
    class: res.meme.class,
    state: res.meme.state,
    matcher: res.meme.matcher ? 'compiled' : 'vector-only',
    backtest: res.backtest ? backtestToDict(res.backtest) : null,
    model: res.model,
    revisions: res.revisions,
    warnings: res.warnings,
    usage_tokens: res.usage_tokens,
  }
}

/** 新词条与库内词条同名/同别名 → 应走 iterate 而非重复入库。 */
export function findDuplicate(db: DatabaseSync, out: InductionOutput): Meme | null {
  for (const m of allMemes(db)) {
    if (m.state === 'tombstone') continue
    const terms = new Set([m.name, ...m.aliases])
    if (terms.has(out.name) || out.aliases.some((a) => terms.has(a))) return m
  }
  return null
}

/** 提取 ```json 围栏；退化尝试裸 JSON / 首尾大括号。 */
export function extractJson(text: string): Record<string, unknown> {
  if (text.includes('```json')) {
    const seg = text.split('```json')[1]!.split('```')[0]
    return JSON.parse(seg.trim())
  }
  try {
    return JSON.parse(text.trim())
  } catch { /* 裸 JSON 失败 → 首尾大括号 */ }
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1))
  throw llmCallFailed('模型输出中未找到 JSON')
}

interface ParseOutcome {
  out?: InductionOutput
  errors: string[]
}

function tryParse(rawText: string): ParseOutcome {
  try {
    const raw = extractJson(rawText)
    const parsed = InductionOutputSchema.safeParse(raw)
    if (!parsed.success) {
      return { errors: [parsed.error.message.slice(0, 500)] }
    }
    if (!parsed.data.card?.gist) return { errors: ['card.gist 缺失'] }
    return { out: parsed.data, errors: [] }
  } catch (e) {
    return { errors: [`输出中未找到可解析 JSON：${e}`] }
  }
}

/** 修订轮输出 → MatcherSpec（裸 matcher JSON 或完整词条 JSON 均可）。 */
function parseMatcher(rawText: string): MatcherSpec {
  const data = extractJson(rawText) as Record<string, unknown>
  const target = 'matcher' in data ? data.matcher : data
  const parsed = MatcherSpecSchema.safeParse(target)
  if (!parsed.success) throw new MatcherError(parsed.error.message)
  return parsed.data
}

/** 楼中楼对话对（interaction 证据）：子评论 → 父评论文本。 */
function pairTexts(db: DatabaseSync, usages: UsageSample[]): Array<[string, string]> {
  const q = db.prepare('SELECT message FROM lake_comments WHERE rpid=?')
  const pairs: Array<[string, string]> = []
  for (const u of usages) {
    if (!u.parent) continue
    const row = q.get(u.parent) as Row | undefined
    if (row) pairs.push([row.message as string, u.text])
  }
  return pairs
}

function relatedContext(db: DatabaseSync, cand: Candidate | null): {
  parentCard: prompts.RelatedCard | null
  relatedCards: prompts.RelatedCard[]
} {
  let parentCard: prompts.RelatedCard | null = null
  const relatedCards: prompts.RelatedCard[] = []
  for (const rel of cand?.related ?? []) {
    const m = getMeme(db, rel.id)
    if (!m) continue
    const item = { id: m.id, name: m.name, class: m.class, gist: m.card.gist }
    if (rel.type === 'derived') parentCard = item
    relatedCards.push(item)
  }
  return { parentCard, relatedCards: relatedCards.slice(0, 3) }
}

function evidencePack(db: DatabaseSync, cand: Candidate | null, text: string | null, ctx: string | null): prompts.EvidencePack {
  if (cand) {
    const usages: Array<Record<string, unknown>> = cand.evidence_usages.map((u) => ({ text: u.text, rpid: u.rpid }))
    for (const [a, b] of pairTexts(db, cand.evidence_usages).slice(0, 8)) {
      usages.push({ text: b, pair: [a, b] })
    }
    return {
      head: cand.head,
      kind: cand.kind_guess,
      channel: cand.channel,
      spread: {
        videos: cand.distinct_videos,
        ups: cand.distinct_ups,
        first: cand.first_seen.slice(0, 10),
        last: cand.last_seen.slice(0, 10),
      },
      z: cand.z_score,
      usages,
    }
  }
  const usages: Array<Record<string, unknown>> = [{ text }]
  if (ctx) usages.push({ text: ctx })
  return {
    head: (text ?? '').slice(0, 20),
    kind: 'word',
    channel: 'phrase',
    spread: { videos: 1, ups: 1, first: null, last: null },
    z: null,
    usages,
  }
}

/** 留出集构建（去污染）：按比例切出 holdout 文本与其会话上下文。 */
function buildHoldout(db: DatabaseSync, cand: Candidate, holdoutRatio: number): {
  texts: string[]
  ctxs: Array<string[] | null>
} {
  const q = db.prepare('SELECT message FROM lake_comments WHERE rpid=?')
  const all = cand.evidence_usages.filter((u) => u.text.trim())
  const rnd = makeRng(42) // 确定性洗牌：与 backtest 同一种子约定
  const texts = all.map((u) => u.text)
  for (let i = texts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[texts[i], texts[j]] = [texts[j], texts[i]]
  }
  const holdout = texts.slice(0, Math.max(1, Math.floor(all.length * holdoutRatio)))
  const byText = new Map<string, UsageSample>()
  for (const u of all) if (!byText.has(u.text)) byText.set(u.text, u)
  const ctxs: Array<string[] | null> = holdout.map((t) => {
    const u = byText.get(t)
    if (!u?.parent) return null
    const row = q.get(u.parent) as Row | undefined
    return row ? [row.message as string, t] : null
  })
  return { texts: holdout, ctxs }
}

async function embedExamples(meme: Meme, cfg: ResolvedConfig): Promise<VectorAnchor[]> {
  const texts = [...meme.examples, ...meme.card.usage].slice(0, 10)
  if (!texts.length) return []
  const emb = getEmbedder(cfg.retrieval.embed_model)
  const vecs = await emb.embed(texts)
  if (!vecs) return []
  return vecs.map((v, i) => ({ idx: i, text: texts[i], dim: v.length, vec: vecToBlob(v) }))
}

/** 共享闸门：matcher 编译 → backtest → 一轮自动修订 → 词条构建。 */
async function gateAndBuild(
  db: DatabaseSync,
  cfg: ResolvedConfig,
  out: InductionOutput,
  opts: {
    base?: Meme | null
    positives?: string[]
    holdout_texts?: string[] | null
    holdout_ctx?: Array<string[] | null> | null
    llm?: LlmClient | null
    model?: string
    strict?: boolean
    force?: boolean
    /** 未声明 platform 时的回落标签（surf 候选 = bilibili，其余来源 []）。 */
    platform?: string[]
    signal?: AbortSignal
  },
): Promise<[Meme, BacktestResult | null, string[], number, boolean]> {
  const warnings: string[] = []
  let revisions = 0
  const strict = opts.strict ?? false
  const force = opts.force ?? false
  let matcherSpec: MatcherSpec | null = out.matcher
  if (matcherSpec !== null) {
    try {
      matcherSpec = validateAndCompile(matcherSpec)
    } catch (e) {
      if (strict) {
        throw new MemeError(
          'MEME_MATCHER_COMPILE_FAIL', `matcher 编译失败：${e}`,
          '修正 matcher 字段后重试；或删除 matcher 字段（纯向量词条）。',
        )
      }
      matcherSpec = null
      warnings.push(`matcher 编译失败，降级纯向量：${e}`)
    }
  }

  let meme: Meme
  if (opts.base) {
    // iterate：原位更新，保留 id/state/stats
    meme = structuredClone(opts.base)
    meme.name = out.name
    meme.aliases = out.aliases
    meme.class = out.class
    if (out.birth_circa) meme.birth = { circa: out.birth_circa }
    meme.card = out.card
    meme.examples = out.examples.slice(0, 8)
    if (out.lineage_parent) meme.lineage = { parent: out.lineage_parent, mutation: out.lineage_mutation }
    meme.matcher = matcherSpec
  } else {
    meme = MemeDefault(out, matcherSpec, opts.platform ?? [])
  }

  let bt: BacktestResult | null = null
  if (meme.matcher !== null) {
    const pos = opts.positives ?? meme.examples
    const runBt = () => runBacktest(db, meme, new CompiledMatcher(meme), pos, {
      holdout: cfg.induction.backtest_holdout,
      holdout_texts: opts.holdout_texts || null,
      holdout_ctx: opts.holdout_ctx || null,
      min_hit: cfg.induction.backtest_min_hit,
      max_fp: cfg.induction.backtest_max_fp,
      negatives: cfg.induction.backtest_negatives,
    })
    bt = runBt()
    while (!bt.passed && revisions < 1 && opts.llm) {
      const direction = bt.hit_rate < cfg.induction.backtest_min_hit ? 'loosen' : 'tighten'
      const [system, user] = prompts.buildMatcherRevisionPrompt(
        JSON.stringify(meme.matcher), direction, bt.missed, bt.false_hits,
      )
      const raw = await call(opts.llm, db, system, user, opts.model ?? 'operator', opts.signal)
      revisions += 1
      try {
        meme.matcher = validateAndCompile(parseMatcher(raw.text))
        bt = runBt()
      } catch (e) {
        warnings.push(`修订轮失败：${e}`)
        break
      }
    }
    if (bt && !bt.passed) {
      if (strict && !force) {
        const detail = `留出命中 ${pct(bt.hit_rate)}（门槛 ${pct(cfg.induction.backtest_min_hit)}），`
          + `误报 ${bt.fp_rate.toFixed(1)}（门槛 ${cfg.induction.backtest_max_fp}）；`
          + `漏报 ${bt.missed.length} 例、误报 ${bt.false_hits.length} 例`
        const examples = [...bt.missed.slice(0, 3), ...bt.false_hits.slice(0, 3)].join('; ').slice(0, 200)
        throw new MemeError(
          'MEME_BACKTEST_FAIL', `backtest 未达标：${detail}。样例：${examples}`,
          '按漏报/误报样例修订后重试；确认纯向量入库可加 force=true。',
        )
      }
      meme.matcher = null
      warnings.push('backtest 未达标，降级为纯向量词条（仍可被 search 检索）')
    }
  }
  const degraded = meme.matcher === null && out.matcher !== null
  if (!meme.id) meme.id = nextId(db, 'm') // 延迟分配：闸门全过才拿号
  return [meme, bt, warnings, revisions, degraded]
}

const pct = (x: number) => `${Math.round(x * 100)}%`

function MemeDefault(out: InductionOutput, matcherSpec: MatcherSpec | null, fallbackPlatform: string[]): Meme {
  const ts = nowIso()
  return {
    id: '',
    name: out.name,
    aliases: out.aliases,
    class: out.class,
    lineage: { parent: out.lineage_parent, mutation: out.lineage_mutation },
    platform: fallbackPlatform,
    state: 'observing',
    birth: { circa: out.birth_circa },
    matcher: matcherSpec,
    card: out.card,
    examples: out.examples.slice(0, 8),
    drift: [],
    stats: { wild_freq_30d: 0, peak_freq: 0, last_seen: null, last_matched_round: 0 },
    wild_rounds: [],
    revived_pending: 0,
    created_at: ts,
    updated_at: ts,
  }
}

async function call(
  llm: LlmClient, db: DatabaseSync, system: string, user: string, model: string, signal?: AbortSignal,
): Promise<{ text: string; tokens: number }> {
  const res = await llm.complete(system, user, { model, signal })
  const tokens = (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0)
  budget.spend(db, tokens)
  return { text: res.text, tokens }
}

/** LLM 路径 add：目标解析 → 预算 → triage → 归纳（+修复轮）→ 重名守卫 → 共享闸门 → 入库。 */
export async function runAdd(
  db: DatabaseSync, cfg: ResolvedConfig,
  opts: { cid?: string; text?: string; ctx?: string; force_kind?: string; llm: LlmClient; signal?: AbortSignal },
): Promise<AddResult> {
  // 1. 目标解析：候选 或 裸文本（同 head 候选自动合流）
  let cand: Candidate | null = null
  if (opts.cid) {
    cand = getCand(db, opts.cid)
    if (!cand) throw candidateNotFound(opts.cid)
  } else if (opts.text) {
    cand = byHead(db, opts.text.trim().slice(0, 12))
  }
  const kindOverride = opts.force_kind ?? cand?.kind_guess ?? null

  // 2. 预算闸门
  if (!budget.canSpend(db, cfg.induction.daily_call_budget)) {
    throw budgetExceeded(budget.enqueue(db, opts.cid ?? null, opts.text ?? opts.ctx ?? null))
  }

  const llm = opts.llm
  const plan = triage(cand ?? opts.text ?? '', kindOverride)
  const model = modelFor(plan, cfg.induction)
  const ev = evidencePack(db, cand, opts.text ?? null, opts.ctx ?? null)
  // 留出集去污染：holdout 用例不进归纳提示词，专用于 backtest——
  // 否则 LLM 见过答案再考，命中率虚高、闸门形同虚设。证据不足 5 条时不留出。
  let holdoutTexts: string[] | null = null
  let holdoutCtx: Array<string[] | null> | null = null
  if (cand && cand.evidence_usages.length >= 5) {
    const h = buildHoldout(db, cand, cfg.induction.backtest_holdout)
    holdoutTexts = h.texts
    holdoutCtx = h.ctxs
    const hold = new Set(holdoutTexts)
    ev.usages = ev.usages.filter((u) => !hold.has(u.text as string))
  }
  if (opts.force_kind) ev.kind = opts.force_kind
  const { parentCard, relatedCards } = relatedContext(db, cand)

  // 3. 归纳（一轮）+ 校验失败修复（一轮）
  let [system, user] = prompts.buildInductionPrompt(ev, plan.path, parentCard, relatedCards)
  let res = await call(llm, db, system, user, model, opts.signal)
  let parsed = tryParse(res.text)
  let repairRounds = 0
  if (!parsed.out) {
    ;[system, user] = prompts.buildRepairPrompt(res.text, parsed.errors)
    const res2 = await call(llm, db, system, user, model, opts.signal)
    res = { text: res2.text, tokens: res.tokens + res2.tokens }
    parsed = tryParse(res2.text)
    repairRounds = 1
    if (!parsed.out) {
      throw llmCallFailed(`归纳输出两轮未通过校验：${parsed.errors.join('; ').slice(0, 300)}`)
    }
  }
  const out = parsed.out

  // 3.5 重名守卫：同名/同别名词条已存在 → 引导 iterate（防重复入库）
  const dup = findDuplicate(db, out)
  if (dup) {
    throw new MemeError(
      'MEME_DUPLICATE',
      `词条名/别名与已有词条 ${dup.id}（${dup.name}）冲突`,
      `用 meme iterate 修订 ${dup.id}（带新证据）；确属不同梗请改用不冲突的名字。`,
    )
  }

  // 4-5. 共享闸门（编译 → backtest → LLM 修订轮）
  const positives = [...ev.usages.map((u) => u.text as string).filter(Boolean), ...out.examples]
  const [meme, bt, warnings, revisions, degraded] = await gateAndBuild(db, cfg, out, {
    positives, holdout_texts: holdoutTexts, holdout_ctx: holdoutCtx,
    platform: opts.cid ? ['bilibili'] : [],
    llm, model, signal: opts.signal,
  })

  // 6. 向量锚点（例句级）+ 入库
  const vectors = await embedExamples(meme, cfg)
  saveMeme(db, meme, vectors)

  // 7. 候选收口 + 审计
  settleCandidate(db, cand)
  audit.record(db, meme.id, 'induct', 'add', {
    model,
    evidence_head: ev.head,
    spread: ev.spread,
    backtest: bt ? backtestToDict(bt) : null,
    repair_rounds: repairRounds,
    warnings,
    inductor_notes: out.notes,
    usage_tokens: res.tokens,
  })
  return { meme, model, backtest: bt, revisions, matcher_degraded: degraded, warnings, usage_tokens: res.tokens }
}

/** 操作员亲写词条入库（操作员 agent 本身就是 LLM，归纳不需要外部 API key）。本地闸门全数保留。 */
export async function runAddEntry(
  db: DatabaseSync, cfg: ResolvedConfig, entryData: unknown,
  opts: { cid?: string; text?: string; force?: boolean } = {},
): Promise<AddResult> {
  let out: InductionOutput
  const parsed = InductionOutputSchema.safeParse(entryData)
  if (!parsed.success || !parsed.data.card?.gist) {
    throw new MemeError(
      'MEME_ENTRY_INVALID',
      `词条 JSON 校验失败：${(parsed.success ? 'card.gist 缺失' : parsed.error.message).slice(0, 400)}`,
      'entry schema 见 meme 手册（系统提示段）（JSON 字段与归纳器输出完全一致）。',
    )
  }
  out = parsed.data

  let cand: Candidate | null = null
  if (opts.cid) {
    cand = getCand(db, opts.cid)
    if (!cand) throw candidateNotFound(opts.cid)
  } else if (opts.text) {
    cand = byHead(db, opts.text.trim().slice(0, 12))
  }

  const dup = findDuplicate(db, out)
  if (dup) {
    throw new MemeError(
      'MEME_DUPLICATE',
      `词条名/别名与已有词条 ${dup.id}（${dup.name}）冲突`,
      `用 meme iterate 修订 ${dup.id}；确属不同梗请改用不冲突的名字。`,
    )
  }

  const positives = [...out.examples, ...(cand ? cand.evidence_usages.filter((u) => u.text.trim()).map((u) => u.text) : [])]
  let holdoutTexts: string[] | null = null
  let holdoutCtx: Array<string[] | null> | null = null
  if (cand && cand.evidence_usages.length >= 5) {
    const h = buildHoldout(db, cand, cfg.induction.backtest_holdout)
    holdoutTexts = h.texts
    holdoutCtx = h.ctxs
  }
  const [meme, bt, warnings, , degraded] = await gateAndBuild(db, cfg, out, {
    positives, holdout_texts: holdoutTexts, holdout_ctx: holdoutCtx,
    platform: opts.cid ? ['bilibili'] : [],
    strict: true, force: opts.force ?? false,
  })

  const vectors = await embedExamples(meme, cfg)
  saveMeme(db, meme, vectors)
  settleCandidate(db, cand)
  audit.record(db, meme.id, 'induct', 'add', {
    model: 'operator', // 作者=操作员 agent，无外部 LLM 调用
    evidence_head: cand ? cand.head : (opts.text ?? '').slice(0, 20),
    entry_notes: out.notes,
    backtest: bt ? backtestToDict(bt) : null,
    forced_vector_only: Boolean(opts.force && out.matcher !== null),
  })
  return { meme, model: 'operator', backtest: bt, revisions: 0, matcher_degraded: degraded, warnings, usage_tokens: 0 }
}

/** iterate：带新证据的重归纳（首轮归纳常错，修订必须常做）。 */
export async function runIterate(
  db: DatabaseSync, cfg: ResolvedConfig, mid: string,
  opts: { entry?: unknown; force?: boolean; llm?: LlmClient; signal?: AbortSignal },
): Promise<AddResult> {
  const meme = getMeme(db, mid)
  if (!meme) {
    throw new MemeError('MEME_NOT_FOUND', `未找到词条：${mid}`, '用 meme search 找到目标词条 id 后重试。')
  }
  const ev = collectIterateEvidence(db, meme)

  let out: InductionOutput
  let model: string
  let tokens = 0
  let llm: LlmClient | null = null
  if (opts.entry !== undefined) {
    const parsed = InductionOutputSchema.safeParse(opts.entry)
    if (!parsed.success || !parsed.data.card?.gist) {
      throw new MemeError(
        'MEME_ENTRY_INVALID',
        `词条 JSON 校验失败：${(parsed.success ? 'card.gist 缺失' : parsed.error.message).slice(0, 400)}`,
        'entry schema 见 meme 手册（系统提示段）。',
      )
    }
    out = parsed.data
    model = 'operator'
  } else {
    if (!budget.canSpend(db, cfg.induction.daily_call_budget)) {
      throw budgetExceeded(budget.enqueue(db, null, `iterate:${mid}`))
    }
    if (!opts.llm) throw new MemeError('MEME_LLM_NO_CREDENTIAL', 'LLM 路径需要注入归纳客户端')
    llm = opts.llm
    model = cfg.induction.model
    const [system, user] = prompts.buildIterationPrompt({
      id: meme.id, name: meme.name, aliases: meme.aliases, class: meme.class,
      card: meme.card, examples: meme.examples, drift: meme.drift,
      birth_circa: meme.birth.circa, matcher: meme.matcher,
    }, ev)
    let res = await call(llm, db, system, user, model, opts.signal)
    tokens = res.tokens
    let parsed = tryParse(res.text)
    if (!parsed.out) {
      const [rs, ru] = prompts.buildRepairPrompt(res.text, parsed.errors)
      const res2 = await call(llm, db, rs, ru, model, opts.signal)
      tokens += res2.tokens
      parsed = tryParse(res2.text)
      if (!parsed.out) {
        throw llmCallFailed(`重归纳输出两轮未通过校验：${parsed.errors.join('; ').slice(0, 300)}`)
      }
    }
    out = parsed.out
  }

  const positives = [...ev.usages.map((u) => u.text as string).filter(Boolean), ...out.examples]
  const oldTerms = new Set([meme.name, ...meme.aliases])
  const [meme2, bt, warnings, revisions, degraded] = await gateAndBuild(db, cfg, out, {
    base: meme, positives,
    llm: opts.entry !== undefined ? null : llm,
    model, strict: opts.entry !== undefined, force: opts.force ?? false,
  })

  // 语义漂移留痕：释义实质性变化 → drift 自动记一笔（人写分期仍走 edit --drift）
  if (meme.card.gist !== meme2.card.gist) {
    meme2.drift = [...meme2.drift, {
      period: meme2.updated_at.slice(0, 10),
      change: `释义修订：${meme.card.gist.slice(0, 40)} → ${meme2.card.gist.slice(0, 40)}`,
      evidence: 'iterate',
    }].slice(-8)
  }
  const vectors = await embedExamples(meme2, cfg)
  saveMeme(db, meme2, vectors)

  // 新收编的别名若有对应候选 → 收口
  for (const t of [meme2.name, ...meme2.aliases]) {
    if (oldTerms.has(t)) continue
    const c = byHead(db, t)
    if (c && c.state !== 'inducted') settleCandidate(db, c)
  }

  audit.record(db, meme2.id, 'iterate', 'edit', {
    model,
    evidence_usages: ev.usages.length,
    backtest: bt ? backtestToDict(bt) : null,
    old_gist: meme.card.gist,
    new_terms: [meme2.name, ...meme2.aliases].filter((t) => !oldTerms.has(t)).sort(),
    warnings,
    usage_tokens: tokens,
  })
  return { meme: meme2, model, backtest: bt, revisions, matcher_degraded: degraded, warnings, usage_tokens: tokens }
}

/** iterate 证据包：词条当前 matcher 在原始湖的野外命中 + 同头候选证据。 */
export function collectIterateEvidence(db: DatabaseSync, meme: Meme): prompts.EvidencePack {
  const usages: Array<Record<string, unknown>> = []
  if (meme.matcher) {
    const cm = new CompiledMatcher(meme)
    const rows = db.prepare(
      'SELECT rpid, oid, message, parent FROM lake_comments ORDER BY rpid DESC LIMIT 4000',
    ).all() as Row[]
    const msgByRpid = new Map(rows.map((r) => [r.rpid as number, r.message as string]))
    const seen = new Set<number>()
    for (const r of rows) {
      if (usages.length >= 24) break
      let ctx: string[] | null = null
      if (r.parent) {
        const p = msgByRpid.get(r.parent as number)
        if (p) ctx = [p, r.message as string]
      }
      const hit = matchCompiled(cm, r.message as string, ctx)
      if (hit && !seen.has(r.rpid as number)) {
        seen.add(r.rpid as number)
        usages.push(ctx ? { text: r.message, pair: ctx } : { text: r.message })
      }
    }
  }
  const candUsages: string[] = []
  for (const term of [meme.name, ...meme.aliases]) {
    const c = byHead(db, term)
    if (c) candUsages.push(...c.evidence_usages.map((u) => u.text))
  }
  for (const t of candUsages.slice(0, 8)) {
    if (!usages.some((u) => u.text === t)) usages.push({ text: t })
  }
  return {
    head: meme.name,
    kind: meme.class,
    channel: 'iterate',
    spread: { videos: 0, ups: 0, first: null, last: null },
    z: null,
    usages: usages.length ? usages : meme.examples.slice(0, 3).map((m) => ({ text: m })),
  }
}

function settleCandidate(db: DatabaseSync, cand: Candidate | null): void {
  if (!cand || cand.state === 'inducted') return
  db.prepare("UPDATE candidates SET state='inducted' WHERE cid=?").run(cand.cid)
}
