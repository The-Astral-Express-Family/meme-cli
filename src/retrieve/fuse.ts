/**
 * 混合检索：BM25 + 例句级向量 + RRF 融合。
 * tombstone 退出默认检索权重（检索权重才是被管理的稀缺资源）；fading 减半权重。
 * include_archived=true 可显式包含归档区。
 */
import type { DatabaseSync } from 'node:sqlite'
import { get as getMeme } from '../entries.ts'
import type { Meme } from '../models.ts'
import { vectorNearest } from '../match/pipeline.ts'
import { getEmbedder, type Embedder } from '../match/vector.ts'
import type { RetrievalConfig } from '../config.ts'
import { searchFts } from './fts.ts'

export interface SearchResult {
  meme: Meme
  score: number
  brief: string
}

export async function hybridSearch(
  db: DatabaseSync,
  query: string,
  cfg: RetrievalConfig,
  opts: { top?: number; includeArchived?: boolean; embedder?: Embedder } = {},
): Promise<SearchResult[]> {
  const top = opts.top ?? cfg.search_top
  const bm = searchFts(db, query, top * 2)
  const embedder = opts.embedder ?? getEmbedder(cfg.embed_model)
  let vec: Array<[string, number]> = []
  if (embedder.available) vec = await vectorNearest(db, query, embedder, top * 2)

  const k = cfg.rrf_k
  const scores = new Map<string, number>()
  const bump = (mid: string, rank: number) => scores.set(mid, (scores.get(mid) ?? 0) + 1 / (k + rank + 1))
  bm.forEach(([mid], rank) => bump(mid, rank))
  vec.forEach(([mid], rank) => bump(mid, rank))

  // 先按词条状态过滤并施加权重，再按加权分排序——权重在排序后施加则不改变名次
  const weighted: Array<[number, string, Meme]> = []
  for (const [mid, fused] of scores) {
    const m = getMeme(db, mid)
    if (!m) continue
    if (m.state === 'tombstone' && !opts.includeArchived) continue
    const w = m.state === 'fading' ? 0.5 : 1
    weighted.push([fused * w, mid, m])
  }
  weighted.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1))

  const out: SearchResult[] = []
  for (const [score, , m] of weighted) {
    out.push({ meme: m, score: Math.round(score * 1e5) / 1e5, brief: briefOf(m) })
    if (out.length >= top) break
  }
  return out
}

function briefOf(m: Meme): string {
  const aggression = m.card.aggression || '-'
  return `${m.id} ${m.name} | ${m.class}梗 | ${m.card.gist} | 攻击性${aggression} | ${m.state}`
}
