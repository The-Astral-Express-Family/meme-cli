/** matcher 编译与校验：归纳描述 → 可执行匹配器。不合法抛 MatcherError（上游降级为纯向量词条）。 */
import { compileTokens } from '../match/skeleton.ts'
import type { MatcherSpec, PatternSpec } from '../models.ts'

const VALID_SLOTS = new Set(['<num>', '<ent>', '<emo>', '<url>', '<at>', '<any>'])

/** 非空且非槽位的字面 token 数。纯槽位模式会匹配一切文本，等价于无模式。 */
function literalCount(tokens: string[]): number {
  return tokens.filter((t) => t.trim() && !(t.startsWith('<') && t.endsWith('>'))).length
}

export function validateAndCompile(spec: MatcherSpec): MatcherSpec {
  if (!spec.patterns.length) throw new MatcherError('patterns 为空')
  for (const p of spec.patterns) {
    if (p.kind === 'lex') {
      p.terms = p.terms.filter((t) => t && t.trim()).map((t) => t.trim())
      if (!p.terms.length) throw new MatcherError('lex 模式缺少非空 terms')
    } else if (p.kind === 'skeleton') {
      p.tokens = p.tokens.filter((t) => t && t.trim())
      if (!p.tokens.length) throw new MatcherError('skeleton 模式缺少 tokens')
      if (literalCount(p.tokens) < 1) throw new MatcherError('skeleton 模式需至少一个字面 token（纯槽位会匹配一切）')
      for (const t of p.tokens) {
        if (t.startsWith('<') && !VALID_SLOTS.has(t)) throw new MatcherError(`未知槽位 ${t}`)
      }
      compileTokens(p.tokens) // 试编译
    } else if (p.kind === 'interaction') {
      p.trigger_terms = p.trigger_terms.filter((t) => t && t.trim())
      p.response_terms = p.response_terms.filter((t) => t && t.trim())
      p.trigger_tokens = p.trigger_tokens.filter((t) => t && t.trim())
      p.response_tokens = p.response_tokens.filter((t) => t && t.trim())
      const hasTrigger = p.trigger_terms.length > 0 || literalCount(p.trigger_tokens) >= 1
      const hasResponse = p.response_terms.length > 0 || literalCount(p.response_tokens) >= 1
      if (!(hasTrigger && hasResponse)) {
        throw new MatcherError('interaction 模式需要非空且含字面的 trigger 与 response')
      }
      if (p.trigger_tokens.length) compileTokens(p.trigger_tokens)
      if (p.response_tokens.length) compileTokens(p.response_tokens)
    } else {
      throw new MatcherError(`未知模式类型 ${(p as PatternSpec).kind}`)
    }
  }
  for (const f of [...spec.constraints.forbid_context, ...spec.constraints.require_context]) {
    if (!f.trim()) throw new MatcherError('约束词表含空串')
  }
  return spec
}

/** matcher 校验失败（上游降级为纯向量词条或转修订反馈）。 */
export class MatcherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MatcherError'
  }
}
