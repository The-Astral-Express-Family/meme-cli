/**
 * 词表层（①）：字面词表匹配 + 位置/语境约束 DSL 检查。
 *
 * 约束语义：
 * - forbid_inner：命中不得是更长词语的一部分（按分词判定，非字符邻接——
 *   "太典了"合法、"古典文学"否决）
 * - standalone / sentence_final：位置约束，二者启用其一时满足任一即可
 *   （"单独成句或句尾"）
 */
import type { Constraints } from '../models.ts'
import { segment } from '../tokenize.ts'

const SENT_END = '。！？!?…~\n'
const SENT_SEP = SENT_END + '，,；;、：: '
/** 紧贴梗词的常见胶水字：不算"更长词的一部分"（真典=真+典 合法，古典 否决）。 */
const GLUE_BEFORE = new Set('真太最更还好就是都也不很蛮贼巨直接'.split(''))
const GLUE_AFTER = new Set('了的吧啊呢嘛哦呀'.split(''))

/** 分词的字符区间（cut 无重叠覆盖原文）。 */
export function tokenSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let pos = 0
  for (const tok of segment(text)) {
    spans.push([pos, pos + tok.length])
    pos += tok.length
  }
  return spans
}

function insideLongerWord(
  text: string, spans: Array<[number, number]>, start: number, end: number,
): boolean {
  for (const [ts, te] of spans) {
    if (te <= start || ts >= end) continue
    if (ts < start) { // 命中起点落在 token 内部
      const prefix = text.slice(ts, start)
      if ([...prefix].some((ch) => !GLUE_BEFORE.has(ch))) return true
    }
    if (te > end) { // 命中终点落在 token 内部
      const suffix = text.slice(end, te)
      if ([...suffix].some((ch) => !GLUE_AFTER.has(ch))) return true
    }
  }
  return false
}

/** 对一处命中做约束检查。违反任一 → false。 */
export function checkConstraints(
  text: string,
  start: number,
  end: number,
  cons: Constraints,
  spans?: Array<[number, number]>,
  term = '',
): boolean {
  const before = text.slice(Math.max(0, start - 1), start)
  const after = text.slice(end, end + 1)
  if (cons.forbid_inner && insideLongerWord(text, spans ?? tokenSpans(text), start, end)) {
    return false
  }
  // 位置约束：启用的 standalone / sentence_final 满足其一即可
  const posOk: boolean[] = []
  if (cons.standalone) {
    const bOk = !before || SENT_SEP.includes(before) || GLUE_BEFORE.has(before)
    const aOk = !after || SENT_SEP.includes(after) || GLUE_AFTER.has(after)
    posOk.push(bOk && aOk)
  }
  if (cons.sentence_final) {
    posOk.push(!after || SENT_END.includes(after))
  }
  if (posOk.length && !posOk.some(Boolean)) return false
  if (cons.forbid_context.length || cons.require_context.length) {
    const w = cons.context_window
    const beforeWin = text.slice(Math.max(0, start - w), start)
    const afterWin = text.slice(end, end + w)
    // forbid 词与命中 span 重叠时，窗口（span 两侧）永远不含完整 forbid 词——
    // 语义陷阱（实战 8 发探测抓获）：改为检查 forbid 词去掉重叠部分后的剩余
    // 是否出现在窗口（"回答我吗" forbid vs span"回答我" → 查"吗"）
    for (const f of cons.forbid_context) {
      const probe = term && f.includes(term) ? f.replace(term, '') : f
      if (!probe) continue // forbid 词整个落在 span 内：恒真陷阱，忽略
      if (beforeWin.includes(probe) || afterWin.includes(probe)) return false
    }
    const required = cons.require_context.some(
      (r) => r && (beforeWin.includes(r) || afterWin.includes(r)),
    )
    if (cons.require_context.length && !required) return false
  }
  return true
}

export interface LexHit { start: number; end: number; term: string }

/** 返回第一个通过约束的命中。terms 按长度降序（长词优先）。 */
export function findTerms(text: string, terms: string[], cons: Constraints): LexHit | null {
  const spans = cons.forbid_inner ? tokenSpans(text) : undefined
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (!term) continue
    let start = text.indexOf(term)
    while (start !== -1) {
      const end = start + term.length
      if (checkConstraints(text, start, end, cons, spans, term)) {
        return { start, end, term }
      }
      start = text.indexOf(term, start + 1)
    }
  }
  return null
}

export function containsAny(text: string, terms: string[]): boolean {
  return terms.some((t) => t && text.includes(t))
}
