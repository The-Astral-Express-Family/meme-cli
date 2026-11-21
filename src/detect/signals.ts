/**
 * 证据更新管线：纯统计、零 LLM、跨轮次累积。五通道并进：
 *
 * - phrase   短语通道（word 类）：轮内轻门槛创建（2 次/2 视频即立户）+ 跨轮累积。
 * - copy     复读通道：归一化整句跨视频重复——"梗=被复读的表达"的最直接证据；
 *            回复为主的复读 → interaction 预判。
 * - skeleton 骨架通道（formula/format）：掩码变体跨文本坍缩。字面门槛 ≥2 字符。
 * - 后缀族    形态学能产性合成（"赢麻了/亏麻了/输麻了" → <X>麻了 公式候选）。
 * - image    图梗通道：pHash 跨视频聚类（重复即梗）。
 * - chain    一字接龙：楼中楼短消息拼接为虚拟文本，走普通通道，标记 chain。
 *
 * 泛用词治理从手工黑名单改为统计判别：GENERIC 只保留零梗义语法虚词；
 * 泛用实词（"决赛/版本/不行"）允许入榜，由 evidence.memeFeatures
 * （复读/坍缩/独立成评）在排序与触发层压制——它们句句不同，梗证分 ≈ 0 沉底。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { kvGet } from '../db.ts'
import type { ResolvedConfig } from '../config.ts'
import { allActive, save as saveCand, upsertFromSignal, type VideoPair } from '../candidates.ts'
import type { Candidate } from '../models.ts'
import { allMemes } from '../entries.ts'
import { commentsForRound, titlesForRound, upMidMap } from '../lake.ts'
import { vectorNearest } from '../match/pipeline.ts'
import { getEmbedder, type Embedder } from '../match/vector.ts'
import { type UsageSample, todayIso } from '../models.ts'
import { segmentTagged } from '../tokenize.ts'
import * as ngram from './ngram.ts'
import { zScore } from './burst.ts'
import { normText } from './evidence.ts'
import { hamming as imgHamming } from './imgphash.ts'
import { skeletonVariants } from './skel.ts'

/** 语法虚词核心表（零梗义争议；泛用实词不入列——交给统计判别）。 */
export const GENERIC = new Set([
  // 代词/助词/语气/介连
  '的', '了', '是', '在', '有', '没', '很', '都', '也', '就', '还', '和', '跟',
  '与', '或', '但', '被', '把', '让', '给', '对', '从', '向', '到', '着', '过',
  '吧', '呢', '吗', '呀', '哦', '嘛', '么', '哈', '嘿', '哪', '谁', '我', '你',
  '他', '她', '它', '咱', '们', '这', '那',
  // 高频虚词组合
  '没有', '不了', '这是', '还有', '起来', '好像', '之前', '的是', '是什么',
  '了吗', '了吧', '的时候', '是不是', '也是', '都是', '不会', '不能', '完全',
  '一个', '什么', '怎么', '还是', '然后', '如果', '就是', '不是', '这样', '那样',
  '真的', '可能', '应该', '其实', '确实', '现在', '时候', '知道', '觉得',
  // 评论区礼仪/灌水（B站评论生态的固定客套，永不构成梗）
  '沙发', '前排', '第一', '打卡', '来了', '支持', '厉害', '大佬', '好活',
  '期待更新', '收藏了', '点赞', '投币', '一键三连', '三连', '关注了',
  '干货满满', '支持up', '支持up主', '做得真不错', '视频做得真不错',
  '质量很高', '质量很高收藏了', '喜欢这个系列', '继续更新', '催更',
])

const MIN_OCCUR = 2 // 轮内最低出现次数（跨轮累积由候选合流承担）
const MIN_VIDEOS = 2 // 轮内跨视频门槛（视频内梗降一档不入队）
const MAX_DF_RATIO = 0.35 // 出现在超过此比例评论中的短语视为泛用词

/**
 * 视频标题的证据权重。标题是 up 主刻意为之的文本（写标题要过脑子，评论区是
 * 顺手打字），一条玩梗标题 ≈ 5 条自然评论的证据强度；量级上每轮仅 15-30 条
 * 标题 vs 数千评论，加权不会淹没评论侧统计。计票只发生在发现层（本文件），
 * 入库的用例样本不带权重。
 */
const TITLE_WEIGHT = 5

/**
 * 客套成分检测：复读信号对礼貌性刷词（"视频做得真不错"跨视频复读）同样成立，
 * 但它们永不是梗。短语分词后 ≥60% 落在客套词表内 → 不入榜。客套词表与 GENERIC
 * 分开维护：GENERIC 拦语法词，这里拦"成分"——含任意真内容词的短语不受影响。
 */
export const ETIQUETTE_WORDS = new Set([
  '支持', '厉害', '大佬', '好活', '期待', '更新', '收藏', '点赞', '投币',
  '三连', '一键三连', '关注', '订阅', '干货', '满满', '不错', '加油',
  '喜欢', '这个', '视频', '做的', '做得', '真不错', '高质量', '质量',
  '很高', '有趣', '用心', '辛苦', '感谢', '谢谢', '分享', '学习', '受教',
  '前排', '沙发', '打卡', '来', '催更', '继续', '下次', '一定', '有钱',
  '必赚', 'Star', 'star', 'up', '主',
])
const ETIQUETTE_RATIO = 0.6

// 复读通道：归一化文本长度窗口（太短=表情/单词噪音；太长=新闻粘贴）
const COPY_MIN_LEN = 4
const COPY_MAX_LEN = 48
// 骨架通道门槛：变体必须复现于 ≥2 种不同文本、≥2 视频、字面字符 ≥2
const SKELETON_MIN_TEXTS = 2
const SK_TEXT_SAMPLE = 6
const TOP_SKELS = 60
const REOPEN_HEAD_LIMIT = 5000 // 既有候选合流循环的保险丝
const IMG_HAMMING_MAX = 8

export interface SignalsResult {
  scanned: number
  phrase_candidates: number
  skeleton_candidates: number
  copy_candidates: number
  image_candidates: number
  triggered: string[]
}

/** 一轮信号更新的共享上下文。 */
interface Ctx {
  db: DatabaseSync
  roundId: number
  day: string
  upMap: Map<number, number>
  embedder: Embedder
  res: SignalsResult
  /** 轮内短语计数（后缀族与既有候选合流共用）。 */
  phCnt: Map<string, number>
  phVideos: Map<string, Set<number>>
  perComment: Array<[Unit, string[]]>
}

interface Unit {
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

/** 三级停用词：内置 GENERIC ∪ 配置 generic_extra ∪ kv generic_auto（--ban 沉淀）；kv generic_allow 为豁免表。 */
export function genericSet(db: DatabaseSync, cfg: ResolvedConfig): Set<string> {
  const s = new Set(GENERIC)
  for (const w of cfg.genericExtra) s.add(w)
  try {
    for (const w of JSON.parse(kvGet(db, 'generic_auto', '[]') || '[]') as string[]) s.add(w)
  } catch { /* 坏数据忽略 */ }
  try {
    for (const w of JSON.parse(kvGet(db, 'generic_allow', '[]') || '[]') as string[]) s.delete(w)
  } catch { /* 坏数据忽略 */ }
  return s
}

function bumpDaily(ctx: Ctx, table: 'phrase_daily' | 'skel_daily', key: string, cnt: number, videos: number): void {
  const col = table === 'phrase_daily' ? 'phrase' : 'skel'
  ctx.db.prepare(
    `INSERT INTO ${table} VALUES(?,?,?,?) ON CONFLICT(${col},day) `
    + 'DO UPDATE SET cnt=cnt+excluded.cnt, videos=MAX(videos, excluded.videos)',
  ).run(key, ctx.day, cnt, videos)
}

/** 短语首 token 的词性（仅对通过前序闸门的短语调用，量级约百/轮）。 */
function headTag(ph: string): string {
  const first = segmentTagged(ph)[0]
  return first ? first.tag : 'x'
}

function isEtiquette(k: string): boolean {
  const toks = ngram.segment(k).filter((t) => t.trim())
  if (!toks.length) return false
  const hits = toks.filter((t) => ETIQUETTE_WORDS.has(t)).length
  return hits / toks.length >= ETIQUETTE_RATIO
}


/** 三级关联预计算：词表→same_form；骨架→derived；向量→related。 */
async function updateRelated(ctx: Ctx, cand: Candidate): Promise<void> {
  const rels: import('../models.ts').RelatedRef[] = []
  const headTokens = cand.channel === 'skeleton' ? new Set(cand.head.split(' ')) : new Set([cand.head])
  for (const m of allMemes(ctx.db)) {
    if (m.state === 'tombstone') continue
    if (cand.channel === 'phrase' || cand.channel === 'copy') {
      const terms = [m.name, ...m.aliases]
      for (const t of terms) {
        if (t === cand.head) {
          rels.push({ id: m.id, type: 'same_form', score: 0.95 })
          break
        }
        if (t.length >= 1 && cand.head.length >= 2 && cand.head.includes(t)) {
          rels.push({ id: m.id, type: 'same_form', score: 0.8 })
          break
        }
        if (cand.head.length >= 1 && t.length >= 2 && t.includes(cand.head)) {
          rels.push({ id: m.id, type: 'same_form', score: 0.8 })
          break
        }
      }
    } else {
      if (!m.matcher) continue
      for (const p of m.matcher.patterns) {
        const lits = new Set((p.tokens || []).filter((t) => !t.startsWith('<')))
        if (!lits.size || !headTokens.size) continue
        const inter = [...lits].filter((t) => headTokens.has(t)).length
        const union = new Set([...lits, ...headTokens]).size
        if (inter / Math.max(union, 1) >= 0.5) {
          rels.push({ id: m.id, type: 'derived', score: 0.7 })
          break
        }
      }
    }
  }
  if (ctx.embedder.available && cand.evidence_usages.length) {
    const text = cand.evidence_usages[cand.evidence_usages.length - 1].text
    for (const [mid, score] of await vectorNearest(ctx.db, text, ctx.embedder, 3)) {
      if (score >= 0.55 && !rels.some((r) => r.id === mid)) {
        rels.push({ id: mid, type: 'related', score: Math.round(score * 1000) / 1000 })
      }
    }
  }
  cand.related = rels.slice(0, 5)
}

function refreshZ(ctx: Ctx, cand: Candidate): void {
  const table = cand.channel === 'phrase' || cand.channel === 'copy' ? 'phrase_daily' as const : 'skel_daily' as const
  const [z] = zScore(ctx.db, table, cand.head)
  cand.z_score = z
}

/** 文本单元：真实评论 + 楼中楼短消息拼接（接龙的优雅实现）。 */
function collectUnits(comments: Row[]): Unit[] {
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
  const CHAIN_MIN_RUN = 2 // 连续 ≥2 条短消息即拼接
  for (const sibs of byRoot.values()) {
    sibs.sort((a, b) => a.ctime - b.ctime)
    const runs: Row[][] = []
    let run: Row[] = []
    for (const c of sibs) {
      const len = String(c.message ?? '').trim().length
      if (len > 0 && len <= 2) {
        run.push(c)
      } else {
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

const usageOf = (u: Unit): UsageSample => ({
  text: u.text, aid: u.aid, rpid: u.rpid, root: u.root,
  parent: u.parent, mid: u.mid, ctime: u.ctime, chain: u.chain,
})

const pairsOf = (ctx: Ctx, aids: Iterable<number>): VideoPair[] =>
  [...aids].map((aid) => ({ aid, up_mid: ctx.upMap.get(aid) ?? 0 }))

/** 候选写入统一收口：upsert → z 刷新 → 关联预计算 → 保存。 */
async function pump(ctx: Ctx, cand: Candidate): Promise<void> {
  refreshZ(ctx, cand)
  await updateRelated(ctx, cand)
  saveCand(ctx.db, cand)
}

/** 轮次信号更新主入口。 */
export async function updateSignals(db: DatabaseSync, cfg: ResolvedConfig, roundId: number): Promise<SignalsResult> {
  const res: SignalsResult = {
    scanned: 0, phrase_candidates: 0, skeleton_candidates: 0,
    copy_candidates: 0, image_candidates: 0, triggered: [],
  }
  const comments = commentsForRound(db, roundId)
  const units = collectUnits(comments)
  // 视频标题作为高权重单元入场：标题本身就在玩梗（up 主刻意为之），
  // rpid/mid 置 0——标题无楼中楼链，不参与交互配对与 df 文档计数
  for (const t of titlesForRound(db, roundId)) {
    units.push({
      text: t.title, aid: t.aid, rpid: 0, root: 0, parent: 0,
      mid: 0, ctime: t.pubdate, chain: false, weight: TITLE_WEIGHT,
    })
  }
  if (!units.length) return res
  res.scanned = units.length
  const ctx: Ctx = {
    db, roundId, day: todayIso(), upMap: upMidMap(db),
    embedder: getEmbedder(cfg.retrieval.embed_model), res,
    phCnt: new Map(), phVideos: new Map(), perComment: [],
  }
  // 分词一次，多处复用（短语通道 / 后缀族 / 既有候选合流）
  for (const u of units) {
    const msgPhrases = ngram.phrases(u.text)
    ctx.perComment.push([u, msgPhrases])
    for (const ph of msgPhrases) {
      ctx.phCnt.set(ph, (ctx.phCnt.get(ph) ?? 0) + u.weight)
      if (!ctx.phVideos.has(ph)) ctx.phVideos.set(ph, new Set())
      ctx.phVideos.get(ph)!.add(u.aid)
    }
  }
  await phraseChannel(ctx, genericSet(db, cfg))
  await copyChannel(ctx)
  await skeletonChannel(ctx)
  await imageChannel(ctx)
  return res
}

// ---- 短语通道：轮内轻门槛立户 + 既有候选 1 次再现即合流 + 后缀能产性合成 ----

async function phraseChannel(ctx: Ctx, generic: Set<string>): Promise<void> {
  const { db, roundId, res } = ctx
  const phDocs = new Map<string, Set<number>>()
  for (const [u, msgPhrases] of ctx.perComment) {
    for (const ph of msgPhrases) {
      if (!phDocs.has(ph)) phDocs.set(ph, new Set())
      phDocs.get(ph)!.add(u.rpid)
    }
  }
  const n = ctx.perComment.length
  const useDfFilter = n >= 50

  /** 结构性入榜判定：≥3 字豁免（长短语自选择性强）；≤2 字需要内容头或高频。 */
  const admitted = (p: string): boolean => {
    if (p.length >= 3) {
      if (!(ngram.isContentTag(headTag(p)) || (ctx.phCnt.get(p) ?? 0) >= 3)) return false
    } else if (!(ngram.isContentTag(headTag(p)) && (ctx.phCnt.get(p) ?? 0) >= MIN_OCCUR)) {
      return false
    }
    return !isEtiquette(p) // 纯客套组合（支持up主/视频做得真不错）复读再多也不是梗
  }

  const base: string[] = []
  for (const [p, cnt] of ctx.phCnt) {
    const docs = phDocs.get(p)!
    const dfOk = !useDfFilter || docs.size / n <= MAX_DF_RATIO
    if (cnt >= MIN_OCCUR && ctx.phVideos.get(p)!.size >= MIN_VIDEOS && !generic.has(p) && dfOk && admitted(p)) {
      base.push(p)
    }
  }
  // 注：不做同句 gram 折叠——复读句的子 gram 会入榜，但 head 感知的证据评分
  // （copy_pairs 只算近似独立成评的复读）使它们梗证分 ≈ 0 自然沉底；
  // 折叠曾误杀"绷"（叠用句）与"灵笼第二季"（子短语）。
  const rankedSet = new Set(base)
  const phUsages = new Map<string, UsageSample[]>()
  for (const [u, msgPhrases] of ctx.perComment) {
    for (const ph of msgPhrases) {
      if (!rankedSet.has(ph)) continue
      if (!phUsages.has(ph)) phUsages.set(ph, [])
      if (phUsages.get(ph)!.length < 6) phUsages.get(ph)!.push(usageOf(u))
    }
  }
  for (const ph of base) {
    const cand = upsertFromSignal(db, {
      head: ph, channel: 'phrase', kind_guess: 'word',
      usages: phUsages.get(ph) ?? [], video_pairs: pairsOf(ctx, ctx.phVideos.get(ph) ?? []),
      day: ctx.day, round_id: roundId,
    })
    await pump(ctx, cand)
    res.phrase_candidates += 1
  }
  // 短语总账：全部短语进日聚合（后缀家族检测的账本——族员常单轮低频，
  // 不入榜也要留痕，否则 "X麻了" 家族永远凑不齐 3 人）
  for (const [ph, cnt] of ctx.phCnt) {
    bumpDaily(ctx, 'phrase_daily', ph, cnt, ctx.phVideos.get(ph)?.size ?? 0)
  }
  // 既有候选本轮再现（1 次即合流：跨轮累积的另一半）
  reopenExisting(ctx, generic)
  await suffixFamilies(ctx)
}

function reopenExisting(ctx: Ctx, generic: Set<string>): void {
  const seenHeads = new Set<string>()
  const existingByHead = new Map(allActive(ctx.db).map((c) => [c.head, c] as const))
  for (const [u, msgPhrases] of ctx.perComment) {
    for (const ph of msgPhrases) {
      if (seenHeads.has(ph) || generic.has(ph)) continue
      const cand = existingByHead.get(ph)
      if (!cand || cand.channel !== 'phrase' || cand.last_round === ctx.roundId) continue
      upsertFromSignal(ctx.db, {
        head: ph, channel: 'phrase', kind_guess: cand.kind_guess,
        usages: [usageOf(u)], video_pairs: pairsOf(ctx, [u.aid]), day: ctx.day, round_id: ctx.roundId,
      })
      seenHeads.add(ph)
    }
    if (seenHeads.size > REOPEN_HEAD_LIMIT) break
  }
}

/**
 * 后缀能产性合成：赢麻了/亏麻了/输麻了 各自 dv 低，但同后缀家族是形态学
 * 能产性信号（X麻了/X哭了/X完了）——合成 "<X>后缀" 公式候选，让归纳器一次
 * 看到全族证据（否则只看单个变体，首轮归纳必错一半）。
 * 闸门：≥3 族员、家族内 ≥2 员自身跨视频、后缀用例以句尾/独立收束为主
 * （"X麻了"常收尾，"X时候"常在句中——后者不是梗公式）。
 */
async function suffixFamilies(ctx: Ctx): Promise<void> {
  const SUFFIX_MIN_FAMILY = 3
  const SUFFIX_MIN_CROSS_MEMBERS = 2
  // 第一步：从总账（本轮全量 + phrase_daily 历史）收集各后缀的族员
  const famBySuf = new Map<string, Set<string>>()
  const vidsByPhrase = new Map<string, number>()
  const addMember = (p: string, vids?: number) => {
    if (p.length < 3 || p.includes('<')) return
    const suf = p.slice(-2)
    if (!famBySuf.has(suf)) famBySuf.set(suf, new Set())
    famBySuf.get(suf)!.add(p)
    if (vids !== undefined) vidsByPhrase.set(p, Math.max(vidsByPhrase.get(p) ?? 0, vids))
  }
  for (const p of ctx.phCnt.keys()) addMember(p)
  for (const r of ctx.db.prepare('SELECT phrase, SUM(videos) AS v FROM phrase_daily GROUP BY phrase').all() as Row[]) {
    addMember(r.phrase as string, r.v as number) // 族员检测跨轮
  }
  for (const [p, vids] of ctx.phVideos) {
    if (famBySuf.get(p.slice(-2))?.has(p)) vidsByPhrase.set(p, Math.max(vidsByPhrase.get(p) ?? 0, vids.size))
  }

  const familyFires = (suf: string): boolean => {
    const fam = famBySuf.get(suf) ?? new Set<string>()
    if (fam.size < SUFFIX_MIN_FAMILY) return false
    // X 短（≤2 字）：族员长度贴近后缀本身，长族员是普通宾语搭配不是公式
    if (![...fam].some((p) => p.length <= suf.length + 2)) return false
    const cross = [...fam].filter((p) => (vidsByPhrase.get(p) ?? 0) >= MIN_VIDEOS).length
    return cross >= SUFFIX_MIN_CROSS_MEMBERS
  }
  const firing = new Set([...famBySuf.keys()].filter(familyFires))

  // 第二步：单遍重扫本轮文本，为触发家族收集用例（避免每后缀全量重扫）
  const famUsages = new Map<string, UsageSample[]>()
  const endFinal = new Map<string, number>()
  const famPhraseSet = new Set([...firing].flatMap((s) => [...famBySuf.get(s)!]))
  for (const [u, msgPhrases] of ctx.perComment) {
    const hitSufs = new Set(msgPhrases.filter((p) => famPhraseSet.has(p)).map((p) => p.slice(-2)))
    if (!hitSufs.size) continue
    const sample = usageOf(u)
    const tail = u.text.trimEnd().slice(-3)
    for (const suf of hitSufs) {
      if (!famUsages.has(suf)) famUsages.set(suf, [])
      famUsages.get(suf)!.push(sample)
      if (tail.endsWith(suf) || tail.endsWith(`${suf}。`) || tail.endsWith(`${suf}！`)) {
        endFinal.set(suf, (endFinal.get(suf) ?? 0) + 1)
      }
    }
  }
  // 第三步：过闸的家族合成 "<X>后缀" 公式候选
  for (const suf of [...firing].sort()) {
    const fam = famBySuf.get(suf)!
    const usages = famUsages.get(suf) ?? []
    if (!usages.length || (endFinal.get(suf) ?? 0) / usages.length < 0.5) continue
    const allVids = new Set<number>()
    for (const p of fam) for (const v of ctx.phVideos.get(p) ?? []) allVids.add(v)
    const head = `<X>${suf}`
    const cand = upsertFromSignal(ctx.db, {
      head, channel: 'skeleton', kind_guess: 'formula',
      usages: usages.slice(0, 6), video_pairs: pairsOf(ctx, allVids), day: ctx.day, round_id: ctx.roundId,
    })
    bumpDaily(ctx, 'skel_daily', head, usages.length, allVids.size)
    await pump(ctx, cand)
    ctx.res.skeleton_candidates += 1
  }
}

// ---- 复读通道：归一化整句跨视频重复 ----

async function copyChannel(ctx: Ctx): Promise<void> {
  const copyGroups = new Map<string, Unit[]>()
  for (const [u] of ctx.perComment) {
    const k = normText(u.text)
    if (k.length >= COPY_MIN_LEN && k.length <= COPY_MAX_LEN) {
      if (!copyGroups.has(k)) copyGroups.set(k, [])
      copyGroups.get(k)!.push(u)
    }
  }
  for (const [k, us] of copyGroups) {
    const vids = new Set(us.map((u) => u.aid))
    const wsum = us.reduce((a, u) => a + u.weight, 0)
    if (vids.size < MIN_VIDEOS || wsum < MIN_OCCUR) continue
    if (isEtiquette(k)) continue // 客套整句复读（跨视频粘贴）不是梗：成分检测拦截
    // 回复为主的复读 → 交互梗预判（楼中楼对就是 interaction 证据）
    const replyRatio = us.filter((u) => u.parent).length / us.length
    let kindGuess = replyRatio >= 0.5 ? 'interaction' : 'word'
    // 同头 phrase 候选已存在 → 复读证据并入该候选（不另立户）
    const head = k.slice(0, 24)
    let channel = 'copy'
    const row = ctx.db.prepare(
      "SELECT kind_guess FROM candidates WHERE head=? AND channel='phrase' AND state IN ('pending','triggered')",
    ).get(head) as Row | undefined
    if (row) {
      channel = 'phrase'
      if (kindGuess === 'word') kindGuess = row.kind_guess as string
    }
    const cand = upsertFromSignal(ctx.db, {
      head, channel, kind_guess: kindGuess,
      usages: us.slice(0, 6).map(usageOf), video_pairs: pairsOf(ctx, vids),
      day: ctx.day, round_id: ctx.roundId,
    })
    bumpDaily(ctx, 'phrase_daily', head, us.reduce((a, u) => a + u.weight, 0), vids.size)
    await pump(ctx, cand)
    ctx.res.copy_candidates += 1
  }
}

// ---- 骨架通道：掩码变体跨文本坍缩 ----

async function skeletonChannel(ctx: Ctx): Promise<void> {
  const skCnt = new Map<string, number>()
  const skVideos = new Map<string, Set<number>>()
  const skTexts = new Map<string, Set<string>>() // 出现过的不同文本（复制粘贴判别）
  const skUsages = new Map<string, UsageSample[]>()
  for (const [u] of ctx.perComment) {
    if (!u.text) continue
    for (const sk of skeletonVariants(u.text)) {
      skCnt.set(sk, (skCnt.get(sk) ?? 0) + u.weight)
      if (!skVideos.has(sk)) skVideos.set(sk, new Set())
      skVideos.get(sk)!.add(u.aid)
      if (!skTexts.has(sk)) skTexts.set(sk, new Set())
      if (skTexts.get(sk)!.size < SK_TEXT_SAMPLE) skTexts.get(sk)!.add(u.text)
      if (!skUsages.has(sk)) skUsages.set(sk, [])
      skUsages.get(sk)!.push(usageOf(u))
    }
  }
  const literalChars = (s: string) => s.split(' ').filter((t) => !t.startsWith('<')).reduce((a, t) => a + t.length, 0)
  const ranked = [...skCnt.keys()]
    .filter((s) => skTexts.get(s)!.size >= SKELETON_MIN_TEXTS
      && skVideos.get(s)!.size >= MIN_VIDEOS && literalChars(s) >= 2)
    .sort((a, b) => (skCnt.get(b) ?? 0) - (skCnt.get(a) ?? 0))
    .slice(0, TOP_SKELS)
  for (const sk of ranked) {
    const kind = sk.includes('《') || sk.includes('》') ? 'format' : 'formula'
    const cand = upsertFromSignal(ctx.db, {
      head: sk, channel: 'skeleton', kind_guess: kind,
      usages: skUsages.get(sk)!.slice(0, 6),
      video_pairs: pairsOf(ctx, skVideos.get(sk)!), day: ctx.day, round_id: ctx.roundId,
    })
    bumpDaily(ctx, 'skel_daily', sk, skCnt.get(sk) ?? 0, skVideos.get(sk)!.size)
    await pump(ctx, cand)
    ctx.res.skeleton_candidates += 1
  }
}

// ---- 图片通道（重复即梗）：pHash 汉明聚类 ----

async function imageChannel(ctx: Ctx): Promise<void> {
  const newImgs = ctx.db.prepare(
    'SELECT i.rpid AS rpid, i.url AS url, i.phash AS phash, c.oid AS oid, c.mid AS mid, c.ctime AS ctime '
    + 'FROM lake_comment_images i JOIN lake_comments c ON c.rpid=i.rpid WHERE i.round_id=? AND i.phash IS NOT NULL',
  ).all(ctx.roundId) as Row[]
  if (!newImgs.length) return
  const reps: Array<[string, string]> = []
  for (const r of ctx.db.prepare("SELECT head FROM candidates WHERE channel='image'").all() as Row[]) {
    const h = String(r.head).replace(/^img:/, '')
    if (h) reps.push([r.head as string, h])
  }
  for (const im of newImgs) {
    const ph = im.phash as string
    let matchHead = reps.find(([, h]) => imgHamming(ph, h) <= IMG_HAMMING_MAX)?.[0]
    if (matchHead === undefined) {
      matchHead = `img:${ph}`
      reps.push([matchHead, ph])
    }
    const cand = upsertFromSignal(ctx.db, {
      head: matchHead, channel: 'image', kind_guess: 'word',
      usages: [{
        text: `[图片] ${im.url}`, aid: im.oid, rpid: im.rpid,
        root: 0, parent: 0, mid: im.mid, ctime: im.ctime, chain: false,
      }],
      video_pairs: [{ aid: im.oid, up_mid: ctx.upMap.get(im.oid) ?? 0 }],
      day: ctx.day, round_id: ctx.roundId,
    })
    await updateRelated(ctx, cand)
    saveCand(ctx.db, cand)
    ctx.res.image_candidates += 1
  }
}
