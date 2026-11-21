/**
 * 领域模型（zod）。`class` 是保留字但合法属性名，直接用。
 */
import { z } from 'zod'

export const KINDS = ['word', 'formula', 'format', 'interaction', 'event', 'derived'] as const
export const MEME_STATES = ['observing', 'active', 'fading', 'tombstone'] as const
export const CAND_STATES = ['pending', 'triggered', 'inducted', 'rejected'] as const
export const CHANNELS = ['phrase', 'skeleton', 'image', 'copy'] as const

/** 无损 JSON 值（canonical value 的载荷元素）。 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type JsonObject = { [k: string]: Json }

export type Kind = (typeof KINDS)[number]
export type MemeState = (typeof MEME_STATES)[number]
export type CandState = (typeof CAND_STATES)[number]

/** 本地时间戳（本地日界对 B站活跃时段更有意义；同格式词法可比）。 */
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
  platform: z.array(z.string()).default([]),
  state: z.enum(MEME_STATES).default('observing'),
  birth: BirthSchema.default({}),
  matcher: MatcherSpecSchema.nullable().default(null),
  card: CardSchema,
  examples: z.array(z.string()).default([]),
  drift: z.array(DriftEntrySchema).default([]),
  stats: MemeStatsSchema.default({}),
  wild_rounds: z.array(z.number().int()).default([]),
  /** 复活确认流：0 正常 / 1 待确认（show 时先给最小卡）/ 2 已确认。 */
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

/** 操作员亲写词条的结构（add/iterate entry 文件的校验目标）。 */
export const InductionOutputSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  class: z.enum(KINDS),
  birth_circa: z.string().nullable().default(null),
  card: CardSchema,
  examples: z.array(z.string()).default([]),
  matcher: MatcherSpecSchema.nullable().default(null),
  lineage_parent: z.string().nullable().default(null),
  lineage_mutation: z.string().nullable().default(null),
  notes: z.string().nullable().default(null), // 归纳者自述（进 audit 不进 card）
})
export type InductionOutput = z.infer<typeof InductionOutputSchema>

/** entry 文件的字段说明（shim 手册引用；写词条前通读一遍，防 matcher 误报设计）。 */
export const SCHEMA_DOC = `{
  "name": "词条名（最常见写法）",
  "aliases": ["别名/变体写法"],
  "class": "word|formula|format|interaction|event|derived",
  "birth_circa": "爆发起始，如 \\"2023\\" 或 \\"2023-08\\"（证据不足给年份，再不足给 null）",
  "card": {
    "gist": "一句话释义（≤60字）",
    "usage": ["典型用法短句 2-3 条"],
    "taboo": "禁忌用法/翻车场景（无则 null）",
    "register": "语域/圈层（无则 null）",
    "aggression": "低|中|高"
  },
  "examples": ["代表性例句 3-5 条，取自证据或其最小改写"],
  "matcher": {
    "patterns": [
      {"kind": "lex", "terms": ["字面词", "别名"]},
      {"kind": "skeleton", "tokens": ["一眼", "<ent>", "鉴定为", "<ent>"]},
      {"kind": "interaction", "trigger_terms": ["触发句特征词"], "response_terms": ["回应句特征词"],
       "trigger_tokens": [], "response_tokens": []}
    ],
    "constraints": {
      "standalone": false, "sentence_final": false, "forbid_inner": false,
      "forbid_context": ["命中span附近出现则否决，如 \\"古典\\""], "require_context": []
    }
  },
  "lineage_parent": "父词条 id（derived 时）否则 null",
  "lineage_mutation": "相对父梗的变异点（derived 时）否则 null",
  "notes": "不确定点、证据矛盾处的自述（只进审计日志，不进卡片）"
}
matcher 规则：
- word 类 → 用 lex terms + constraints；单字梗（如"典"）必须加约束防误报：
  forbid_inner=true（不得是更长词的一部分），必要时 standalone 或 sentence_final。
- formula/format 类 → 用 skeleton tokens；槽位：<num>数字、<ent>吞1-3个任意词（实体槽）、
  <emo>表情、<url>链接、<any>任意1-3词。骨架只固定"不变部分"，槽留给可变成分。
- interaction 类 → trigger（上一句特征）+ response（回应句特征），来自楼中楼对话对；
  例句可写成"上句：X 本句：Y"格式，backtest 会自动拆出会话上下文。
- event 类 → lex 名词短语即可，重心放 card（什么场合提它才对味）。
- patterns 可组合多条；constraints 全局作用于该词条。

constraints.forbid_context 精确语义（黑盒探测校准，照此设计）：
- 检查窗口 = 命中 span 两侧各 12 字（不含 span 内部）；
- forbid 词若与命中词本身重叠（如 forbid"回答我吗" vs 词"回答我"），实际检查的是
  它去掉重叠后的剩余部分（"吗"）是否出现在 span 后——这正是切割"祈使咆哮 vs
  正常疑问句"的用法：forbid ["？","吗","吧","呢","一下","请"] 压掉疑问用法；
- forbid_inner 与 forbid_context 组合覆盖"更长词的一部分"与"同词的非梗语用"两类误报。

backtest 边界（重要，避免虚假安全感）：负例取自原始湖随机采样且不含梗名/别名——
它验证 matcher 的**召回**与对无关文本的**粗误报**，但**不含**"含梗词的非梗用法"
（如"为什么不回答我？"）。这类边界行为必须由操作员自行构造对抗样本用 lookup 验证。`

/** 词条名 + 别名（匹配与重名检查用的词表）。 */
export function termsOf(m: Meme): string[] {
  return [m.name, ...m.aliases]
}