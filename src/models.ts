/**
 * 领域模型（zod）。JSON 键与 Python v0.2 的 pydantic 序列化逐键一致——
 * 库内 JSON blob 双端可直接共享；`class` 是保留字但合法属性名，直接用。
 */
import { z } from 'zod'

export const KINDS = ['word', 'formula', 'format', 'interaction', 'event', 'derived'] as const
export const MEME_STATES = ['observing', 'active', 'fading', 'tombstone'] as const
export const CAND_STATES = ['pending', 'triggered', 'inducted', 'rejected'] as const
export const CHANNELS = ['phrase', 'skeleton', 'image', 'chain', 'copy'] as const

/** 无损 JSON 值（canonical value 的载荷元素）。 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type JsonObject = { [k: string]: Json }

export type Kind = (typeof KINDS)[number]
export type MemeState = (typeof MEME_STATES)[number]
export type CandState = (typeof CAND_STATES)[number]

/** 本地时间戳（与 Python time.strftime("%Y-%m-%dT%H:%M:%S") 同构）。 */
export function nowIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function todayIso(d = new Date()): string {
  return nowIso(d).slice(0, 10)
}

export const CardSchema = z.object({
  gist: z.string(),
  usage: z.array(z.string()).default([]),
  taboo: z.string().nullable().default(null),
  register: z.string().nullable().default(null),
  aggression: z.string().nullable().default(null),
})
export type Card = z.infer<typeof CardSchema>

export const UsageSampleSchema = z.object({
  text: z.string(),
  aid: z.number().int().default(0),
  rpid: z.number().int().default(0),
  root: z.number().int().default(0),
  parent: z.number().int().default(0),
  mid: z.number().int().default(0),
  ctime: z.number().int().default(0),
  chain: z.boolean().default(false), // 楼中楼短消息拼接（一人一字接龙）合成文本
})
export type UsageSample = z.infer<typeof UsageSampleSchema>

export const RelatedRefSchema = z.object({
  id: z.string(),
  type: z.enum(['same_form', 'derived', 'related']),
  score: z.number(),
})
export type RelatedRef = z.infer<typeof RelatedRefSchema>

/**
 * word/formula 类匹配的位置/语境约束 DSL：
 * - standalone：须单独成句（与 sentence_final 为 OR 语义，满足其一即可）
 * - sentence_final：须位于句尾
 * - forbid_inner：不得是更长 jieba token 的一部分（胶水字邻接不算）
 * - forbid_context / require_context：命中 span 两侧 N 字窗口内出现/必须出现
 */
export const ConstraintsSchema = z.object({
  standalone: z.boolean().default(false),
  sentence_final: z.boolean().default(false),
  forbid_inner: z.boolean().default(false),
  forbid_context: z.array(z.string()).default([]),
  require_context: z.array(z.string()).default([]),
  context_window: z.number().int().default(12),
})
export type Constraints = z.infer<typeof ConstraintsSchema>

export const PatternSpecSchema = z.object({
  kind: z.enum(['lex', 'skeleton', 'interaction']),
  terms: z.array(z.string()).default([]),
  tokens: z.array(z.string()).default([]),
  trigger_terms: z.array(z.string()).default([]),
  trigger_tokens: z.array(z.string()).default([]),
  response_terms: z.array(z.string()).default([]),
  response_tokens: z.array(z.string()).default([]),
})
export type PatternSpec = z.infer<typeof PatternSpecSchema>

export const MatcherSpecSchema = z.object({
  patterns: z.array(PatternSpecSchema).default([]),
  constraints: ConstraintsSchema.default({}),
})
export type MatcherSpec = z.infer<typeof MatcherSpecSchema>

const LineageSchema = z.object({
  parent: z.string().nullable().default(null),
  mutation: z.string().nullable().default(null),
})
export type Lineage = z.infer<typeof LineageSchema>

const BirthSchema = z.object({ circa: z.string().nullable().default(null) })
export type Birth = z.infer<typeof BirthSchema>

const DriftEntrySchema = z.object({
  period: z.string(),
  change: z.string(),
  evidence: z.string().nullable().default(null),
})
export type DriftEntry = z.infer<typeof DriftEntrySchema>

const MemeStatsSchema = z.object({
  wild_freq_30d: z.number().default(0),
  peak_freq: z.number().default(0),
  last_seen: z.string().nullable().default(null),
  last_matched_round: z.number().int().default(0),
})
export type MemeStats = z.infer<typeof MemeStatsSchema>

export const MemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  class: z.enum(KINDS).default('word'),
  lineage: LineageSchema.default({}),
  platform: z.array(z.string()).default(['bilibili']),
  state: z.enum(MEME_STATES).default('observing'),
  birth: BirthSchema.default({}),
  matcher: MatcherSpecSchema.nullable().default(null),
  card: CardSchema,
  examples: z.array(z.string()).default([]),
  drift: z.array(DriftEntrySchema).default([]),
  stats: MemeStatsSchema.default({}),
  wild_rounds: z.array(z.number().int()).default([]),
  /** 复活确认流计数：0 正常 / 1 首次 show 见最小卡 / 2 已确认过一次。必须 int——bool 会把 2 塌缩。 */
  revived_pending: z.number().int().default(0),
  created_at: z.string().default(() => nowIso()),
  updated_at: z.string().default(() => nowIso()),
})
export type Meme = z.infer<typeof MemeSchema>

export const CandidateSchema = z.object({
  cid: z.string(),
  head: z.string(),
  kind_guess: z.enum(KINDS).default('word'),
  channel: z.enum(CHANNELS).default('phrase'),
  state: z.enum(CAND_STATES).default('pending'),
  z_score: z.number().nullable().default(null),
  distinct_videos: z.number().int().default(0),
  distinct_ups: z.number().int().default(0),
  first_seen: z.string().default(() => nowIso()),
  last_seen: z.string().default(() => nowIso()),
  surfs_seen: z.number().int().default(0),
  last_round: z.number().int().default(0),
  evidence_usages: z.array(UsageSampleSchema).default([]),
  related: z.array(RelatedRefSchema).default([]),
  provenance: z.string().default('bilibili'),
  created_at: z.string().default(() => nowIso()),
  updated_at: z.string().default(() => nowIso()),
})
export type Candidate = z.infer<typeof CandidateSchema>

/** 归纳器一次调用必须产出的结构（LLM JSON 围栏的解析目标）。 */
export const InductionOutputSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  class: z.enum(KINDS),
  birth_circa: z.string().nullable().default(null),
  card: CardSchema,
  examples: z.array(z.string()).default([]),
  matcher: MatcherSpecSchema.nullable().default(null),
  /** 来源平台（bilibili/群聊/直播…）；空回落：surf 候选自动标 bilibili，否则 []。 */
  platform: z.array(z.string()).default([]),
  lineage_parent: z.string().nullable().default(null),
  lineage_mutation: z.string().nullable().default(null),
  notes: z.string().nullable().default(null), // 归纳器自述（进 audit 不进 card）
})
export type InductionOutput = z.infer<typeof InductionOutputSchema>

/** 词条名 + 别名（匹配与重名检查用的词表）。 */
export function termsOf(m: Meme): string[] {
  return [m.name, ...m.aliases]
}

/** 宽松 JSON 解析：坏数据回落默认值（读路径永不因存量脏数据崩溃）。 */
export function parseJson<T>(raw: string | null | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (!raw) return fallback
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    return fallback
  }
}
