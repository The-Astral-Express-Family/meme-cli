/**
 * 证据更新管线（v0.11）：编排层。抽取逻辑在 extract.ts（两套统计抽取器），
 * 这里只负责跨轮编排：语料构建 → 固定表达/模板候选入池 → 图梗 → 既有候选
 * 再现合流 → 池卫生。零 LLM；语义特征由 evidence/semantics 按需现算。
 *
 * 通道语义（candidates.channel）：
 * - phrase   固定表达（词/短语，PMI 凝固 + 最大单元）
 * - copy     整句字面复读（"梗=被复读的表达"的最直接证据）
 * - skeleton 模板（带槽句式，锚点共识扩展）
 * - image    图梗（pHash 聚类，不变）
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { kvGet, tx } from '../db.ts'
import type { ResolvedConfig } from '../config.ts'
import { allActive, hygienePass, save as saveCand, upsertFromSignal, type VideoPair } from '../candidates.ts'
import type { Candidate } from '../models.ts'
import { allMemes } from '../entries.ts'
import { commentsForRound, roundDay, titlesForRound, upMidMap } from '../lake.ts'
import { vectorNearest } from '../match/pipeline.ts'
import { getEmbedder, type Embedder } from '../match/vector.ts'
import { type UsageSample } from '../models.ts'
import * as extract from './extract.ts'
import { burstLevel } from './burst.ts'
import { hamming as imgHamming } from './imgphash.ts'
import { banKey, isStopped, normalizeHead } from './evidence.ts'

/** 语法虚词核心表（零梗义争议；泛用实词不入列——统计判别与语义标记负责）。 */
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

const REOPEN_HEAD_LIMIT = 5000 // 既有候选合流循环的保险丝
const IMG_HAMMING_MAX = 8

export interface SignalsResult {
  scanned: number
  phrase_candidates: number
  skeleton_candidates: number
  copy_candidates: number
  image_candidates: number
  triggered: string[]
  /** 池卫生：包含族合并数。 */
  merged: number
  /** 池卫生：纯复制粘贴切片剪枝数。 */
  pruned_spam: number
}

/** 三级停用词：内置 GENERIC ∪ 配置 generic_extra ∪ kv generic_auto（meme ban 沉淀）；kv generic_allow 为豁免表。 */
export function genericSet(db: DatabaseSync, cfg: ResolvedConfig): Set<string> {
  const s = new Set<string>()
  for (const w of GENERIC) s.add(normalizeHead(w))
  for (const w of cfg.genericExtra) s.add(normalizeHead(w))
  try {
    // 封禁值已是 banKey 规范形，逐字加入：再走 normalizeHead 会重新吞掉数字
    for (const w of JSON.parse(kvGet(db, 'generic_auto', '[]') || '[]') as string[]) s.add(banKey(w))
  } catch { /* 坏数据忽略 */ }
  try {
    for (const w of JSON.parse(kvGet(db, 'generic_allow', '[]') || '[]') as string[]) {
      s.delete(banKey(w))
      s.delete(normalizeHead(w))
    }
  } catch { /* 坏数据忽略 */ }
  return s
}

/** 语义客套云只使用内置/配置种子与操作员显式豁免；--ban 保持精确封禁，不做语义家族连带否决。 */
export function semanticGenericSet(db: DatabaseSync, cfg: ResolvedConfig): Set<string> {
  const s = new Set<string>()
  for (const w of GENERIC) s.add(normalizeHead(w))
  for (const w of cfg.genericExtra) s.add(normalizeHead(w))
  try {
    for (const w of JSON.parse(kvGet(db, 'generic_allow', '[]') || '[]') as string[]) {
      s.delete(banKey(w))
      s.delete(normalizeHead(w))
    }
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
  const [z] = burstLevel(ctx.db, table, cand.head)
  cand.z_score = z
}

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
    copy_candidates: 0, image_candidates: 0, triggered: [], merged: 0, pruned_spam: 0,
  }
  const comments = commentsForRound(db, roundId)
  const units = extract.collectUnits(comments)
  // 视频标题作为高权重单元入场：标题本身就在玩梗（up 主刻意为之），
  // rpid/mid 置 0——标题无楼中楼链，不参与交互配对与 df 文档计数
  for (const t of titlesForRound(db, roundId)) {
    units.push({
      text: t.title, aid: t.aid, rpid: 0, root: 0, parent: 0,
      mid: 0, ctime: t.pubdate, chain: false, weight: extract.TITLE_WEIGHT,
    })
  }
  if (!units.length) {
    const hyg = hygienePass(db) // 空轮也自愈：--no-fetch 的存量轮照常清池
    res.merged = hyg.merged
    res.pruned_spam = hyg.pruned_spam
    return res
  }
  res.scanned = units.length
  const generic = genericSet(db, cfg)
  const ctx: Ctx = {
    db, roundId, day: roundDay(db, roundId), upMap: upMidMap(db),
    embedder: getEmbedder(cfg.retrieval.embed_model), res, generic,
  }
  const corpus = extract.buildCorpus(units)
  // 跨轮创建补救：低频持续词汇的完整表达立户（历史天数参与判定，见 extractFixed）
  const hasHistory = (head: string): number => {
    const row = db.prepare('SELECT COUNT(DISTINCT day) AS d FROM phrase_daily WHERE phrase=? AND day<?')
      .get(head, ctx.day) as Row
    return (row?.d as number) ?? 0
  }
  const fixed = extract.extractFixed(corpus, generic, hasHistory)
  const pairsOf = (aids: Iterable<number>): VideoPair[] =>
    [...aids].map((aid) => ({ aid, up_mid: ctx.upMap.get(aid) ?? 0 }))

  // 固定表达 → phrase 候选
  const bumped = new Set<string>() // 已显式归账的词头：短语总账跳过，防止同一词头记两次
  for (const f of fixed) {
    if (f.channel !== 'phrase') continue
    const cand = upsertFromSignal(db, {
      head: f.head, channel: 'phrase', kind_guess: 'word',
      usages: f.usages, video_pairs: pairsOf(f.aids), day: ctx.day, round_id: roundId,
    })
    bumpDaily(ctx, 'phrase_daily', f.head, f.cnt, f.dv)
    bumped.add(f.head)
    await pump(ctx, cand)
    res.phrase_candidates += 1
  }
  // 整句复读 → copy 候选（同头 phrase 候选已存在则并入，不另立户）
  for (const f of fixed) {
    if (f.channel !== 'copy') continue
    const row = db.prepare(
      "SELECT kind_guess FROM candidates WHERE head=? AND channel='phrase' AND state IN ('pending','triggered')",
    ).get(f.head) as Row | undefined
    let channel = 'copy'
    let kind: string = f.kind
    if (row) {
      channel = 'phrase'
      if (kind === 'word') kind = row.kind_guess as string
    }
    const cand = upsertFromSignal(db, {
      head: f.head, channel, kind_guess: kind,
      usages: f.usages, video_pairs: pairsOf(f.aids),
      day: ctx.day, round_id: roundId,
    })
    bumpDaily(ctx, 'phrase_daily', f.head, f.cnt, f.dv)
    bumped.add(f.head)
    await pump(ctx, cand)
    res.copy_candidates += 1
  }
  // 模板 → skeleton 候选
  for (const t of extract.extractTemplates(corpus, generic)) {
    const cand = upsertFromSignal(db, {
      head: t.head, channel: 'skeleton', kind_guess: 'formula',
      usages: t.usages, video_pairs: pairsOf(t.aids),
      day: ctx.day, round_id: roundId,
    })
    bumpDaily(ctx, 'skel_daily', t.head, t.cnt, t.dv)
    await pump(ctx, cand)
    res.skeleton_candidates += 1
  }
  // 短语总账：全部 gram 进日聚合——跨轮创建补救的账本（低频持续词汇
  // 不入榜也要留痕，否则 phrase_daily 永远凑不出历史天数）。
  // 词头已在候选循环显式归账（词头即 gram，不跳过会记两次）。
  tx(db, () => {
    for (const [g, st] of corpus.grams) {
      if (st.cnt >= 1 && !bumped.has(g)) bumpDaily(ctx, 'phrase_daily', g, st.cnt, st.vids.size)
    }
  })
  // 既有候选本轮再现（1 次即合流：跨轮累积的另一半）
  reopenExisting(ctx, corpus)
  await imageChannel(ctx)
  const hyg = hygienePass(db)
  res.merged = hyg.merged
  res.pruned_spam = hyg.pruned_spam
  return res
}

/** 一轮信号更新的共享上下文。 */
interface Ctx {
  db: DatabaseSync
  roundId: number
  day: string
  upMap: Map<number, number>
  embedder: Embedder
  generic: Set<string>
  res: SignalsResult
}

function reopenExisting(ctx: Ctx, corpus: extract.Corpus): void {
  const seenHeads = new Set<string>()
  const existingByHead = new Map(allActive(ctx.db).map((c) => [c.head, c] as const))
  for (const cu of corpus.units) {
    for (const ph of cu.gramSet) {
      if (seenHeads.has(ph) || isStopped(ctx.generic, ph)) continue
      const cand = existingByHead.get(ph)
      if (!cand || cand.channel !== 'phrase' || cand.last_round === ctx.roundId) continue
      upsertFromSignal(ctx.db, {
        head: ph, channel: 'phrase', kind_guess: cand.kind_guess,
        usages: [unitUsage(cu.unit)], video_pairs: [{ aid: cu.unit.aid, up_mid: ctx.upMap.get(cu.unit.aid) ?? 0 }],
        day: ctx.day, round_id: ctx.roundId,
      })
      seenHeads.add(ph)
    }
    if (seenHeads.size > REOPEN_HEAD_LIMIT) break
  }
}

function unitUsage(u: extract.Unit): UsageSample {
  return { text: u.text, aid: u.aid, rpid: u.rpid, root: u.root, parent: u.parent, mid: u.mid, ctime: u.ctime, chain: u.chain }
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
    if (isStopped(ctx.generic, `img:${im.phash as string}`)) continue
    const ph = im.phash as string
    let matchHead = reps.find(([, h]) => imgHamming(ph, h) <= IMG_HAMMING_MAX)?.[0]
    if (matchHead === undefined) {
      matchHead = `img:${ph}`
      reps.push([matchHead, ph])
    }
    if (isStopped(ctx.generic, matchHead)) continue
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
