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

/** 产出去重的候选短语（1..5 token，总字长 ≤ maxChars）。 */
export function phrases(text: string, maxTokens = 5, maxChars = 14): string[] {
  const stripped = text.replace(RE_REPLY_PREFIX, '') // 楼中楼 UI 前缀不是评论内容
  const plain = stripped.replace(RE_SUB, ` ${SEG_SEP} `)
  const out: string[] = []
  const seen = new Set<string>()
  for (const seg of plain.split(SEG_SEP)) {
    for (const chunk of seg.split(RE_PUNCT_SPLIT)) {
      if (!chunk.trim()) continue
      const pairs = segmentTagged(chunk).filter((p) => keepToken(p.word))
      const tags = new Map(pairs.map((p) => [p.word, p.tag]))
      const tokens = pairs.map((p) => p.word)
      for (let n = 1; n <= maxTokens; n++) {
        for (let i = 0; i + n <= tokens.length; i++) {
          const gram = tokens.slice(i, i + n)
          const hasContent = gram.some((t) => isContentTag(tags.get(t) ?? 'x'))
          if (!hasContent) continue // 纯功能组合
          const s = gram.join('')
          if (s.length > maxChars || seen.has(s)) continue
          seen.add(s)
          out.push(s)
        }
      }
    }
  }
  return out
}

export { segment }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\-/]/g, '\\$&')
}
