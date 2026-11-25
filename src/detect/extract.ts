/**
 * 统一抽取层（v0.11 重构核心）：两套有统计学根基的抽取器替代旧 6 通道特判。
 *
 * 抽取器 A（固定表达：词/短语/整句字面复读）：
 *   token 级 n-gram（上限 6 token/20 字——旧 5-token 上限正是
 *   "bin哥你做人真的可以"(6 token) 被截断的根因）+ PMI 内部凝固度
 *   （min over 切分点 log2 c(g)·N/(c(l)·c(r))，Matrix67 新词发现的
 *   "凝固程度"）+ 冻结子串抑制（邻界被单一 token 主导 ≥80% → 不立户，
 *   证据由更长表达携带——Leskovec meme-tracking 的频繁超串保留）+
 *   虚词性 gram 的计数保险（jieba 把"上号"标成 [上/f][号/m] 全虚词、
 *   "一股"标成量词——词典外新梗恰恰长这样，重复本身就是证据）。
 *
 * 抽取器 B（模板：带槽句式）：
 *   字级 cell 锚点（"赢麻了" jieba 切成 [赢麻][了]，词级拿不到 [麻][了]
 *   锚点，必须字级）+ 共识扩展（多数票延伸字面核心，可跨 ≤2 个可变
 *   cell 的间隙扩展——PrefixSpan 通配的轻量近似）+ 槽位门控：填充多样
 *   性（数量词填充坍缩为一类——"X分钟" 的 X 全是数量成分，判假公式）、
 *   两侧边缘槽不得并存（<X>词<X> 断言不了任何东西）。标点是扩展的硬
 *   边界（"原神，启动"的逗号防止核心被延伸成"界启动"），硬边界前对齐
 *   的核心允许边缘槽（utterance 开头的可变量 = "XX启动"公式）。
 *
 * 方法依据见 docs/references.md。
 */
import type { Row } from '../db.ts'
import type { UsageSample } from '../models.ts'
import { segmentTagged, segment } from '../tokenize.ts'
import { keepToken, isContentTag } from './ngram.ts'
import { PUNCT, RE_REPLY_PREFIX, RE_SUB } from './skel.ts'
import { isStopped, normText, normalizeHead } from './evidence.ts'

/** 视频标题的证据权重（up 主刻意为之，一条玩梗标题 ≈ 5 条自然评论）。 */
export const TITLE_WEIGHT = 5

const GRAM_MAX_TOKENS = 6
const GRAM_MAX_CHARS = 20
const MIN_OCCUR = 2 // 轮内最低加权出现次数（跨轮累积由候选合流承担）
const MIN_VIDEOS = 2 // 轮内跨视频门槛（视频内梗降一档不入队）
const MAX_DF_RATIO = 0.35
const PMI_MIN = 1.5
const FREEZE_RATIO = 0.95 // 右/左邻被单一 token 主导此比例 → 冻结子串不立户（旧 NMS 标定值）
const FREEZE_MIN_CNT = 3 // 低证据 gram 不做冻结抑制（两例同后缀的真梗会被误杀）
const ANCHOR_CNT = 2
const ANCHOR_DV = 2
const TPL_MIN_DV = 2 // 模板簇最终跨视频数（家族要有跨视频传播；语法模板由评分与触发门兜住）
const TPL_FILL_MIN_DISTINCT = 2
const TPL_FILL_RATIO = 0.5
const TPL_TOP = 120
const TPL_MAX_CORE_CELLS = 10 // 字面核心的 cell 数上限
const CTX_CAP = 64
const USAGE_CAP = 6
const EXTEND_VOTES = 0.6 // 共识扩展的多数票门槛
const SLOT_BOUND = 0.6 // 边缘槽的边界对齐/非主导门槛

/** 文本单元：真实评论 + 楼中楼短消息拼接（接龙）+ 高权重标题。 */
export interface Unit {
  text: string
  aid: number
  rpid: number
  root: number
  parent: number
  mid: number
  ctime: number
  chain: boolean
  /** 证据计票权重（评论=1，标题=TITLE_WEIGHT）。 */
  weight: number
}

/** 评论区礼仪词表：含 ≥60% 此类成分的短语永不立户（纯客套复读不是梗）。 */
export const ETIQUETTE_WORDS = new Set([
  '支持', '厉害', '大佬', '好活', '期待', '更新', '收藏', '点赞', '投币',
  '三连', '一键三连', '关注', '订阅', '干货', '满满', '不错', '加油',
  '喜欢', '这个', '视频', '做的', '做得', '真不错', '高质量', '质量',
  '很高', '有趣', '用心', '辛苦', '感谢', '谢谢', '分享', '学习', '受教',
  '前排', '沙发', '打卡', '来', '催更', '继续', '下次', '一定', '有钱',
  '必赚', 'Star', 'star', 'up', '主',
])
const ETIQUETTE_RATIO = 0.6

export function isEtiquette(k: string): boolean {
  const toks = segment(k).filter((t) => t.trim())
  if (!toks.length) return false
  const hits = toks.filter((t) => ETIQUETTE_WORDS.has(t)).length
  return hits / toks.length >= ETIQUETTE_RATIO
}

// ---- 语料构建 ----

/** cell：字级序列单元。CJK 单字 / 数字连串(qty) / 拉丁连串(lat) / 标点。 */
interface Cell {
  s: string
  kind: 'cjk' | 'qty' | 'lat' | 'punct'
  tag: string // 源 token 的词性（CJK 单字继承；qty/lat 为整 token 词性）
}

interface CorpusUnit {
  unit: Unit
  cells: Cell[]
  tokens: string[]
  tags: string[]
  segOf: number[] // token → 段编号（gram 不跨段）
  gramSet: Set<string> // 本单元包含的全部 token-gram 字面（reopen 用）
}

export interface GramStat {
  cnt: number
  vids: Set<number>
  docs: Set<number> // 出现过的单元序号（df 判别）
  left: Map<string, number> // 左邻 token → 加权计数
  right: Map<string, number>
  /** 话语边界裸露次数（右/左无邻居的独立成评出现——冻结抑制的豁免证据） */
  bareRight: number
  bareLeft: number
  headTag: string // 首次出现时首 token 词性
  allFunc: boolean // 所有出现里每个 token 都是功能词性（虚词性 gram 保险用）
  tokLen: number // token 数（首次出现）
  splits: Set<string> // 切分点 "左串\x00右串"（PMI 用）
}

export interface AnchorStat {
  cnt: number
  vids: Set<number>
  /** [单元序号, 锚首 cell 下标]（每单元取首个出现，上限 CTX_CAP） */
  ctx: Array<[number, number]>
}

export interface Corpus {
  units: CorpusUnit[]
  grams: Map<string, GramStat>
  totalGramCount: number
  anchors: Map<string, AnchorStat>
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\-/]/g, '\\$&')
}

const RE_CHUNK_SPLIT = new RegExp(`[${escapeRegex(PUNCT)}]`)

/** token → cells：CJK 逐字；数字连串 qty；拉丁连串 lat；其余杂符丢弃。 */
function expandCells(word: string, tag: string, cells: Cell[]): void {
  const re = /[\u4e00-\u9fff]|[0-9０-９]+|[A-Za-z]+/g
  for (const m of word.matchAll(re)) {
    const s = m[0]
    const kind: Cell['kind'] = /^[\u4e00-\u9fff]$/.test(s) ? 'cjk' : /^[0-9０-９]+$/.test(s) ? 'qty' : 'lat'
    cells.push({ s, kind, tag })
  }
}

function buildUnit(unit: Unit): CorpusUnit {
  const stripped = unit.text.replace(RE_REPLY_PREFIX, '')
  const plain = stripped.replace(RE_SUB, '\x01')
  const cells: Cell[] = []
  const tokens: string[] = []
  const tags: string[] = []
  const segOf: number[] = []
  const gramSet = new Set<string>()
  let seg = 0
  for (const segText of plain.split('\x01')) {
    let buf = ''
    const flush = (): void => {
      if (!buf.trim()) {
        buf = ''
        return
      }
      const pairs = segmentTagged(buf).filter((p) => keepToken(p.word))
      for (let i = 0; i < pairs.length; i++) {
        tokens.push(pairs[i].word)
        tags.push(pairs[i].tag)
        segOf.push(seg)
        expandCells(pairs[i].word, pairs[i].tag, cells)
      }
      seg++
      buf = ''
    }
    // 逐字符走：标点既切断 gram（flush 成新段）也进入 cell 流（共识扩展的硬边界）
    for (const ch of segText) {
      if (PUNCT.includes(ch)) {
        flush()
        if (ch.trim()) cells.push({ s: ch, kind: 'punct', tag: 'x' })
      } else {
        buf += ch
      }
    }
    flush()
    // RE_SUB 切出的段之间是硬边界：占位 punct cell（URL/表情/@ 不可穿越）
    cells.push({ s: '\x01', kind: 'punct', tag: 'x' })
  }
  if (cells.length && cells[cells.length - 1].s === '\x01') cells.pop()
  for (let s = 0; s < tokens.length; s++) {
    let acc = ''
    for (let e = s; e < Math.min(tokens.length, s + GRAM_MAX_TOKENS); e++) {
      if (segOf[e] !== segOf[s]) break
      acc += tokens[e]
      if (acc.length > GRAM_MAX_CHARS) break
      gramSet.add(acc)
    }
  }
  return { unit, cells, tokens, tags, segOf, gramSet }
}

/** 语料统计：token-gram 计数/邻接/切分点 + CJK 双字 cell 锚点。 */
export function buildCorpus(units: Unit[]): Corpus {
  const cus = units.map(buildUnit)
  const grams = new Map<string, GramStat>()
  const anchors = new Map<string, AnchorStat>()
  let total = 0
  const statOf = (g: string): GramStat => {
    let st = grams.get(g)
    if (!st) {
      st = { cnt: 0, vids: new Set(), docs: new Set(), left: new Map(), right: new Map(),
        bareRight: 0, bareLeft: 0, headTag: 'x', allFunc: true, tokLen: 0, splits: new Set() }
      grams.set(g, st)
    }
    return st
  }
  for (let ui = 0; ui < cus.length; ui++) {
    const cu = cus[ui]
    const w = cu.unit.weight
    for (let i = 0; i < cu.tokens.length; i++) {
      let acc = ''
      const parts: string[] = []
      for (let j = i; j < Math.min(cu.tokens.length, i + GRAM_MAX_TOKENS); j++) {
        if (cu.segOf[j] !== cu.segOf[i]) break
        acc += cu.tokens[j]
        parts.push(cu.tokens[j])
        if (acc.length > GRAM_MAX_CHARS) break
        const st = statOf(acc)
        st.cnt += w
        st.vids.add(cu.unit.aid)
        st.docs.add(ui)
        if (st.tokLen === 0) {
          st.tokLen = parts.length
          st.headTag = cu.tags[i]
        }
        if (cu.tags.slice(i, j + 1).some((t) => isContentTag(t))) st.allFunc = false
        if (parts.length >= 2) {
          let l = ''
          for (let k = 0; k + 1 < parts.length; k++) {
            l += parts[k]
            const r = parts.slice(k + 1).join('')
            st.splits.add(`${l}\x00${r}`)
          }
        }
        // 邻接分布（gram 首尾 token 的跨邻居；同段才算邻）+ 裸边界计数
        if (i > 0 && cu.segOf[i - 1] === cu.segOf[i]) {
          const k2 = cu.tokens[i - 1]
          st.left.set(k2, (st.left.get(k2) ?? 0) + w)
        } else {
          st.bareLeft += w
        }
        if (j + 1 < cu.tokens.length && cu.segOf[j + 1] === cu.segOf[j]) {
          const k2 = cu.tokens[j + 1]
          st.right.set(k2, (st.right.get(k2) ?? 0) + w)
        } else {
          st.bareRight += w
        }
        total += w
      }
    }
    for (let i = 0; i + 1 < cu.cells.length; i++) {
      const a = cu.cells[i]
      const b = cu.cells[i + 1]
      if (a.kind !== 'cjk' || b.kind !== 'cjk') continue
      const key = a.s + '|' + b.s
      let st = anchors.get(key)
      if (!st) {
        st = { cnt: 0, vids: new Set(), ctx: [] }
        anchors.set(key, st)
      }
      st.cnt += w
      st.vids.add(cu.unit.aid)
      if (st.ctx.length < CTX_CAP) st.ctx.push([ui, i])
    }
  }
  return { units: cus, grams, totalGramCount: total, anchors }
}

/** PMI 内部凝固度：min over 切分点 log2( c(g)·N / (c(l)·c(r)) )。单 token → Infinity。 */
function pmiOf(g: string, grams: Map<string, GramStat>, total: number): number {
  const st = grams.get(g)
  if (!st || st.tokLen <= 1) return Infinity
  let min = Infinity
  for (const sp of st.splits) {
    const [l, r] = sp.split('\x00')
    const cl = grams.get(l)?.cnt ?? 0
    const cr = grams.get(r)?.cnt ?? 0
    if (cl <= 0 || cr <= 0) continue
    const pmi = Math.log2((st.cnt * total) / (cl * cr))
    if (pmi < min) min = pmi
  }
  return min
}

// ---- 抽取器 A：固定表达 ----

export interface FixedCand {
  head: string
  cnt: number
  dv: number
  /** 完整视频集（video_pairs 用它，不用采样用例里的截断集） */
  aids: number[]
  channel: 'phrase' | 'copy'
  kind: 'word' | 'interaction'
  usages: UsageSample[]
}

const COPY_MIN_LEN = 4
const COPY_MAX_LEN = 48

/**
 * 固定表达抽取。hasHistory：词头在 phrase_daily 早于今日出现过的**天数**。
 * 跨轮创建补救——散布在多轮的低频完整单元：轮内 dv≥1 且（轮内 cnt≥2 且历史
 * ≥1 天，或轮内出现 1 次但历史 ≥2 天）即立户（"抽象"类低频持续词汇）。
 * QQ 群容器（负数 aid）豁免轮内跨容器门（单群部署同群复读即指征）；
 * 虚词性单字路径不豁免——单人刷屏的最后防线，群内虚词词靠跨天补救。
 */
export function extractFixed(
  corpus: Corpus, generic: Set<string>,
  hasHistory: (head: string) => number = () => 0,
): FixedCand[] {
  const n = corpus.units.length
  const useDfFilter = n >= 50

  const base: string[] = []
  for (const [g, st] of corpus.grams) {
    const dv = st.vids.size
    const histDays = hasHistory(g)
    // 跨轮创建补救（低频持续词汇）：历史 ≥2 天时轮内出现 1 次即可参与；
    // 否则需轮内 cnt≥2 且历史 ≥1 天
    const persistent = histDays >= 2
    if (st.cnt < MIN_OCCUR && !persistent) continue
    const rescue = dv >= 1 && (st.cnt >= MIN_OCCUR ? histDays >= 1 : persistent)
    // QQ 群容器（合成负数 aid）豁免轮内跨容器门：单群部署整个湖只有一个
    // 容器，同群复读本身就是梗指征（与体量线改绝对次数同一逻辑）；
    // cnt≥2 的重复门槛保留，B站单视频行为不变
    const qqOnly = dv >= 1 && [...st.vids].every((v) => v < 0)
    if (dv < MIN_VIDEOS && !rescue && !qqOnly) continue
    if (isStopped(generic, g)) continue
    if (useDfFilter && st.docs.size / n > MAX_DF_RATIO) continue
    const content = isContentTag(st.headTag)
    if (g.length >= 3) {
      if (!(content || st.cnt >= 3 || persistent)) continue
    } else {
      // ≤2 字：内容头 + 计数（低频持续豁免）；虚词性 gram 走计数保险（cnt≥3 且跨 ≥2 视频）
      if (!(content && (st.cnt >= MIN_OCCUR || persistent)) && !(st.allFunc && st.cnt >= 3 && dv >= MIN_VIDEOS && pmiOf(g, corpus.grams, corpus.totalGramCount) >= PMI_MIN)) continue
    }
    if (st.tokLen >= 2 && pmiOf(g, corpus.grams, corpus.totalGramCount) < PMI_MIN) continue
    if (isEtiquette(g)) continue
    base.push(g)
  }
  // 冻结子串抑制：右/左邻被单一 token 主导 → 更长表达的切片，不立户。
  // 裸边界豁免：词头有独立成评的出现（右/左无邻居）说明它自身就是完整单元
  // （"绷"既有"绷不住"也有单用"绷"）——不做冻结抑制。
  const out: string[] = []
  for (const g of base) {
    const st = corpus.grams.get(g)!
    if (st.cnt >= FREEZE_MIN_CNT) {
      let maxR = 0
      let maxL = 0
      for (const v of st.right.values()) if (v > maxR) maxR = v
      for (const v of st.left.values()) if (v > maxL) maxL = v
      if (maxR / st.cnt >= FREEZE_RATIO && st.bareRight === 0) continue
      if (maxL / st.cnt >= FREEZE_RATIO && st.bareLeft === 0) continue
    }
    out.push(g)
  }
  // 用例收集（仅对过闸 gram 二次扫描）
  const want = new Set(out)
  const usages = new Map<string, UsageSample[]>()
  for (const cu of corpus.units) {
    for (const g of cu.gramSet) {
      if (!want.has(g)) continue
      const arr = usages.get(g) ?? []
      if (arr.length < USAGE_CAP) arr.push(unitUsage(cu.unit))
      usages.set(g, arr)
    }
  }
  const cands: FixedCand[] = out.map((g) => {
    const st = corpus.grams.get(g)!
    const us = usages.get(g) ?? []
    // 裸话语复读（每条采样用例的归一文本 == 词头本身）→ copy 通道领地：
    // 整句复读的候选免于自推剪枝（同一人把同一句贴进多视频，是复读证据不是
    // 广告切片签名； phrase 通道的切片才剪——旧管线 5-token 上限建不出
    // "bin哥你做人真的可以"，phrase 通道缺席，copy 独立成户，行为对齐于此）
    const headNorm = normText(g)
    const allBare = us.length > 0 && us.every((u) => normText(u.text) === headNorm)
    if (allBare) {
      const replyRatio = us.filter((u) => u.parent).length / us.length
      return { head: g, cnt: st.cnt, dv: st.vids.size, aids: [...st.vids], channel: 'copy', kind: replyRatio >= 0.5 ? 'interaction' : 'word', usages: us }
    }
    return { head: g, cnt: st.cnt, dv: st.vids.size, aids: [...st.vids], channel: 'phrase', kind: 'word', usages: us }
  })

  // 整句字面复读：归一化后 4-48 字、跨视频同文（"梗=被复读的表达"的最直接证据）
  const groups = new Map<string, { us: Unit[]; vids: Set<number>; wsum: number }>()
  for (const cu of corpus.units) {
    const k = normText(cu.unit.text)
    if (k.length < COPY_MIN_LEN || k.length > COPY_MAX_LEN) continue
    const g = groups.get(k) ?? { us: [], vids: new Set<number>(), wsum: 0 }
    g.us.push(cu.unit)
    g.vids.add(cu.unit.aid)
    g.wsum += cu.unit.weight
    groups.set(k, g)
  }
  for (const [k, g] of groups) {
    if (g.vids.size < MIN_VIDEOS || g.wsum < MIN_OCCUR) continue
    if (isEtiquette(k)) continue
    if (isStopped(generic, k)) continue // 封禁只匹配最终完整词头，不做子串或家族封禁
    const replyRatio = g.us.filter((u) => u.parent).length / g.us.length
    cands.push({
      head: k, cnt: g.wsum, dv: g.vids.size, aids: [...g.vids],
      channel: 'copy', kind: replyRatio >= 0.5 ? 'interaction' : 'word',
      usages: g.us.slice(0, USAGE_CAP).map(unitUsage),
    })
  }
  return cands
}

function unitUsage(u: Unit): UsageSample {
  return { text: u.text, aid: u.aid, rpid: u.rpid, root: u.root, parent: u.parent, mid: u.mid, ctime: u.ctime, chain: u.chain }
}

// ---- 抽取器 B：模板（带槽句式） ----

export interface TemplateCand {
  head: string
  cnt: number
  dv: number
  /** 命中簇的完整视频集 */
  aids: number[]
  usages: UsageSample[]
}

/** 数量成分（填充多样性判假的坍缩类）。 */
const isQtyish = (c: Cell): boolean => c.kind === 'qty' || c.tag === 'm' || c.tag === 'q'

interface TplCtx {
  ui: number
  /** 每个 seg 在该单元 cells 中的 [start, len] */
  segs: Array<[number, number]>
}

interface Cluster {
  ctxs: TplCtx[]
  /** 抽象结构：各 seg 的字面 cells；gapBefore = 与前一 seg 间跳过的可变 cell 数 */
  segs: Array<{ cells: Cell[]; gapBefore: number }>
}

/** 左邻（或右邻）投票：BLOCK = 边界（punct/端点）。 */
function leftVote(corpus: Corpus, ctxs: TplCtx[]): Map<string, number> {
  const votes = new Map<string, number>()
  for (const c of ctxs) {
    const cells = corpus.units[c.ui].cells
    const p = c.segs[0][0]
    const key = p === 0 || cells[p - 1].kind === 'punct' ? '\x00BLOCK' : cells[p - 1].s
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  return votes
}

function rightVote(corpus: Corpus, ctxs: TplCtx[]): Map<string, number> {
  const votes = new Map<string, number>()
  for (const c of ctxs) {
    const cells = corpus.units[c.ui].cells
    const [s, len] = c.segs[c.segs.length - 1]
    const e = s + len // 下一 cell 下标
    const key = e >= cells.length || cells[e].kind === 'punct' ? '\x00BLOCK' : cells[e].s
    votes.set(key, (votes.get(key) ?? 0) + 1)
  }
  return votes
}

/** 多数票：得票 ≥60% 的胜者（BLOCK 之外），无则 null。 */
function majority(votes: Map<string, number>, n: number): string | null {
  for (const [k, v] of votes) {
    if (k !== '\x00BLOCK' && v >= n * EXTEND_VOTES) return k
  }
  return null
}

function cellsText(cells: Cell[]): string {
  // 展示用合并：相邻 CJK cell 拼接，qty/lat 独立
  const parts: string[] = []
  let buf = ''
  for (const c of cells) {
    if (c.kind === 'cjk') buf += c.s
    else {
      if (buf) parts.push(buf)
      buf = ''
      parts.push(c.s)
    }
  }
  if (buf) parts.push(buf)
  return parts.join(' ')
}

/** 由簇构造模板头；无槽返回 null（那是字面表达，抽取器 A 的领地）。 */
function headOf(cl: Cluster, leftSlot: boolean, rightSlot: boolean): string | null {
  if (!leftSlot && !rightSlot && !cl.segs.some((s) => s.gapBefore > 0)) return null
  // 紧凑头格式：<X>直连 CJK（"<X>麻了"，对齐旧后缀族头），间隙槽 "<ent>" 内联
  let head = ''
  if (leftSlot) head += '<X>'
  cl.segs.forEach((s, i) => {
    if (i > 0 && s.gapBefore > 0) head += '<ent>'
    head += cellsText(s.cells).replace(/ /g, '')
  })
  if (rightSlot) head += '<X>'
  return head || null
}

/** 单元 aid 是否全为 QQ 群容器（合成负数编号，见 lake.qqSyntheticId）。 */
function qqOnlyVids(vids: Iterable<number>): boolean {
  const arr = [...vids]
  return arr.length >= 1 && arr.every((v) => v < 0)
}

export function extractTemplates(corpus: Corpus, generic: Set<string> = new Set()): TemplateCand[] {
  const all: TemplateCand[] = []
  for (const [key, st] of corpus.anchors) {
    if (st.cnt < ANCHOR_CNT || (st.vids.size < ANCHOR_DV && !qqOnlyVids(st.vids))) continue
    const [a, b] = key.split('|')
    const cluster = extendCluster(corpus, st.ctx, a, b)
    if (!cluster) continue
    const dv = new Set(cluster.ctxs.map((c) => corpus.units[c.ui].unit.aid)).size
    if (dv < TPL_MIN_DV && !qqOnlyVids(cluster.ctxs.map((c) => corpus.units[c.ui].unit.aid))) continue
    const cntW = cluster.ctxs.reduce((s, c) => s + corpus.units[c.ui].unit.weight, 0)
    const head = finalizeHead(corpus, cluster)
    if (!head || isStopped(generic, head)) continue
    const usages = cluster.ctxs.slice(0, USAGE_CAP).map((c) => unitUsage(corpus.units[c.ui].unit))
    const aids = [...new Set(cluster.ctxs.map((c) => corpus.units[c.ui].unit.aid))]
    all.push({ head, cnt: cntW, dv, aids, usages })
  }
  // 上限 + 去重：按 cnt×dv 降序，同头保留计数最大者
  all.sort((x, y) => y.cnt * y.dv - x.cnt * x.dv)
  const seen = new Set<string>()
  const cands: TemplateCand[] = []
  for (const c of all) {
    if (seen.has(c.head)) continue
    seen.add(c.head)
    cands.push(c)
    if (cands.length >= TPL_TOP) break
  }
  return cands
}

/** 共识扩展：从双字锚点出发，多数票延伸字面核心，可跨 ≤2 个可变 cell。 */
export function extendCluster(corpus: Corpus, ctx: Array<[number, number]>, a: string, b: string): Cluster | null {
  const cl: Cluster = {
    ctxs: ctx.map(([ui, pos]) => ({ ui, segs: [[pos, 2] as [number, number]] })),
    segs: [{ cells: [{ s: a, kind: 'cjk', tag: 'x' }, { s: b, kind: 'cjk', tag: 'x' }], gapBefore: 0 }],
  }
  // 迭代扩展（左/右交替，直到不动点；迭代上限防环）
  for (let round = 0; round < 8; round++) {
    let moved = false
    // 左直接延伸
    const lv = leftVote(corpus, cl.ctxs)
    const win = majority(lv, cl.ctxs.length)
    if (win) {
      const kept: TplCtx[] = []
      for (const c of cl.ctxs) {
        const cells = corpus.units[c.ui].cells
        if (c.segs[0][0] > 0 && cells[c.segs[0][0] - 1].s === win && cells[c.segs[0][0] - 1].kind !== 'punct') {
          c.segs[0][0] -= 1
          c.segs[0][1] += 1
          kept.push(c)
        }
      }
      cl.ctxs = kept
      cl.segs[0].cells.unshift({ s: win, kind: 'cjk', tag: 'x' })
      moved = true
    } else {
      // 左间隙延伸：跳过 ≤2 个可变 cell
      for (let d = 1; d <= 2 && !moved; d++) {
        const votes = new Map<string, number>()
        let viable = 0
        for (const c of cl.ctxs) {
          const cells = corpus.units[c.ui].cells
          const p = c.segs[0][0]
          if (p - d - 1 < 0) continue
          let ok = true
          for (let k = p - d; k < p; k++) if (cells[k].kind === 'punct') ok = false
          if (!ok) continue
          viable++
          const key = cells[p - d - 1].kind === 'punct' ? '\x00BLOCK' : cells[p - d - 1].s
          votes.set(key, (votes.get(key) ?? 0) + 1)
        }
        const win2 = majority(votes, viable)
        if (win2 && win2 !== '\x00BLOCK') {
          const kept: TplCtx[] = []
          for (const c of cl.ctxs) {
            const cells = corpus.units[c.ui].cells
            const p = c.segs[0][0]
            if (p - d - 1 < 0) continue
            if (cells[p - d - 1].s !== win2 || cells[p - d - 1].kind === 'punct') continue
            let ok = true
            for (let k = p - d; k < p; k++) if (cells[k].kind === 'punct') ok = false
            if (!ok) continue
            c.segs.unshift([p - d - 1, 1])
            kept.push(c)
          }
          cl.ctxs = kept
          cl.segs.unshift({ cells: [{ s: win2, kind: 'cjk', tag: 'x' }], gapBefore: d })
          moved = true
        }
      }
    }
    // 右直接延伸
    if (!moved) {
      const rv = rightVote(corpus, cl.ctxs)
      const win = majority(rv, cl.ctxs.length)
      if (win) {
        const kept: TplCtx[] = []
        for (const c of cl.ctxs) {
          const cells = corpus.units[c.ui].cells
          const [s, len] = c.segs[c.segs.length - 1]
          const e = s + len
          if (e < cells.length && cells[e].s === win && cells[e].kind !== 'punct') {
            c.segs[c.segs.length - 1][1] += 1
            kept.push(c)
          }
        }
        cl.ctxs = kept
        cl.segs[cl.segs.length - 1].cells.push({ s: win, kind: 'cjk', tag: 'x' })
        moved = true
      } else {
        for (let d = 1; d <= 2 && !moved; d++) {
          const votes = new Map<string, number>()
          let viable = 0
          for (const c of cl.ctxs) {
            const cells = corpus.units[c.ui].cells
            const [s, len] = c.segs[c.segs.length - 1]
            const e = s + len
            if (e + d + 1 > cells.length) continue
            let ok = true
            for (let k = e; k < e + d; k++) if (cells[k].kind === 'punct') ok = false
            if (!ok) continue
            viable++
            const key = cells[e + d].kind === 'punct' ? '\x00BLOCK' : cells[e + d].s
            votes.set(key, (votes.get(key) ?? 0) + 1)
          }
          const win2 = majority(votes, viable)
          if (win2 && win2 !== '\x00BLOCK') {
            const kept: TplCtx[] = []
            for (const c of cl.ctxs) {
              const cells = corpus.units[c.ui].cells
              const [s, len] = c.segs[c.segs.length - 1]
              const e = s + len
              if (e + d + 1 > cells.length) continue
              if (cells[e + d].s !== win2 || cells[e + d].kind === 'punct') continue
              let ok = true
              for (let k = e; k < e + d; k++) if (cells[k].kind === 'punct') ok = false
              if (!ok) continue
              c.segs.push([e + d, 1])
              kept.push(c)
            }
            cl.ctxs = kept
            cl.segs.push({ cells: [{ s: win2, kind: 'cjk', tag: 'x' }], gapBefore: d })
            moved = true
          }
        }
      }
    }
    // 核心长度上限
    const coreLen = cl.segs.reduce((s, x) => s + x.cells.length, 0)
    if (coreLen >= TPL_MAX_CORE_CELLS) break
    if (!moved) break
    if (!cl.ctxs.length) return null
  }
  return cl.ctxs.length ? cl : null
}

/** 槽位判定 + 门控；无槽/不达标返回 null。
 * 槽两类：rule-a = 边界对齐（核心紧贴硬边界，填充物在边界外侧——"X，启动"），
 * 填充为空的话语位置不成槽；rule-b = 紧邻变体（核心旁的内容 cell 多样且无
 * 主导——"X麻了"的 X）。双侧都是 rule-b = <X>词<X>，断言不了任何东西，拒绝。 */
export function finalizeHead(corpus: Corpus, cl: Cluster): string | null {
  const n = cl.ctxs.length
  const lv = leftVote(corpus, cl.ctxs)
  const blockedL = lv.get('\x00BLOCK') ?? 0
  const distinctL = [...lv.keys()].filter((k) => k !== '\x00BLOCK')
  const topL = Math.max(0, ...distinctL.map((k) => lv.get(k) ?? 0))
  const leftRuleA = blockedL >= n * SLOT_BOUND
  const leftRuleB = !leftRuleA && distinctL.length >= 2 && topL < n * SLOT_BOUND
  const rv = rightVote(corpus, cl.ctxs)
  const blockedR = rv.get('\x00BLOCK') ?? 0
  const distinctR = [...rv.keys()].filter((k) => k !== '\x00BLOCK')
  const topR = Math.max(0, ...distinctR.map((k) => rv.get(k) ?? 0))
  const rightRuleA = blockedR >= n * SLOT_BOUND
  const rightRuleB = !rightRuleA && distinctR.length >= 2 && topR < n * SLOT_BOUND
  // 右侧边界对齐 = 话语在核心后收束（end/punct），不是可变槽位：
  // 逗号后的下一句是无关续文，把当成填充只会制造 <词><X> 垃圾并挤掉
  // 正确头（"兄弟们X麻了，没眼看了" 的后续子句）。左侧 rule-a 保留——
  // "X，启动" 的变量在边界前，是公式的槽。

  // 先收集各槽填充（rule-a 填充为空 → 该侧不成槽）
  const leftFills = new Set<string>()
  const rightFills = new Set<string>()
  const gapFillsAll = new Set<string>()
  if (leftRuleB || leftRuleA) {
    for (const c of cl.ctxs) {
      const cells = corpus.units[c.ui].cells
      const p = c.segs[0][0]
      if (leftRuleB) {
        if (p > 0 && cells[p - 1].kind !== 'punct') leftFills.add(fillingCell(cells[p - 1]))
      } else {
        const arr: Cell[] = []
        let i = p - 1
        if (i >= 0 && cells[i].kind === 'punct') i--
        while (i >= 0 && cells[i].kind !== 'punct' && arr.length < 6) {
          arr.unshift(cells[i])
          i--
        }
        if (arr.length) leftFills.add(arr.map(fillingCell).join(''))
      }
    }
  }
  if (rightRuleB || rightRuleA) {
    for (const c of cl.ctxs) {
      const cells = corpus.units[c.ui].cells
      const [s, len] = c.segs[c.segs.length - 1]
      const e = s + len
      if (rightRuleB) {
        if (e < cells.length && cells[e].kind !== 'punct') rightFills.add(fillingCell(cells[e]))
      } else {
        const arr: Cell[] = []
        let i = e
        if (i < cells.length && cells[i].kind === 'punct') i++
        while (i < cells.length && cells[i].kind !== 'punct' && arr.length < 6) {
          arr.push(cells[i])
          i++
        }
        if (arr.length) rightFills.add(arr.map(fillingCell).join(''))
      }
    }
  }
  for (const c of cl.ctxs) for (const g of gapFills(corpus, c)) if (g) gapFillsAll.add(g)
  const leftSlot = leftRuleB || (leftRuleA && leftFills.size > 0)
  const rightSlot = rightRuleB // 右侧 rule-a 不成槽
  // 至多一个边缘槽：两侧都可变的 <X>词<X> / "前句，词，后句"断言不了任何东西
  // （双槽真公式——"一眼X鉴定为Y"——的内槽走间隙扩展 <ent>，不受此限）
  if (leftSlot && rightSlot) return null
  // 字面字符 ≥2
  const litChars = cl.segs.reduce((s, x) => s + x.cells.reduce((a, c) => a + (c.kind === 'cjk' ? 1 : c.s.length), 0), 0)
  if (litChars < 2) return null
  const head = headOf(cl, leftSlot, rightSlot)
  if (!head) return null
  // 填充多样性（量词成分已在 fillingCell 坍缩为一类）
  const fills = new Set<string>([...leftFills, ...rightFills, ...gapFillsAll])
  let fillCtxs = 0
  for (const c of cl.ctxs) {
    const cells = corpus.units[c.ui].cells
    const parts: string[] = []
    if (leftSlot) {
      const p = c.segs[0][0]
      if (leftRuleB) {
        if (p > 0 && cells[p - 1].kind !== 'punct') parts.push(fillingCell(cells[p - 1]))
      } else {
        const arr: Cell[] = []
        let i = p - 1
        if (i >= 0 && cells[i].kind === 'punct') i--
        while (i >= 0 && cells[i].kind !== 'punct' && arr.length < 6) {
          arr.unshift(cells[i])
          i--
        }
        if (arr.length) parts.push(arr.map(fillingCell).join(''))
      }
    }
    if (rightSlot) {
      const [s, len] = c.segs[c.segs.length - 1]
      const e = s + len
      if (rightRuleB) {
        if (e < cells.length && cells[e].kind !== 'punct') parts.push(fillingCell(cells[e]))
      } else {
        const arr: Cell[] = []
        let i = e
        if (i < cells.length && cells[i].kind === 'punct') i++
        while (i < cells.length && cells[i].kind !== 'punct' && arr.length < 6) {
          arr.push(cells[i])
          i++
        }
        if (arr.length) parts.push(arr.map(fillingCell).join(''))
      }
    }
    for (const gap of gapFills(corpus, c)) if (gap) parts.push(gap)
    if (parts.length) fillCtxs++
  }
  if (fillCtxs === 0) return null
  if (fills.size < TPL_FILL_MIN_DISTINCT || fills.size / fillCtxs < TPL_FILL_RATIO) return null
  return head
}

function fillingCell(c: Cell): string {
  return isQtyish(c) ? '<qty>' : c.s.toLowerCase()
}

/** 间隙槽的填充（每个上下文跳过的 cell 串）。 */
function gapFills(corpus: Corpus, c: TplCtx): string[] {
  const cells = corpus.units[c.ui].cells
  const out: string[] = []
  for (let i = 1; i < c.segs.length; i++) {
    const prevEnd = c.segs[i - 1][0] + c.segs[i - 1][1]
    const gap = c.segs[i][0] - prevEnd
    if (gap <= 0) continue
    const arr: Cell[] = []
    for (let k = prevEnd; k < c.segs[i][0] && arr.length < 6; k++) {
      if (cells[k].kind !== 'punct') arr.push(cells[k])
    }
    out.push(arr.map(fillingCell).join(''))
  }
  return out
}

/** 单元序列（供 signals 编排）。 */
export function collectUnits(comments: Row[]): Unit[] {
  const units: Unit[] = []
  for (const c of comments) {
    if (!c.message) continue
    units.push({
      text: c.message, aid: c.oid, rpid: c.rpid, root: c.root,
      parent: c.parent, mid: c.mid, ctime: c.ctime, chain: false, weight: 1,
    })
  }
  const byRoot = new Map<number, Row[]>()
  for (const c of comments) {
    if (c.root) {
      if (!byRoot.has(c.root)) byRoot.set(c.root, [])
      byRoot.get(c.root)!.push(c)
    }
  }
  const CHAIN_MIN_RUN = 2
  for (const sibs of byRoot.values()) {
    sibs.sort((a, b) => a.ctime - b.ctime)
    const runs: Row[][] = []
    let run: Row[] = []
    for (const c of sibs) {
      const len = String(c.message ?? '').trim().length
      if (len > 0 && len <= 2) run.push(c)
      else {
        if (run.length >= CHAIN_MIN_RUN) runs.push(run)
        run = []
      }
    }
    if (run.length >= CHAIN_MIN_RUN) runs.push(run)
    for (const r of runs) {
      units.push({
        text: r.map((c) => String(c.message).trim()).join(''),
        aid: r[0].oid, rpid: r[0].rpid, root: r[0].root,
        parent: r[0].parent, mid: r[r.length - 1].mid, ctime: r[r.length - 1].ctime, chain: true, weight: 1,
      })
    }
  }
  return units
}
