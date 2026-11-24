/**
 * 语义特征层（轻量模型）：bge-small-zh-v1.5 句嵌入上的判别信号。
 * Embedder 不可用（离线/下载失败/MEME_EMBED_OFF=1）时全部优雅降级为无标记。
 *
 * - response_generic 泛回应：候选用例均值向量与"客套参考云"（内置/配置停用种子、
 *   ETIQUETTE 词表的嵌入，运行时词表种子，非真梗标注；generic_auto 精确 ban 不进语义云）
 *   最大余弦 ≥0.87 → 是的/来啦类的未枚举变体（FM3）。
 *   标定（2026-11-22 真实池）：回应词 0.870-0.917，真梗最高 0.841（笑死），
 *   阈值 0.87 无真梗误标；边距薄（0.03），故此标记只作触发否决 + 轻罚分，
 *   误标真梗时不阻断操作员经由榜单/搜索的发现（罚分大，若误标需优先复核）。
 * - praise_generic 泛夸：词头与"通用夸赞词云"的语义近邻（可爱/好看类日常赞美词）。
 *   2026-11-22 第二轮判定后加入：泛夸词（可爱 dv22/好看 dv41）是触发队列的主要
 *   噪音源；嵌入可分性中等（真梗 nb 0.837 安全、神系 0.887+ 被覆盖），故只作
 *   排序罚分（−2.0）供操作员复核，不否决触发。
 * - fillSpread 槽填充离散度：模板字面核心在用例中定位后收集填充物，填充
 *   嵌入离散度低 = 槽位不是语义自由的（语法模式伪装的公式，FM4 二道闸；
 *   首道闸是抽取期的填充多样性门控）。
 *
 * 实测否决（2026-11-22 真实池标定）：**上下文离散度不能区分话题词与梗**——
 * 韩立 0.648 ≈ 绷 0.696 ≈ 笑死 0.676（评论句子的语言差异远大于话题差异，
 * bge 句嵌入基线余弦 ~0.65-0.70）。"话题嫌疑"判据不成立，话题词治理走
 * 操作员 ban 沉淀（generic_auto）方向。
 *
 * 方法依据见 docs/references.md（Ryskina 2020、Martinc 2019、Pei 2019）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { getEmbedder, cosine, type Embedder } from '../match/vector.ts'
import type { ResolvedConfig } from '../config.ts'
import { semanticGenericSet } from './signals.ts'
import { ETIQUETTE_WORDS } from './extract.ts'
import type { Candidate } from '../models.ts'
import { allFunctionCore, type ScoreFlags } from './evidence.ts'

/** 泛回应（2026-11-22 真实池标定，两组信号）：
 * 用例均值向量 ≥0.87（裸复读型回应词）或词头本体向量 ≥0.93（带上下文用例的
 * 回应词——"来啦"0.957/来吧 0.950/哦哦哦 0.975/是的 0.976 vs 真梗最高 0.871）。 */
const RESPONSE_USAGE_SIM = 0.87
const RESPONSE_HEAD_SIM = 0.93
/**
 * 泛夸参考云：通用夸赞/感叹词（日常赞美词汇本身，无玩梗指涉）。黑名单方向的
 * 运行时词表种子，与 ETIQUETTE 同性质——只用来给排序罚分，不作触发否决。
 * 标定（2026-11-22 真实池，head→云最大余弦）：可爱 0.866/好看 0.919/牛 0.902/
 * 精彩 0.890/好快 0.879 被捕获；真梗边距薄——nb 0.837（安全）、没绷住 0.760（安全），
 * 但 神了 0.896/可爱喵 0.882 被覆盖（操作员确认 神系是梗——标记只罚分不否决，
 * 操作员按"表述形成时间"判据人工复核）。
 */
const PRAISE_WORDS = [
  '可爱', '好看', '漂亮', '帅', '美', '天才', '厉害', '牛', '牛逼', '棒', '优秀',
  '完美', '好听', '好玩', '有趣', '舒服', '神奇', '精彩', '惊喜', '绝了', '强', '赞',
]
const PRAISE_HEAD_SIM = 0.85
/** 弱模板：填充平均成对余弦高于此值（填充物语义近同 → 槽位不自由，
 * "X分钟"类数量词槽——首道闸是抽取期的填充多样性门控，此处为二道闸）。
 * 阈值依据：真 bge 空间里无关文本基线 ~0.65，近同文本 ≥0.85。 */
const FILL_SPREAD_MIN = 0.85

/** 按嵌入器实例隔离的向量缓存（不同嵌入器/测试实例的向量空间不通用）。 */
const vecCaches = new WeakMap<Embedder, Map<string, number[]>>()

function cacheOf(embedder: Embedder): Map<string, number[]> {
  let m = vecCaches.get(embedder)
  if (!m) {
    m = new Map()
    vecCaches.set(embedder, m)
  }
  return m
}

async function embedCached(embedder: Embedder, texts: string[]): Promise<number[][] | null> {
  const cache = cacheOf(embedder)
  const missing = texts.filter((t) => !cache.has(t))
  if (missing.length) {
    const vecs = await embedder.embed(missing)
    if (!vecs) return null
    missing.forEach((t, i) => cache.set(t, vecs[i]))
    if (cache.size > 50000) cache.clear()
  }
  return texts.map((t) => cache.get(t)!)
}

/** 平均成对余弦（≤10 条；不足 2 条返回 null）。 */
export async function pairwiseSpread(embedder: Embedder, texts: string[]): Promise<number | null> {
  const uniq = [...new Set(texts.filter((t) => t && t.trim()))].slice(0, 10)
  if (uniq.length < 2) return null
  const vecs = await embedCached(embedder, uniq)
  if (!vecs) return null
  let sum = 0
  let n = 0
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sum += cosine(vecs[i], vecs[j])
      n++
    }
  }
  return n ? sum / n : null
}

/** 客套参考云缓存（按嵌入器实例隔离——词表随 db kv 变化时按词集键再校验）。 */
const phaticCache = new WeakMap<Embedder, Map<string, number[][]>>()

/** 客套参考云：内置/配置停用种子 ∪ ETIQUETTE；generic_auto 的精确 ban 不进入语义云。 */
async function phaticReference(db: DatabaseSync, embedder: Embedder, cfg: ResolvedConfig): Promise<number[][]> {
  const words = new Set<string>()
  for (const w of semanticGenericSet(db, cfg)) if (w.length <= 4) words.add(w)
  for (const w of ETIQUETTE_WORDS) if (w.length <= 4) words.add(w)
  const key = [...words].sort().join('\x00')
  let byKey = phaticCache.get(embedder)
  if (!byKey) {
    byKey = new Map()
    phaticCache.set(embedder, byKey)
  }
  const hit = byKey.get(key)
  if (hit) return hit
  const vecs = (await embedCached(embedder, [...words])) ?? []
  byKey.set(key, vecs)
  return vecs
}

/** 模板字面段（剔除 <X>/<ent> 槽位标记；紧凑头与空格头都兼容）。 */
function headLiterals(head: string): string[] {
  return head.replace(/<[A-Za-z]+>/g, ' ').split(/\s+/).filter((t) => t && !t.startsWith('<'))
}

/** 模板候选的槽填充：按字面段顺序在用例文本中定位，收集中间/边缘材料。 */
function fillingsOf(cand: Candidate): string[] {
  const lits = headLiterals(cand.head)
  if (!lits.length) return []
  const out: string[] = []
  for (const u of cand.evidence_usages) {
    let pos = 0
    let prevEnd = -1
    for (const lit of lits) {
      const idx = u.text.indexOf(lit, pos)
      if (idx < 0) {
        prevEnd = -1
        break
      }
      if (prevEnd >= 0 && idx > prevEnd) out.push(u.text.slice(prevEnd, idx))
      pos = idx + lit.length
      prevEnd = pos
    }
    if (prevEnd >= 0 && prevEnd < u.text.length) out.push(u.text.slice(prevEnd, prevEnd + 12))
  }
  return out.filter((s) => s.trim().length >= 1)
}

/**
 * 计算候选的语义标记（仅对过了体量门的候选调用——嵌入调用有成本）。
 * 返回增量 flags；embedder 不可用时仍保留纯 CPU 的 all_function_core，其余标记为空。
 */
export async function semanticFlags(
  db: DatabaseSync, cfg: ResolvedConfig, cand: Candidate, embedder?: Embedder,
): Promise<ScoreFlags> {
  // embedder 可注入（测试用假嵌入器）；缺省用全局 getEmbedder
  const emb = embedder ?? getEmbedder(cfg.retrieval.embed_model)
  const flags: ScoreFlags = {}
  if (cand.channel !== 'image' && allFunctionCore(cand.head)) flags.all_function_core = true
  if (!emb.available) return flags
  if (cand.channel === 'phrase' || cand.channel === 'copy') {
    // 泛回应：短候选的用例均值 / 词头本体与客套云的近邻（2026-11-22 标定阈值）
    if (cand.head.length <= 4) {
      const ref = await phaticReference(db, emb, cfg)
      const texts = cand.evidence_usages.map((u) => u.text).filter((t) => t && t.trim()).slice(0, 10)
      const vecs = await embedCached(emb, texts)
      if (vecs && ref.length) {
        const mean = vecs[0].map((_, i) => vecs.reduce((s, v) => s + v[i], 0) / vecs.length)
        const norm = Math.sqrt(mean.reduce((a, x) => a + x * x, 0)) || 1
        for (let i = 0; i < mean.length; i++) mean[i] /= norm
        let maxSim = 0
        for (const v of ref) maxSim = Math.max(maxSim, cosine(mean, v))
        if (maxSim >= RESPONSE_USAGE_SIM) flags.response_generic = true
      }
      if (!flags.response_generic && ref.length) {
        const hv = await embedCached(emb, [cand.head])
        if (hv && hv.length) {
          let maxSim = 0
          for (const v of ref) maxSim = Math.max(maxSim, cosine(hv[0], v))
          if (maxSim >= RESPONSE_HEAD_SIM) flags.response_generic = true
        }
      }
      // 泛夸：词头本体与夸赞云的近邻（只罚分不否决——见 PRAISE_WORDS 标定注记）
      if (cand.head.length <= 6) {
        const pv = await embedCached(emb, PRAISE_WORDS)
        const hv = await embedCached(emb, [cand.head])
        if (pv && hv && pv.length && hv.length) {
          let maxSim = 0
          for (const v of pv) maxSim = Math.max(maxSim, cosine(hv[0], v))
          if (maxSim >= PRAISE_HEAD_SIM) flags.praise_generic = true
        }
      }
    }
  } else if (cand.channel === 'skeleton') {
    // 弱模板：槽填充过于近同（<X>分钟 类语法模式的二道闸）
    const fills = fillingsOf(cand)
    if (fills.length >= 3) {
      const spread = await pairwiseSpread(emb, fills)
      if (spread !== null && spread >= FILL_SPREAD_MIN) flags.weak_template = true
    }
    // 模板核心本身是回应词（<X>来吧 类）→ 泛回应
    const core = headLiterals(cand.head).join('')
    if (core.length > 0 && core.length <= 4) {
      const ref = await phaticReference(db, emb, cfg)
      const vecs = await embedCached(emb, [core])
      if (vecs && vecs.length && ref.length) {
        let maxSim = 0
        for (const v of ref) maxSim = Math.max(maxSim, cosine(vecs[0], v))
        if (maxSim >= RESPONSE_HEAD_SIM) flags.response_generic = true
      }
    }
  }
  return flags
}
