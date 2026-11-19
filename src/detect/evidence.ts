/**
 * 梗证据评分：候选的"梗性"统计特征（零 LLM）。
 *
 * 设计动机（实战教训）：泛用词与真梗在"跨视频计数"上无法区分（"不行"dv=14，
 * "难绷"dv=6），手工黑名单打地鼠三轮仍失守。梗的本质是**被复读的表达**——
 * 泛用词出现在千变万化的句子里，真梗的用例文本/形状高度重复。四个可计算特征：
 *
 * - copy_pairs       跨视频完全重复的归一化文本对数（整句复读："警钟长鸣"×3）
 * - skel_top_share   最常见骨架占非平凡骨架的比例（"赢麻了/亏麻了/输麻了"坍缩为 "<ent>麻了"）
 * - standalone_rate  独立成评率（"典。"式整评就是梗）
 * - usage_text_share 重复文本占比（同文本多次出现，含同视频）
 *
 * meme_score 权重经真实湖回放校准，泛用词 ≈0，真梗 ≥1。
 */
import { normalize, PUNCT, skeletonTokens } from './skel.ts'
import type { UsageSample } from '../models.ts'

/** 复读判定的文本归一化：去槽位/标点/空白，仅保留内容字符。 */
const STRIP = new Set('，。！？；：、…—～·“”‘’()（）<>《》【】[].!?;:"\' \t\n\x00'.split(''))

const memoNorm = new Map<string, string>()
const memoSkel = new Map<string, string>()

function memoize<K, V>(store: Map<K, V>, key: K, make: (k: K) => V): V {
  if (store.has(key)) return store.get(key)!
  if (store.size > 65536) store.clear()
  const v = make(key)
  store.set(key, v)
  return v
}

/** 复读比较键：槽位占位归一 + 去标点空白。"[doge]好活" 与 "好活[doge]" 同键。 */
export function normText(text: string): string {
  return memoize(memoNorm, text, (t) => {
    const toks = normalize(t).filter((x) => !STRIP.has(x) && !x.startsWith('<'))
    return toks.join('').toLowerCase()
  })
}

/** 用例骨架（与发现层同一整备管道），供坍缩度统计。 */
export function skeletonOf(text: string): string {
  return memoize(memoSkel, text, (t) => skeletonTokens(normalize(t)).join(' '))
}

export interface MemeFeatures {
  copy_pairs: number
  skel_top_share: number
  standalone_rate: number
  usage_text_share: number
  n_usages: number
}

/** 梗性综合分：整句复读最强，模板坍缩次之，独立成评最弱（泛用客套词也能独立成评）。 */
export function memeScore(f: MemeFeatures): number {
  return 2.0 * Math.min(f.copy_pairs, 3)
    + 1.0 * f.skel_top_share
    + 0.5 * f.usage_text_share
    + 0.5 * f.standalone_rate
}

export function featuresToDict(f: MemeFeatures): Record<string, number> {
  return {
    copy_pairs: f.copy_pairs,
    skel_top_share: round3(f.skel_top_share),
    standalone_rate: round3(f.standalone_rate),
    usage_text_share: round3(f.usage_text_share),
    n_usages: f.n_usages,
    meme_score: round3(memeScore(f)),
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * 从用例样本计算梗特征。
 * head：候选词头。复读证据只算"该表达近似独立成评"的复读——否则复读长句的
 * 每个组成 gram（"干货"）都会继承整句的 copy_pairs，泛用词被复读句污染。
 */
export function memeFeatures(usages: UsageSample[], head = ''): MemeFeatures {
  const valid = usages.filter((u) => u && u.text && u.text.trim())
  if (!valid.length) {
    return { copy_pairs: 0, skel_top_share: 0, standalone_rate: 0, usage_text_share: 0, n_usages: 0 }
  }
  const texts = valid.map((u) => u.text)
  const aids = valid.map((u) => u.aid)

  // 独立用例：归一化文本 ≈ head 本身（窗口 ±1：±2 会让"干货"继承"干货满满"整句复读的证据）
  const headLen = head ? normText(head).length : 0
  const pairs = texts.map((t, i) => [t, aids[i]] as const)
  const keep = headLen
    ? pairs.filter(([t]) => Math.abs(normText(t).length - headLen) <= 1)
    : pairs
  const normedKeep = keep.map(([t]) => normText(t))

  // 跨视频重复文本对：同一归一化键出现在 ≥2 个不同视频 → 该键贡献 (n-1) 对
  const byKey = new Map<string, Set<number>>()
  keep.forEach(([, aid], i) => {
    const k = normedKeep[i]
    if (!k) return
    if (!byKey.has(k)) byKey.set(k, new Set())
    byKey.get(k)!.add(aid)
  })
  let copyPairs = 0
  for (const [k, vids] of byKey) {
    if (vids.size >= 2 && k.length >= 2) copyPairs += Math.max(vids.size - 1, 0)
  }

  // 骨架坍缩：非平凡骨架（≥2 token）中的众数占比
  const skels = texts.map((t) => skeletonOf(t)).filter((s) => (s.match(/ /g) || []).length >= 1)
  let skelTopShare = 0
  if (skels.length) {
    const counts = new Map<string, number>()
    let top = 0
    for (const s of skels) {
      const c = (counts.get(s) ?? 0) + 1
      counts.set(s, c)
      top = Math.max(top, c)
    }
    skelTopShare = top / skels.length
  }

  // 独立成评率 + 文本重复占比（独立用例口径）
  const standalone = texts.filter((t) => t.trim().length <= 6).length
  const cnt = new Map<string, number>()
  for (const k of normedKeep) if (k) cnt.set(k, (cnt.get(k) ?? 0) + 1)
  let dupN = 0
  for (const c of cnt.values()) if (c >= 2) dupN += c

  return {
    copy_pairs: copyPairs,
    skel_top_share: skelTopShare,
    standalone_rate: standalone / texts.length,
    usage_text_share: dupN / texts.length,
    n_usages: texts.length,
  }
}

export { PUNCT }
