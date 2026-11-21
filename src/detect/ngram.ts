/**
 * 短语通道：n-gram 抽取（word 类候选的主信号）。
 *
 * 结构性判别（不含任何"已知梗"知识——判别器不得预知梗词，否则丧失发现能力）：
 * - 表情/URL/@ 先切段、标点/空白再切段：gram 不跨标点（"太酷辣，直接"拼不出"太酷辣直接"）；
 * - gram 必须含至少一个实词/词典外成分（纯功能组合直接排除；词典外新词标 'x'
 *   视为内容——新梗恰恰在词典外）；
 * - 纯数字串是刷屏噪音。
 *
 * 首/尾 FUNC_WORDS 词表规则已废除：该表曾把功能词开头结尾的句式热梗
 * （我记下了/那咋了/乐子人/属于是）系统性误杀——功能词头僵尸组合与句式梗
 * 在 gram 层面无结构差异，只能靠用法证据（signals 层的"独立成评率"闸门）
 * 按用例拦截，不按词表拉黑。
 */
import { segment, segmentTagged } from '../tokenize.ts'
import { PUNCT, RE_REPLY_PREFIX, RE_SUB } from './skel.ts'

const SEG_SEP = '\x01'
const RE_HAS_CONTENT = /[\u4e00-\u9fffA-Za-z0-9]/

/** gram 规格上限（signals 层的非极大抑制在判定扩展时也用同一规格）。 */
export const GRAM_MAX_TOKENS = 5
export const GRAM_MAX_CHARS = 14

/** 标点/空白切段：gram 不得跨越任何标点（槽位段早于标点切分，槽名不经过分词器）。 */
const RE_PUNCT_SPLIT = new RegExp(`[${escapeRegex(PUNCT)}]`)

/**
 * 纯功能词性（北大词性标记）：gram 只要有任一实词/未知词成分即可入选（发现优先）。
 * 'm'（量词）不在此列："一眼"标 m，而它是活跃梗词（一眼丁真）；纯数量组合由
 * FUNC_WORDS 与 df 闸门兜住。
 */
const FUNCTION_TAGS = new Set('dpcuyerqtwokeh'.split(''))

export const isContentTag = (tag: string): boolean => !FUNCTION_TAGS.has(tag)

const RE_PURE_DIGIT = /^[0-9０-９]+$/

/** 保留一切非标点 token（含虚词——gram 级内容性检查再管）；纯数字串是刷屏噪音。 */
export function keepToken(tok: string): boolean {
  if (!tok || PUNCT.includes(tok)) return false
  if (RE_PURE_DIGIT.test(tok)) return false
  return RE_HAS_CONTENT.test(tok)
}

/** gram 的 token 索引闭区间（同句重复出现各记一次——叠用句的计数按位置保留）。 */
export interface GramSpan {
  text: string
  start: number
  end: number
}

/** 单句的 token 列表、段归属与全部 gram span（1..GRAM_MAX_TOKENS token，总字长 ≤ GRAM_MAX_CHARS）。
 * segOf[tokenIdx] = 段编号；每个标点/表情切出的 chunk 即一段——gram 不跨段，
 * 扩展判定（signals 层）也必须同段，否则模板句的段内 gram 会被假抑制。 */
export function gramSpans(text: string, maxTokens = GRAM_MAX_TOKENS, maxChars = GRAM_MAX_CHARS): {
  tokens: string[]
  spans: GramSpan[]
  segOf: number[]
} {
  const stripped = text.replace(RE_REPLY_PREFIX, '') // 楼中楼 UI 前缀不是评论内容
  const plain = stripped.replace(RE_SUB, ` ${SEG_SEP} `)
  const tokens: string[] = []
  const segOf: number[] = []
  const spans: GramSpan[] = []
  const chunks: string[] = []
  for (const segText of plain.split(SEG_SEP)) {
    for (const chunk of segText.split(RE_PUNCT_SPLIT)) {
      if (chunk.trim()) chunks.push(chunk)
    }
  }
  for (let seg = 0; seg < chunks.length; seg++) {
    const pairs = segmentTagged(chunks[seg]).filter((p) => keepToken(p.word))
    const base = tokens.length
    const tags = new Map(pairs.map((p) => [p.word, p.tag]))
    for (const p of pairs) {
      tokens.push(p.word)
      segOf.push(seg)
    }
    const m = pairs.length
    for (let n = 1; n <= maxTokens; n++) {
      for (let i = 0; i + n <= m; i++) {
        const gram = pairs.slice(i, i + n).map((p) => p.word)
        const hasContent = gram.some((t) => isContentTag(tags.get(t) ?? 'x'))
        if (!hasContent) continue // 纯功能组合
        const s = gram.join('')
        if (s.length > maxChars) continue
        spans.push({ text: s, start: base + i, end: base + i + n - 1 })
      }
    }
  }
  return { tokens, spans, segOf }
}

/** 产出去重的候选短语（1..5 token，总字长 ≤ maxChars）。gramSpans 的去重包装。 */
export function phrases(text: string, maxTokens = 5, maxChars = 14): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of gramSpans(text, maxTokens, maxChars).spans) {
    if (seen.has(s.text)) continue
    seen.add(s.text)
    out.push(s.text)
  }
  return out
}

export { segment }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\-/]/g, '\\$&')
}
