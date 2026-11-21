/**
 * 入库管线：add 与 iterate 共用一条闸门流水线——操作员（agent）亲写 entry，
 * 本地闸门（matcher 编译 → backtest）负责事实判断。ID 延迟分配：闸门全过之后才拿号。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import * as audit from '../audit.ts'
import { byHead, get as getCand } from '../candidates.ts'
import type { ResolvedConfig } from '../config.ts'
import { candidateNotFound, MemeError } from '../errors.ts'
import { allMemes, get as getMeme, save as saveMeme } from '../entries.ts'
import type { VectorAnchor } from '../entries.ts'
import { nextId } from '../ids.ts'
import { makeRng } from '../lake.ts'
import { CompiledMatcher, matchCompiled } from '../match/pipeline.ts'
import { getEmbedder, vecToBlob } from '../match/vector.ts'
import {
  type Candidate, type InductionOutput, InductionOutputSchema, type MatcherSpec,
  type Meme, nowIso, type UsageSample,
} from '../models.ts'
import { backtestToDict, runBacktest, type BacktestResult } from './backtest.ts'
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

/** 新词条与库内词条同名/同别名 → 应走 iterate 而非重复入库。 */
export function findDuplicate(db: DatabaseSync, out: InductionOutput): Meme | null {
  for (const m of allMemes(db)) {
    if (m.state === 'tombstone') continue
    const terms = new Set([m.name, ...m.aliases])
    if (terms.has(out.name) || out.aliases.some((a) => terms.has(a))) return m
  }
  return null
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

/** add：操作员亲写词条入库。--cid/--text 只用于关联候选证据与收口，本地闸门全数保留。 */
export async function runAddEntry(
  db: DatabaseSync, cfg: ResolvedConfig, entryData: unknown,
  opts: { cid?: string; text?: string; force?: boolean } = {},
): Promise<AddResult> {
  const out = parseEntry(entryData)

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
    const h = buildHoldout(db, cand, cfg.backtest.holdout)
    holdoutTexts = h.texts
    holdoutCtx = h.ctxs
  }
  const [meme, bt, warnings, degraded] = await gateAndBuild(db, cfg, out, {
    positives, holdout_texts: holdoutTexts, holdout_ctx: holdoutCtx,
    platform: opts.cid ? ['bilibili'] : [],
    strict: true, force: opts.force ?? false,
  })

  const vectors = await embedExamples(meme, cfg)
  saveMeme(db, meme, vectors)
  settleCandidate(db, cand)
  audit.record(db, meme.id, 'induct', 'add', {
    evidence_head: cand ? cand.head : (opts.text ?? '').slice(0, 20),
    entry_notes: out.notes,
    backtest: bt ? backtestToDict(bt) : null,
    forced_vector_only: Boolean(opts.force && out.matcher !== null),
  })
  return { meme, backtest: bt, matcher_degraded: degraded, warnings }
}

/** iterate：操作员带新证据亲写修订版（原位更新，保留 id/state/stats）。首轮归纳常错，修订必须常做。 */
export async function runIterate(
  db: DatabaseSync, cfg: ResolvedConfig, mid: string,
  opts: { entry: unknown; force?: boolean },
): Promise<AddResult> {
  const meme = getMeme(db, mid)
  if (!meme) {
    throw new MemeError('MEME_NOT_FOUND', `未找到词条：${mid}`, '用 meme search 找到目标词条 id 后重试。')
  }
  const out = parseEntry(opts.entry)
  const ev = collectIterateEvidence(db, meme)

  const positives = [...ev.usages.map((u) => u.text as string).filter(Boolean), ...out.examples]
  const oldTerms = new Set([meme.name, ...meme.aliases])
  const [meme2, bt, warnings, degraded] = await gateAndBuild(db, cfg, out, {
    base: meme, positives, strict: true, force: opts.force ?? false,
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
    evidence_usages: ev.usages.length,
    backtest: bt ? backtestToDict(bt) : null,
    old_gist: meme.card.gist,
    new_terms: [meme2.name, ...meme2.aliases].filter((t) => !oldTerms.has(t)).sort(),
    warnings,
  })
  return { meme: meme2, backtest: bt, matcher_degraded: degraded, warnings }
}

/** iterate 证据包：词条当前 matcher 在原始湖的野外命中 + 同头候选证据（backtest 正例来源）。 */
export function collectIterateEvidence(db: DatabaseSync, meme: Meme): EvidencePack {
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

export interface EvidencePack {
  head: string
  kind: string
  channel: string
  spread: { videos: number; ups: number; first: string | null; last: string | null }
  z: number | null
  usages: Array<Record<string, unknown>>
}

function settleCandidate(db: DatabaseSync, cand: Candidate | null): void {
  if (!cand || cand.state === 'inducted') return
  db.prepare("UPDATE candidates SET state='inducted' WHERE cid=?").run(cand.cid)
}
