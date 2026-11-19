/**
 * 骨架层（②）：归一化 token 流上的带槽匹配（formula / format 类）。
 *
 * token 串以 \x00 连接后编译为正则：字面 token 精确匹配，槽位展开为通配。
 * 命中 span 由 token 偏移映射回原文本。
 */
import { normalizeSpanned } from '../detect/skel.ts'

const SEP = '\x00'

// 槽位必须在编译表内显式登记：<at> 曾靠"字面量恰好匹配 token 原文"碰巧可用
const SLOT_PAT: Record<string, string> = {
  '<num>': '<num>',
  '<emo>': '<emo>',
  '<url>': '<url>',
  '<at>': '<at>',
  // <ent>/<any>：吞 1-3 个任意 token（槽内方差大正是例句级向量的动机）
  '<ent>': `[^${SEP}]+(?:${SEP}[^${SEP}]+){0,2}`,
  '<any>': `[^${SEP}]+(?:${SEP}[^${SEP}]+){0,2}`,
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function compileTokens(tokens: string[]): RegExp {
  const parts: string[] = []
  for (const t of tokens) {
    if (t in SLOT_PAT) {
      parts.push(SLOT_PAT[t])
    } else {
      // 字面量允许穿越 token 边界：分词对"鉴定为"可能切成 [鉴定,为] 也可能保持
      // 整词——字符间允许 0-1 个分隔符，两种都命中
      parts.push([...t].map((ch) => escapeRe(ch)).join(`${SEP}?`))
    }
  }
  // 部件间分隔符同样可选：字面量可能结束在 token 中部（"为云"的"为"），
  // 下一部件需能接着同 token 内继续匹配
  return new RegExp(parts.join(`${SEP}?`))
}

export interface SkeletonHit { start: number; end: number; matched: string }

/** 在原文本上找骨架命中，返回 (start, end, matched_token_text)。 */
export function matchSkeleton(text: string, pattern: RegExp): SkeletonHit | null {
  const spanned = normalizeSpanned(text)
  if (!spanned.length) return null
  const stream = spanned.map((t) => t.token).join(SEP)
  const m = pattern.exec(stream)
  if (!m) return null
  // stream 偏移 → token 索引（按 SEP 边界计数）
  let tokStartIdx = 0
  let tokEndIdx = 0
  for (let i = 0; i < m.index; i++) if (stream[i] === SEP) tokStartIdx++
  for (let i = 0; i < m.index + m[0].length; i++) if (stream[i] === SEP) tokEndIdx++
  if (tokEndIdx >= spanned.length) tokEndIdx = spanned.length - 1
  const s = spanned[tokStartIdx].start
  const e = spanned[tokEndIdx].end
  const matched = text.slice(s, e)
  if (!matched.trim()) return null
  return { start: s, end: e, matched }
}

/** tokens 或 terms 二选一的骨架子模式匹配。 */
export function matchTokensTerms(
  text: string, tokens: string[], terms: string[],
): SkeletonHit | null {
  if (tokens.length) return matchSkeleton(text, compileTokens(tokens))
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const idx = text.indexOf(term)
    if (idx !== -1) return { start: idx, end: idx + term.length, matched: term }
  }
  return null
}
