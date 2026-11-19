/** 匹配流水线：①词表 → ②骨架 → ③交互位 → ④向量兜底。全本地执行。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { allMemes, get as getMeme } from '../entries.ts'
import type { Meme, PatternSpec, Constraints } from '../models.ts'
import { findTerms } from './lexicon.ts'
import { matchInteraction } from './interaction.ts'
import { compileTokens, matchSkeleton } from './skeleton.ts'
import { blobToVec, cosine, getEmbedder, type Embedder } from './vector.ts'

export const TIER_CONF = { 1: 0.95, 2: 0.9, 3: 0.8 } as const

export interface MatchHit {
  meme_id: string
  name: string
  class: string
  start: number
  end: number
  excerpt: string
  tier: number // 1 词表 | 2 骨架 | 3 交互 | 4 向量
  confidence: number
  method: string
}

export class CompiledMatcher {
  readonly meme: Meme
  readonly lexTerms: string[] = []
  readonly skeletonPatterns: RegExp[] = []
  readonly interactionPats: PatternSpec[] = []
  readonly constraints: Constraints | null

  constructor(meme: Meme) {
    this.meme = meme
    const spec = meme.matcher
    this.constraints = spec ? spec.constraints : null
    if (!spec) return
    for (const p of spec.patterns) {
      if (p.kind === 'lex') this.lexTerms.push(...(p.terms || []))
      else if (p.kind === 'skeleton') this.skeletonPatterns.push(compileTokens(p.tokens || []))
      else if (p.kind === 'interaction') this.interactionPats.push(p)
    }
  }
}

export function loadMatchers(db: DatabaseSync): CompiledMatcher[] {
  return allMemes(db).filter((m) => m.matcher !== null).map((m) => new CompiledMatcher(m))
}

const emptyConstraints = (): Constraints => ({
  standalone: false, sentence_final: false, forbid_inner: false,
  forbid_context: [], require_context: [], context_window: 12,
})

/** 对单个词条跑 ①②③，返回最高层命中。 */
export function matchCompiled(cm: CompiledMatcher, text: string, ctxLines: string[] | null): MatchHit | null {
  const cons = cm.constraints ?? emptyConstraints()
  const mk = (hit: { start: number; end: number }, matched: string, tier: 1 | 2 | 3, method: string): MatchHit => ({
    meme_id: cm.meme.id,
    name: cm.meme.name,
    class: cm.meme.class,
    start: hit.start,
    end: hit.end,
    excerpt: matched,
    tier,
    confidence: TIER_CONF[tier],
    method,
  })
  if (cm.lexTerms.length) {
    const hit = findTerms(text, cm.lexTerms, cons)
    if (hit) return mk(hit, hit.term, 1, 'lexicon')
  }
  for (const pat of cm.skeletonPatterns) {
    const hit = matchSkeleton(text, pat)
    if (hit) return mk(hit, hit.matched, 2, 'skeleton')
  }
  if (cm.interactionPats.length && ctxLines) {
    for (const p of cm.interactionPats) {
      const hit = matchInteraction(ctxLines, p)
      if (hit) return mk(hit, hit.matched, 3, 'interaction')
    }
  }
  return null
}

/** 重叠 span 去重：按 tier 升序处理，先到先得（高 tier 必然先入 kept）。 */
function dedup(hits: MatchHit[]): MatchHit[] {
  hits.sort((a, b) => a.tier - b.tier || b.end - b.start - (a.end - a.start) || (a.meme_id < b.meme_id ? -1 : 1))
  const kept: MatchHit[] = []
  for (const h of hits) {
    if (kept.some((k) => h.start < k.end && k.start < h.end)) continue
    kept.push(h)
  }
  kept.sort((a, b) => a.start - b.start || (a.meme_id < b.meme_id ? -1 : 1))
  return kept
}

/** read path 主入口：识别一段文本里的梗（命中 span + 置信度）。 */
export async function lookup(
  db: DatabaseSync,
  text: string,
  ctxLines: string[] | null = null,
  vectorThreshold = 0.6,
  embedder: Embedder | null = null,
  maxVectorHits = 3,
): Promise<MatchHit[]> {
  const matchers = loadMatchers(db)
  const hits: MatchHit[] = []
  // 约束否决集：词条含目标词但被位置/语境约束否决（"为什么不回答我？"）——
  // 向量层不得再为它报低置信回声（实战反馈的"回声残留"）
  const vetoed = new Set<string>()
  for (const cm of matchers) {
    const h = matchCompiled(cm, text, ctxLines)
    if (h) hits.push(h)
    else if (cm.lexTerms.some((t) => t && text.includes(t))) vetoed.add(cm.meme.id)
  }
  const deduped = dedup(hits)
  // ④ 向量兜底：整段文本做例句近邻（捕获未见变体；span 恒为全文，置信 ≤0.7）
  const emb = embedder ?? getEmbedder()
  if (emb.available) {
    const near = await vectorNearest(db, text, emb, maxVectorHits)
    for (const [memeId, score] of near) {
      if (score < vectorThreshold) continue
      if (deduped.some((h) => h.meme_id === memeId) || vetoed.has(memeId)) continue
      const m = getMeme(db, memeId)
      if (!m) continue
      deduped.push({
        meme_id: memeId, name: m.name, class: m.class,
        start: 0, end: text.length, excerpt: text.slice(0, 40),
        tier: 4, confidence: Math.min(score, 0.7), method: 'vector',
      })
    }
    deduped.sort((a, b) => a.tier - b.tier || b.confidence - a.confidence || (a.meme_id < b.meme_id ? -1 : 1))
  }
  return deduped
}

/** 查询向量 vs 全体例句向量（例句级），每词条取最佳例句。 */
export async function vectorNearest(
  db: DatabaseSync, text: string, embedder: Embedder, topk = 5,
): Promise<Array<[string, number]>> {
  const rows = db.prepare('SELECT meme_id, idx, dim, vec FROM meme_vectors ORDER BY meme_id, idx').all() as Row[]
  if (!rows.length) return []
  const q = await embedder.embed([text])
  if (!q || !q.length) return []
  const query = q[0]
  const best = new Map<string, number>()
  let dimMismatch = false
  for (const r of rows) {
    const dim = r.dim as number
    if (dim !== query.length) { // 库内残留异维度向量（更换 embed 模型后未重建）→ 优雅降级
      dimMismatch = true
      break
    }
    const s = cosine(blobToVec(r.vec as Uint8Array), query)
    const mid = r.meme_id as string
    if (s > (best.get(mid) ?? -1)) best.set(mid, s)
  }
  if (dimMismatch) {
    console.error('meme: 向量库维度不一致（曾更换 embed 模型？），本次跳过向量兜底')
    return []
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, topk)
}

/** 批量野外复查（surf 用）：①②③层。texts 为 (文本, 会话上下文|null) 对。 */
export function scanTexts(
  matchers: CompiledMatcher[], texts: Array<[string, string[] | null]>,
): [Map<string, number>, Map<string, Set<string>>] {
  const counts = new Map<string, number>()
  const excerpts = new Map<string, Set<string>>()
  for (const [t, ctx] of texts) {
    for (const cm of matchers) {
      const h = matchCompiled(cm, t, ctx)
      if (h) {
        counts.set(cm.meme.id, (counts.get(cm.meme.id) ?? 0) + 1)
        if (!excerpts.has(cm.meme.id)) excerpts.set(cm.meme.id, new Set())
        excerpts.get(cm.meme.id)!.add(h.excerpt)
      }
    }
  }
  return [counts, excerpts]
}
