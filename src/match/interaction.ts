/**
 * 交互层（③）：trigger→response 配对，检查会话位置（interaction 类）。
 *
 * 配对样本源自楼中楼回复关系；匹配时需要调用方提供会话上文。
 */
import type { PatternSpec } from '../models.ts'
import { matchTokensTerms, type SkeletonHit } from './skeleton.ts'

/**
 * lines 为按时间序的会话文本（最后一行是待匹配行）。
 * 命中条件：最后一行匹配 response，且其前 ≤2 行内出现 trigger。
 * 返回最后一行上的 response span。
 */
export function matchInteraction(lines: string[], pat: PatternSpec): SkeletonHit | null {
  if (!lines.length) return null
  const last = lines[lines.length - 1]
  const resp = matchTokensTerms(last, pat.response_tokens, pat.response_terms)
  if (resp === null) return null
  for (const prev of lines.slice(-3, -1)) {
    if (matchTokensTerms(prev, pat.trigger_tokens, pat.trigger_terms)) return resp
  }
  return null
}
