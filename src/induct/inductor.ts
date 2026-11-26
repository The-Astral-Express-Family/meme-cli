/**
 * 入库管线：add 与 iterate 共用一条闸门流水线——操作员（agent）亲写 entry，
 * 本地闸门（matcher 编译 → backtest）负责事实判断。ID 延迟分配：闸门全过之后才拿号。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { tx } from '../db.ts'
import * as audit from '../audit.ts'
import { allActive, get as getCand, save as saveCand } from '../candidates.ts'
import type { ResolvedConfig } from '../config.ts'
import { candidateNotFound, MemeError } from '../errors.ts'
import { allMemes, get as getMeme, save as saveMeme } from '../entries.ts'
import type { VectorAnchor } from '../entries.ts'
import { nextId } from '../ids.ts'
import { makeRng } from '../lake.ts'
import { CompiledMatcher, matchCompiled } from '../match/pipeline.ts'
import { matchTokensTerms } from '../match/skeleton.ts'
import { getEmbedder, vecToBlob } from '../match/vector.ts'
import { normalizeHead } from '../detect/evidence.ts'
import {
  type Candidate, type InductionOutput, InductionOutputSchema, type MatcherSpec,
  type Meme, nowIso, type UsageSample,
} from '../models.ts'
import { backtestToDict, runBacktest, splitDialogue, type BacktestResult } from './backtest.ts'
import { validateAndCompile } from './compileMatcher.ts'

export interface AddResult {
  meme: Meme
  backtest: BacktestResult | null
  matcher_degraded: boolean
  warnings: string[]
}

export function addResultToDict(res: AddResult): Record<string, unknown> {
  return {
    id: res.meme.id,
    name: res.meme.name,
    class: res.meme.class,
    state: res.meme.state,
    matcher: res.meme.matcher ? 'compiled' : 'vector-only',
    backtest: res.backtest ? backtestToDict(res.backtest) : null,
    warnings: res.warnings,
  }
}

export interface EvidenceOpts {
  cids?: string[]
  text?: string
  force?: boolean
  match_aliases?: boolean
  holdout_texts?: string[] | null
}

/** 新词条与库内其他词条同名/同别名 → 应走 iterate 而非重复入库。 */
export function findDuplicate(db: DatabaseSync, out: InductionOutput, excludeId?: string): Meme | null {
  for (const m of allMemes(db)) {
    if (m.id === excludeId || m.state === 'tombstone') continue
    const terms = new Set([m.name, ...m.aliases])
    if (terms.has(out.name) || out.aliases.some((a) => terms.has(a))) return m
  }
  return null
}

/** 先精确、再仅在前缀/包含匹配唯一时解析；所有显式 cid 在任何写库前预检。 */
function resolveEvidenceCandidates(db: DatabaseSync, opts: EvidenceOpts): Candidate[] {
  const ids = [...new Set(opts.cids ?? [])]
  const resolved = new Map<string, Candidate>()
  for (const id of ids) {
    const cand = getCand(db, id)
    if (!cand) throw candidateNotFound(id)
    resolved.set(cand.cid, cand)
  }
  if (opts.text) {
    const query = normalizeHead(opts.text)
    const active = allActive(db)
    const exact = active.filter((c) => normalizeHead(c.head) === query)
    const pool = exact.length ? exact : active.filter((c) => {
      const head = normalizeHead(c.head)
      return head.startsWith(query) || head.includes(query) || query.includes(head)
    })
    if (pool.length > 1) {
      throw new MemeError(
        'MEME_CANDIDATE_AMBIGUOUS', `文本匹配到多个候选：${pool.map((c) => `${c.cid}(${c.head})`).join('、')}`,
        `用 --cid 明确指定：${pool.map((c) => c.cid).join(' / ')}。`,
      )
    }
    if (pool[0]) resolved.set(pool[0].cid, pool[0])
  }
  return [...resolved.values()]
}

/** --match-aliases 才把非槽位别名并入 lex；交互梗绝不增加可绕过上下文的词表命中。 */
function applyAliasMatching(out: InductionOutput): InductionOutput {
  const matched = structuredClone(out)
  if (!matched.matcher || matched.class === 'interaction'
    || matched.matcher.patterns.some((p) => p.kind === 'interaction')) return matched
  const aliases = [...new Set(matched.aliases.map((a) => a.trim()).filter((a) => a && !a.includes('<')))]
  if (!aliases.length) return matched
  const lex = matched.matcher.patterns.filter((p) => p.kind === 'lex')
  if (!lex.length) matched.matcher.patterns.push({ kind: 'lex', terms: [...aliases], tokens: [], trigger_terms: [], trigger_tokens: [], response_terms: [], response_tokens: [] })
  else for (const p of lex) p.terms = [...new Set([...p.terms, ...aliases])]
  return matched
}

/** 候选用例是否命中 canonical 正例口径：词条名、实际 lex terms、skeleton 槽位形状或交互回应。
 * aliases 只有开启 --match-aliases 后才会进入 lex terms；默认元数据别名不作为回测正例口径。 */
function matchesCanonicalEvidence(out: InductionOutput, text: string): boolean {
  const normalized = normalizeHead(text)
  if (!out.name.includes('<') && normalized.includes(normalizeHead(out.name))) return true
  return (out.matcher?.patterns ?? []).some((p) => {
    if (p.kind === 'lex') return p.terms.some((term) => normalized.includes(normalizeHead(term)))
    if (p.kind === 'skeleton') return Boolean(matchTokensTerms(text, p.tokens, []))
    return Boolean(matchTokensTerms(text, p.response_tokens, p.response_terms))
  })
}

interface HoldoutSample extends UsageSample { source?: 'wild' | 'candidate' | 'example' }

function isInteraction(out: InductionOutput): boolean {
  return out.class === 'interaction' || (out.matcher?.patterns ?? []).some((p) => p.kind === 'interaction')
}

function hasValidHoldoutPair(out: InductionOutput, texts: string[], ctxs: Array<string[] | null>): boolean {
  const [current, contexts] = splitDialogue(texts, ctxs)
  return current.some((_text, i) => {
    const ctx = contexts[i]
    if (!ctx || ctx.length < 2) return false
    return (out.matcher?.patterns ?? []).some((p) => p.kind === 'interaction'
      && matchTokensTerms(ctx[0], p.trigger_tokens, p.trigger_terms))
  })
}

function validInteractionPair(db: DatabaseSync, sample: HoldoutSample, out: InductionOutput): boolean {
  if (!sample.parent) return false
  const row = db.prepare('SELECT message FROM lake_comments WHERE rpid=?').get(sample.parent) as Row | undefined
  if (!row) return false
  const parent = row.message as string
  return (out.matcher?.patterns ?? []).some((p) => p.kind === 'interaction'
    && matchTokensTerms(parent, p.trigger_tokens, p.trigger_terms)
    && matchTokensTerms(sample.text, p.response_tokens, p.response_terms))
}

/** 留出集构建：候选用例按 canonical keys 去污染，直接洗牌样本以保留 pair/parent。 */
/** 独立证据先过 canonical 正例口径；交互证据还必须有有效触发对。 */
function eligibleHoldoutSamples(
  db: DatabaseSync, samples: HoldoutSample[], out: InductionOutput,
): HoldoutSample[] {
  let eligible = samples.filter((u) => u.text && u.text.trim()).filter((u) => {
    if (u.source !== 'candidate') return true
    return matchesCanonicalEvidence(out, u.text)
  })
  if (isInteraction(out)) eligible = eligible.filter((u) => validInteractionPair(db, u, out))
  return eligible
}

function buildHoldout(
  db: DatabaseSync, samples: HoldoutSample[], out: InductionOutput, holdoutRatio: number,
): { texts: string[]; ctxs: Array<string[] | null> } {
  const eligible = eligibleHoldoutSamples(db, samples, out)
  if (isInteraction(out) && !eligible.length) {
    throw new MemeError(
      'MEME_INTERACTION_EVIDENCE_REQUIRED', '没有可用的交互触发对作为留出集',
      '提供至少一条“上句：X 本句：Y”的 --holdout-text，或补充带父评的候选证据。',
    )
  }
  if (!eligible.length) {
    throw new MemeError(
      'MEME_HOLDOUT_REQUIRED', '候选用例都没有命中 canonical evidence keys，无法构建独立留出集',
      '用可重复的 --holdout-text 提供未参与归纳的例句；不要回退到污染全集。',
    )
  }
  const shuffled = [...eligible]
  const rnd = makeRng(42)
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const holdout = shuffled.slice(0, Math.max(1, Math.floor(shuffled.length * holdoutRatio)))
  const ctxs = holdout.map((u) => {
    if (!u.parent) return null
    const row = db.prepare('SELECT message FROM lake_comments WHERE rpid=?').get(u.parent) as Row | undefined
    return row ? [row.message as string, u.text] : null
  })
  return { texts: holdout.map((u) => u.text), ctxs }
}

async function embedExamples(meme: Meme, cfg: ResolvedConfig): Promise<VectorAnchor[]> {
  const texts = [...meme.examples, ...meme.card.usage].slice(0, 10)
  if (!texts.length) return []
  const emb = getEmbedder(cfg.retrieval.embed_model)
  const vecs = await emb.embed(texts)
  if (!vecs) return []
  return vecs.map((v, i) => ({ idx: i, text: texts[i], dim: v.length, vec: vecToBlob(v) }))
}

/** 共享闸门：matcher 编译 → backtest → 词条构建。strict 路径不达标抛错，宽松路径降级纯向量。 */
async function gateAndBuild(
  db: DatabaseSync,
  cfg: ResolvedConfig,
  out: InductionOutput,
  opts: {
    base?: Meme | null
    positives?: string[]
    holdout_texts?: string[] | null
    holdout_ctx?: Array<string[] | null> | null
    strict?: boolean
    force?: boolean
    /** 未声明 platform 时的回落标签（surf 候选 = bilibili，其余来源 []）。 */
    platform?: string[]
  },
): Promise<[Meme, BacktestResult | null, string[], boolean]> {
  const warnings: string[] = []
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
    bt = runBacktest(db, meme, new CompiledMatcher(meme), pos, {
      holdout: cfg.backtest.holdout,
      holdout_texts: opts.holdout_texts || null,
      holdout_ctx: opts.holdout_ctx || null,
      min_hit: cfg.backtest.min_hit,
      max_fp: cfg.backtest.max_fp,
      negatives: cfg.backtest.negatives,
    })
    if (!bt.passed) {
      if (strict && !force) {
        const detail = `留出命中 ${pct(bt.hit_rate)}（门槛 ${pct(cfg.backtest.min_hit)}），`
          + `误报 ${bt.fp_rate.toFixed(1)}（门槛 ${cfg.backtest.max_fp}）；`
          + `漏报 ${bt.missed.length} 例、误报 ${bt.false_hits.length} 例`
        const examples = [...bt.missed.slice(0, 3), ...bt.false_hits.slice(0, 3)].join('; ').slice(0, 200)
        throw new MemeError(
          'MEME_BACKTEST_FAIL', `backtest 未达标：${detail}。样例：${examples}`,
          '按漏报/误报样例修订 matcher 后重试；确认纯向量入库可加 --force。',
        )
      }
      meme.matcher = null
      warnings.push('backtest 未达标，降级为纯向量词条（仍可被 search 检索）')
    }
  }
  const degraded = meme.matcher === null && out.matcher !== null
  if (!meme.id) meme.id = nextId(db, 'm') // 延迟分配：闸门全过才拿号
  return [meme, bt, warnings, degraded]
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

function parseEntry(entryData: unknown): InductionOutput {
  const parsed = InductionOutputSchema.safeParse(entryData)
  if (!parsed.success || !parsed.data.card?.gist) {
    throw new MemeError(
      'MEME_ENTRY_INVALID',
      `词条 JSON 校验失败：${(parsed.success ? 'card.gist 缺失' : parsed.error.message).slice(0, 400)}`,
      'entry schema 见 meme 手册（skill meme 展开后的 entry JSON schema 段）。',
    )
  }
  return parsed.data
}

/** add：操作员亲写词条入库。cid/text 只用于关联证据与收口，本地闸门全数保留。 */
export async function runAddEntry(
  db: DatabaseSync, cfg: ResolvedConfig, entryData: unknown, opts: EvidenceOpts = {},
): Promise<AddResult> {
  const parsed = parseEntry(entryData)
  const out = opts.match_aliases ? applyAliasMatching(parsed) : parsed
  const cands = resolveEvidenceCandidates(db, opts)

  const dup = findDuplicate(db, out)
  if (dup) {
    throw new MemeError(
      'MEME_DUPLICATE',
      `词条名/别名与已有词条 ${dup.id}（${dup.name}）冲突`,
      `用 meme iterate 修订 ${dup.id}；确属不同梗请改用不冲突的名字。`,
    )
  }

  const explicit = opts.holdout_texts?.filter((t) => t && t.trim()) ?? []
  const samples = cands.flatMap((c) => c.evidence_usages.map((u) => ({ ...u, source: 'candidate' as const })))
  const eligible = out.matcher ? eligibleHoldoutSamples(db, samples, out) : []
  const positives = [...new Set([...out.examples, ...eligible.map((u) => u.text)])]
  let holdoutTexts: string[] | null = explicit.length ? explicit : null
  let holdoutCtx: Array<string[] | null> | null = null
  if ((!holdoutTexts || !holdoutTexts.length) && cands.length && out.matcher !== null) {
    const h = buildHoldout(db, samples, out, cfg.backtest.holdout)
    holdoutTexts = h.texts
    holdoutCtx = h.ctxs
  }
  if (isInteraction(out) && !hasValidHoldoutPair(out, holdoutTexts ?? [], holdoutCtx ?? [])
    && !eligible.some((u) => validInteractionPair(db, u, out))) {
    throw new MemeError(
      'MEME_INTERACTION_EVIDENCE_REQUIRED', '交互梗至少需要一个有效触发对',
      '提供至少一条“上句：X 本句：Y”的 --holdout-text，或补充带父评的候选证据。',
    )
  }
  const [meme, bt, warnings, degraded] = await gateAndBuild(db, cfg, out, {
    positives, holdout_texts: holdoutTexts, holdout_ctx: holdoutCtx,
    platform: cands.length ? ['bilibili'] : [],
    strict: true, force: opts.force ?? false,
  })

  const vectors = await embedExamples(meme, cfg)
  // 词条+FTS+向量、候选收口、审计日志整体提交：中断不会留下"词条已入库但
  // 候选没收口/审计缺失"的半步状态（saveMeme 拆开写时曾有这个窗口）
  const closed = tx(db, () => {
    saveMeme(db, meme, vectors)
    const closed = settleCandidates(db, meme, cands)
    audit.record(db, meme.id, 'induct', 'add', {
      evidence_heads: cands.map((c) => c.head),
      evidence_head: cands[0]?.head ?? (opts.text ?? '').slice(0, 20),
      entry_notes: out.notes,
      backtest: bt ? backtestToDict(bt) : null,
      forced_vector_only: degraded,
      force_used: Boolean(opts.force),
      closed_cids: closed.cids,
      closed_heads: closed.heads,
    })
    return closed
  })
  return { meme, backtest: bt, matcher_degraded: degraded, warnings }
}

/** iterate：带证据亲写修订版，原位更新并保留 id/state/stats。 */
export async function runIterate(
  db: DatabaseSync, cfg: ResolvedConfig, mid: string,
  opts: EvidenceOpts & { entry: unknown },
): Promise<AddResult> {
  const meme = getMeme(db, mid)
  if (!meme) {
    throw new MemeError('MEME_NOT_FOUND', `未找到词条：${mid}`, '用 meme search 找到目标词条 id 后重试。')
  }
  const parsed = parseEntry(opts.entry)
  const out = opts.match_aliases ? applyAliasMatching(parsed) : parsed
  const cands = resolveEvidenceCandidates(db, opts)
  const dup = findDuplicate(db, out, meme.id)
  if (dup) {
    throw new MemeError(
      'MEME_DUPLICATE', `词条名/别名与已有词条 ${dup.id}（${dup.name}）冲突`,
      `确属不同梗请改用不冲突的名字；修订 ${meme.id} 时可保留原词条名。`,
    )
  }
  const ev = collectIterateEvidence(db, meme, cands)
  const independentSamples = ev.usages.map(recordToSample)
  const eligibleIndependent = out.matcher
    ? eligibleHoldoutSamples(db, independentSamples, out).filter((u) => u.source !== 'example')
    : []
  const restoringMatcher = meme.matcher === null && out.matcher !== null
  const explicitHoldout = opts.holdout_texts?.filter((t) => t && t.trim()) ?? []
  const matcherEvidenceForced = restoringMatcher && eligibleIndependent.length === 0 && !explicitHoldout.length && Boolean(opts.force)
  if (restoringMatcher && eligibleIndependent.length === 0 && !explicitHoldout.length && !opts.force) {
    throw new MemeError(
      'MEME_MATCHER_EVIDENCE_REQUIRED', '从纯向量词条恢复 compiled matcher 需要独立野外或候选证据',
      '补充 --cid 关联候选，或用 --holdout-text 提供独立留出例句；确需绕过可再次加 --force。',
    )
  }

  const positives = [...new Set([...out.examples, ...eligibleIndependent.map((u) => u.text)])]
  let holdoutTexts: string[] | null = explicitHoldout.length ? explicitHoldout : null
  let holdoutCtx: Array<string[] | null> | null = null
  if ((!holdoutTexts || !holdoutTexts.length) && out.matcher !== null && eligibleIndependent.length > 0) {
    const h = buildHoldout(db, eligibleIndependent, out, cfg.backtest.holdout)
    holdoutTexts = h.texts
    holdoutCtx = h.ctxs
  }
  if (isInteraction(out) && !hasValidHoldoutPair(out, holdoutTexts ?? [], holdoutCtx ?? [])
    && !eligibleIndependent.some((u) => validInteractionPair(db, u, out))) {
    throw new MemeError(
      'MEME_INTERACTION_EVIDENCE_REQUIRED', '交互梗至少需要一个有效触发对',
      '提供至少一条“上句：X 本句：Y”的 --holdout-text，或补充带父评的独立证据。',
    )
  }
  const oldTerms = new Set([meme.name, ...meme.aliases])
  const [meme2, bt, warnings, gateDegraded] = await gateAndBuild(db, cfg, out, {
    base: meme, positives, holdout_texts: holdoutTexts, holdout_ctx: holdoutCtx,
    strict: true, force: opts.force ?? false,
  })
  let degraded = gateDegraded
  if (matcherEvidenceForced && meme2.matcher !== null) {
    meme2.matcher = null
    degraded = true
    warnings.push('缺少独立证据，显式 --force 仍降级为纯向量词条（未用自写 examples 恢复 matcher）')
  }

  if (meme.card.gist !== meme2.card.gist) {
    meme2.drift = [...meme2.drift, {
      period: meme2.updated_at.slice(0, 10),
      change: `释义修订：${meme.card.gist.slice(0, 40)} → ${meme2.card.gist.slice(0, 40)}`,
      evidence: 'iterate',
    }].slice(-8)
  }
  const vectors = await embedExamples(meme2, cfg)
  const closed = tx(db, () => {
    saveMeme(db, meme2, vectors)
    const closed = settleCandidates(db, meme2, cands)
    audit.record(db, meme2.id, 'iterate', 'edit', {
      evidence_usages: ev.usages.length,
      independent_evidence_usages: ev.independent_usages,
      backtest: bt ? backtestToDict(bt) : null,
      old_gist: meme.card.gist,
      new_terms: [meme2.name, ...meme2.aliases].filter((t) => !oldTerms.has(t)).sort(),
      warnings,
      forced_vector_only: degraded,
      force_used: Boolean(opts.force),
      matcher_evidence_forced: matcherEvidenceForced,
      closed_cids: closed.cids,
      closed_heads: closed.heads,
    })
    return closed
  })
  return { meme: meme2, backtest: bt, matcher_degraded: degraded, warnings }
}

function recordToSample(u: Record<string, unknown>): HoldoutSample {
  return {
    text: String(u.text ?? ''), aid: Number(u.aid ?? 0), rpid: Number(u.rpid ?? 0),
    root: Number(u.root ?? 0), parent: Number(u.parent ?? 0), mid: Number(u.mid ?? 0),
    ctime: Number(u.ctime ?? 0), chain: Boolean(u.chain),
    source: u.source === 'wild' || u.source === 'candidate' ? u.source : 'example',
  }
}

/** iterate 证据包：保留完整 UsageSample 与 pair/parent；候选证据跨通道按 canonical terms 精确收集。 */
export function collectIterateEvidence(db: DatabaseSync, meme: Meme, extraCandidates: Candidate[] = []): EvidencePack {
  const usages: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const push = (sample: UsageSample, source: 'wild' | 'candidate'): void => {
    const key = `${source}\x00${sample.rpid}\x00${sample.text}`
    if (seen.has(key)) return
    seen.add(key)
    let pair: string[] | null = null
    if (sample.parent) {
      const row = db.prepare('SELECT message FROM lake_comments WHERE rpid=?').get(sample.parent) as Row | undefined
      if (row) pair = [row.message as string, sample.text]
    }
    usages.push({ ...sample, source, ...(pair ? { pair } : {}) })
  }
  if (meme.matcher) {
    const cm = new CompiledMatcher(meme)
    const rows = db.prepare(
      'SELECT rpid, oid, root, parent, mid, message, ctime FROM lake_comments ORDER BY rpid DESC LIMIT 4000',
    ).all() as Row[]
    for (const r of rows) {
      if (usages.filter((u) => u.source === 'wild').length >= 24) break
      const sample: UsageSample = {
        text: r.message as string, aid: r.oid as number, rpid: r.rpid as number,
        root: r.root as number, parent: r.parent as number, mid: r.mid as number,
        ctime: r.ctime as number, chain: false,
      }
      let ctx: string[] | null = null
      if (sample.parent) {
        const parent = db.prepare('SELECT message FROM lake_comments WHERE rpid=?').get(sample.parent) as Row | undefined
        if (parent) ctx = [parent.message as string, sample.text]
      }
      if (matchCompiled(cm, sample.text, ctx)) push(sample, 'wild')
    }
  }
  const terms = new Set([meme.name, ...meme.aliases].map(normalizeHead))
  const cands = [...extraCandidates, ...allActive(db).filter((c) => terms.has(normalizeHead(c.head)))]
  const seenCids = new Set<string>()
  for (const c of cands) {
    if (seenCids.has(c.cid)) continue
    seenCids.add(c.cid)
    for (const u of c.evidence_usages) push(u, 'candidate')
  }
  const independent = usages.filter((u) => u.source === 'wild' || u.source === 'candidate').length
  return {
    head: meme.name,
    kind: meme.class,
    channel: 'iterate',
    spread: { videos: 0, ups: 0, first: null, last: null },
    z: null,
    independent_usages: independent,
    usages: usages.length ? usages.slice(0, 48) : meme.examples.slice(0, 3).map((text) => ({ text, source: 'example' })),
  }
}

export interface EvidencePack {
  head: string
  kind: string
  channel: string
  spread: { videos: number; ups: number; first: string | null; last: string | null }
  z: number | null
  independent_usages: number
  usages: Array<Record<string, unknown>>
}

/** 成功后收口显式 cids + 所有 head 精确等于 canonical name/aliases 的 active 候选。 */
function settleCandidates(
  db: DatabaseSync, meme: Meme, explicit: Candidate[],
): { cids: string[]; heads: string[] } {
  const terms = new Set([meme.name, ...meme.aliases].map(normalizeHead))
  const pool = new Map<string, Candidate>()
  for (const c of [...explicit, ...allActive(db).filter((c) => terms.has(normalizeHead(c.head)))]) pool.set(c.cid, c)
  const cids: string[] = []
  const heads: string[] = []
  tx(db, () => {
    for (const c of pool.values()) {
      const current = getCand(db, c.cid)
      if (!current || (current.state !== 'pending' && current.state !== 'triggered')) continue
      current.state = 'inducted'
      current.updated_at = nowIso()
      if (!current.related.some((r) => r.id === meme.id && r.type === 'same_form')) {
        current.related = [...current.related, { id: meme.id, type: 'same_form' as const, score: 0.95 }].slice(0, 5)
      }
      saveCand(db, current)
      db.prepare("UPDATE candidates SET reject_reason='inducted' WHERE cid=?").run(current.cid)
      cids.push(current.cid)
      heads.push(current.head)
    }
  })
  return { cids, heads }
}
