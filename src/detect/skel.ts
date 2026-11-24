/**
 * 骨架化：token 归一化后的模板形状，发现与匹配的共同基础。
 *
 * 归一化：数字→<num>、URL/BV号→<url>/<ent>、[表情]→<emo>、@用户→<at>。
 * 公式梗发现的"单槽掩码变体"法：对每条文本，除全归一化骨架外，另将实词串
 * 逐一替换为 <ent> 生成变体——可变实体位置因此在统计上显形，
 * "一眼原神鉴定为云玩家"与"一眼华为鉴定为遥遥领先"坍缩到同一骨架。
 */
import { createHash } from 'node:crypto'
import { segment } from '../tokenize.ts'

export const RE_SUB =
  /(https?:\/\/\S+|www\.\S+|b23\.tv\/\S+|bilibili\.com\/\S+|\bBV[0-9A-Za-z]{9,11}\b|\[[^[\]\r\n]{1,128}\]|@[^\s@：:，,。！？~]{1,30})/g
export const RE_NUMTOK = /^[0-9０-９]+([.,，][0-9０-９]+)*[%％]?$/
export const RE_CJK = /[\u4e00-\u9fff]/
const RE_LATIN = /^[A-Za-z]{3,}$/
/** 楼中楼 UI 前缀（"回复 @某人 ："）是界面残留不是评论内容，剥离防其污染骨架/短语。 */
export const RE_REPLY_PREFIX = /^\s*回复\s*@[^\s：:，,。！？]{1,30}\s*[:：]\s*/

export const SLOT_URL = '<url>'
export const SLOT_ENT = '<ent>'
export const SLOT_EMO = '<emo>'
export const SLOT_AT = '<at>'
export const SLOT_NUM = '<num>'

/**
 * 掩码时保留的虚词/功能词（不作为实体槽候选）；检索查询侧也用它降噪。
 * 此表只服务"槽位掩码"语义，禁止用作短语通道的首/尾词过滤——
 * 那会系统性误杀功能词开头结尾的句式梗（我记下了/乐子人/属于是曾全部被杀）。
 */
export const FUNC_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '咱', '们', '也', '都',
  '就', '和', '在', '有', '不', '没', '很', '太', '真', '啊', '吧', '吗',
  '呢', '哦', '哈', '呀', '着', '过', '与', '及', '或', '但', '因为', '所以',
  '如果', '这', '那', '被', '把', '让', '给', '对', '从', '向', '到', '说',
  '看', '来', '去', '个', '么', '什么', '怎么', '还是', '而且', '然后', '一个',
  // 实战 surf 分诊沉淀（round 4-14）：单/双字功能词是候选噪音主力
  '还', '好', '能', '人', '会', '做', '才', '又', '没有', '大', '里', '完',
  '多', '想', '已经', '这么', '那么', '这样', '那样', '真是', '真的', '可能',
  '应该', '一定', '其实', '确实', '现在', '时候', '知道', '觉得', '出来',
  '开始', '终于', '其他', '这些', '那些', '其中', '而已', '比如', '如果',
  '只是', '就是', '不是', '要是', '要是说', '居然', '竟然', '依然', '仍然',
  '突然', '忽然', '本来', '原来', '果然', '竟然', '首先', '然后', '最后',
  '第一', '第二', '反正', '难道', '毕竟', '居然', '稍微', '有点', '有些',
  '非常', '特别', '十分', '比较', '更加', '越来越',
  '以为', '好像', '不过', '这里', '一次', '需要', '是不是', '很多', '起来',
  '一样', '一点', '这是', '还有', '找到', '不了', '一下', '自己', '有人',
])

export const PUNCT = '，。！？；：、…—～·“”‘’()（）<>《》【】[].!?;:"\' \t\n'

/** 功能字：骨架通道里并入后随 token（吸收分词对"为云/为遥遥"的切分漂移）。 */
export const FUNC_CHARS = '为了的是在就都也还又再更最太真和跟对被把让向从到与及或'

function isFuncChar(ch: string): boolean {
  return FUNC_CHARS.includes(ch)
}

/** 骨架通道专用 token 整备：len≤2 且以功能字开头的 token 并入后随 token。 */
export function skeletonTokens(tokens: string[]): string[] {
  const out: string[] = []
  let pending = ''
  for (const t of tokens) {
    if (t.startsWith('<')) {
      out.push(pending + t)
      pending = ''
      continue
    }
    if (t.length <= 2 && t.length > 0 && isFuncChar(t[0])) {
      pending += t
      continue
    }
    out.push(pending + t)
    pending = ''
  }
  if (pending) {
    if (out.length) out[out.length - 1] += pending
    else out.push(pending)
  }
  return out
}

function slotFor(s: string): string {
  if (/^(https?|www\.|b23\.tv|bilibili\.com)/.test(s)) return SLOT_URL
  if (s.startsWith('BV') || RE_LATIN.test(s)) return SLOT_ENT
  if (s.startsWith('[')) return SLOT_EMO
  return SLOT_AT
}

export interface SpannedToken { token: string; start: number; end: number }

/** 归一化 token 序列，附原文本字符偏移。 */
export function normalizeSpanned(text: string): SpannedToken[] {
  const out: SpannedToken[] = []
  let shift = 0
  const prefix = text.match(RE_REPLY_PREFIX)
  let body = text
  if (prefix) {
    shift = prefix[0].length // UI 前缀剥离：偏移平移保持 span 指向原文
    body = text.slice(shift)
  }
  let pos = 0
  for (const m of body.matchAll(RE_SUB)) {
    emitSegment(out, body.slice(pos, m.index), pos + shift)
    const start = m.index + shift
    out.push({ token: slotFor(m[0]), start, end: start + m[0].length })
    pos = m.index + m[0].length
  }
  emitSegment(out, body.slice(pos), pos + shift)
  return out
}

function emitSegment(out: SpannedToken[], seg: string, base: number): void {
  if (!seg) return
  let off = 0
  for (const tok of segment(seg)) {
    const start = off
    const end = off + tok.length
    off = end
    const stripped = tok.trim()
    if (!stripped) continue
    if (RE_NUMTOK.test(stripped)) {
      out.push({ token: SLOT_NUM, start: base + start, end: base + end })
    } else {
      out.push({ token: stripped, start: base + start, end: base + end })
    }
  }
}

/** 文本 → 归一化 token 序列（字面词 + 槽位标记）。 */
export function normalize(text: string): string[] {
  return normalizeSpanned(text).map((t) => t.token)
}

export function skeletonHash(skel: string): string {
  return createHash('sha1').update(skel, 'utf8').digest('hex').slice(0, 16)
}

/** 实词槽候选：含 CJK 且非虚词，或显式 <num>/<ent> 槽位。 */
function isMaskable(tok: string): boolean {
  if (tok === SLOT_NUM || tok === SLOT_ENT) return true
  if (FUNC_WORDS.has(tok) || PUNCT.includes(tok)) return false
  return RE_CJK.test(tok)
}

/**
 * 全骨架 + 掩码变体（每条文本内去重）。
 * 掩码单元 = 单个实词 token，生成单点与任意成对掩码——两槽公式梗
 * （"一眼X鉴定为Y"）需要对两个实体槽同时掩码才能跨用例坍缩。
 * 变体仅保留剩余字面 token ≥2 的（否则退化为纯词候选，由短语通道负责）。
 */
export function skeletonVariants(text: string): string[] {
  const tokens = skeletonTokens(normalize(text))
  const full = tokens.join(' ')
  const seen = new Set([full])
  const variants = [full]
  const maskable: number[] = []
  tokens.forEach((t, i) => {
    if (isMaskable(t)) maskable.push(i)
  })

  const emit = (idxs: number[]) => {
    const drop = new Set(idxs)
    const masked = tokens.map((t, k) => (drop.has(k) ? SLOT_ENT : t))
    const literals = masked.filter((t) => !PUNCT.includes(t) && !t.startsWith('<')).length
    if (literals < 2) return
    const s = masked.join(' ')
    if (!seen.has(s)) {
      seen.add(s)
      variants.push(s)
    }
  }

  for (const i of maskable) emit([i])
  // 成对掩码（两槽公式）；长评论只取前 8 个可掩码位控制组合数
  const m = maskable.slice(0, 8)
  for (let a = 0; a < m.length; a++) {
    for (let b = a + 1; b < m.length; b++) emit([m[a], m[b]])
  }
  return variants.slice(0, 24)
}
