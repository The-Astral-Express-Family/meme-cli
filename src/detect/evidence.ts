/**
 * 梗证据评分（v0.11）：候选的"梗性"统计特征 + 跨语料显著性。
 *
 * 设计动机（实战教训）：泛用词与真梗在"跨视频计数"上无法区分（"不行"dv=14，
 * "难绷"dv=6），手工黑名单打地鼠三轮仍失守。梗的本质是**被复读的表达**——
 * 泛用词出现在千变万化的句子里，真梗的用例文本/形状高度重复。
 *
 * 特征（v2）：
 * - copy_pairs       跨视频完全重复的归一化文本对数（整句复读："警钟长鸣"×3）
 * - skel_top_share   最常见骨架占非平凡骨架的比例（"赢麻了/亏麻了"坍缩为 "<ent>麻了"）
 * - standalone_rate  独立成评率（"典。"式整评就是梗）
 * - usage_text_share 重复文本占比
 * - keyness          跨语料显著性（Dunning LLR，近 7 天 vs 8-90 天基线；Dunning 1993 /
 *                    Rayson & Garside 2000——泛回应词"是的"两边分布无差异 ≈0，
 *                    梗浪表达显著超预期）
 * - boundary_entropy 边界自由度（用例文本中词头左右邻字的分布熵——Matrix67
 *                    "自由程度"；切片（灵笼第→二）右邻被单一字主导，熵≈0 沉底）
 *
 * 语义标记（flags，可选注入，semantics.ts 计算）：topic_suspect（话题嫌疑）、
 * response_generic（泛回应）、weak_template（弱模板）——负面标记直接减分。
 *
 * 方法依据见 docs/references.md。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { normalize, PUNCT, skeletonTokens } from './skel.ts'
import { segmentTagged } from '../tokenize.ts'
import { isContentTag } from './ngram.ts'
import type { Candidate, UsageSample } from '../models.ts'

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

/** 封禁与候选解析共用的精确词头归一化；模板保留槽位，固定表达去标点空白。 */
export function normalizeHead(head: string): string {
  const trimmed = head.trim().toLowerCase()
  if (trimmed.startsWith('img:')) return trimmed
  return trimmed.includes('<') ? trimmed.replace(/\s+/g, '') : normText(trimmed)
}

/**
 * 封禁键：操作员封禁的作用域单位。与 normalizeHead 的唯一区别是**保留数字**——
 * normalizeHead 走 normText，会把数字掩成槽位后丢弃（"绝区零2.0"→"绝区零"、
 * "22娘"→"娘"），拿它当封禁键会静默扩大封禁范围，并让纯数字词头无法封禁。
 */
export function banKey(head: string): string {
  const trimmed = head.trim().toLowerCase()
  if (trimmed.startsWith('img:')) return trimmed
  if (trimmed.includes('<')) return trimmed.replace(/\s+/g, '')
  return [...trimmed].filter((ch) => !STRIP.has(ch)).join('')
}

/** 停用词判定：内置/配置词按 normalizeHead 入表，操作员封禁按 banKey 入表，两侧都查。 */
export function isStopped(generic: Set<string>, head: string): boolean {
  return generic.has(normalizeHead(head)) || generic.has(banKey(head))
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 完整形是否在用例中独立出现：固定表达精确相等/严格包含；模板按槽位形状另算。 */
export function isStandaloneUsage(text: string, head: string): boolean {
  if (!head || !text.trim()) return false
  const normalized = normText(text)
  if (head.includes('<')) {
    const parts = head.split(/(<[^>]+>)/).filter(Boolean)
    const pattern = parts.map((part) => part.startsWith('<') && part.endsWith('>') ? '[\\s\\S]+?' : escapeRegExp(normText(part))).join('')
    return Boolean(pattern) && new RegExp(pattern).test(normalized)
  }
  const complete = normalizeHead(head)
  if (!complete) return false
  return normalized === complete || (normalized.length > complete.length && normalized.includes(complete))
}

export interface MemeFeatures {
  copy_pairs: number
  skel_top_share: number
  standalone_rate: number
  usage_text_share: number
  n_usages: number
}

/** 语义/结构负面标记（semantics.ts 与模板通道注入；缺省无标记）。 */
export interface ScoreFlags {
  /** 泛回应：与已知客套词表的语义近邻（是的/来啦类的未枚举变体）。 */
  response_generic?: boolean
  /** 泛夸：与通用夸赞词表的语义近邻（可爱/好看类——日常赞美词本身，非玩梗用法）。
   * 只作排序罚分不否决触发：泛夸词与真梗在嵌入空间边距薄（神了 0.896 vs 可爱 0.866），
   * "神"系确认是梗但被泛夸云覆盖，操作员判据（表述形成时间）交由时间维信号承担。 */
  praise_generic?: boolean
  /** 弱模板：槽填充语义离散度低（语法模式伪装的公式）。 */
  weak_template?: boolean
  /** 全虚词核心：模板字面核心全是功能词性（"就行了"类）。 */
  all_function_core?: boolean
}

export interface ScoreResult {
  features: MemeFeatures
  flags: ScoreFlags
  score: number
  /** Dunning LLR（原始值）；无日聚合数据（图梗）为 null。 */
  keyness: number | null
  /** 边界熵（min(左,右) 归一到 0..1）；词头不出现在用例文本中（模板/图梗）为 null。 */
  boundary_entropy: number | null
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

/** 触发门质量分（纯特征：复读/坍缩/独立成评/文本重复）——广度 dv 与时间维不进门。 */
export function memeScore(f: MemeFeatures): number {
  return 2.0 * Math.min(f.copy_pairs, 3)
    + 1.0 * f.skel_top_share
    + 0.5 * f.usage_text_share
    + 0.5 * f.standalone_rate
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
  const headLen = head && !head.includes('<') ? normText(head).length : 0
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

  // 独立成评：必须是候选完整形本身，或严格包含完整形；模板按槽位形状判断。
  const standalone = texts.filter((t) => isStandaloneUsage(t, head)).length
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

// ---- 跨语料显著性（keyness LLR）与边界熵 ----

/** 2×2 列联表 Dunning LLR（0*ln0=0 约定）。 */
export function llr2x2(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  if (n <= 0) return 0
  const xlog = (x: number): number => (x > 0 ? x * Math.log(x) : 0)
  return 2 * (
    xlog(a) + xlog(b) + xlog(c) + xlog(d)
    - xlog(a + b) - xlog(c + d) - xlog(a + c) - xlog(b + d)
    + n * Math.log(n)
  )
}

const RECENT_DAYS = 7
const BASE_DAYS = 83 // 基线窗口 8..90 天

const isoDay = (d: Date): string => {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 日聚合表查询窗口：近 7 天（recent）与 8-90 天基线（base），双侧含端点。 */
function dayWindows(today: Date): { day0: string; recentStart: string; baseStart: string; baseEnd: string } {
  return {
    day0: isoDay(today),
    recentStart: isoDay(new Date(today.getTime() - (RECENT_DAYS - 1) * 86400_000)),
    baseEnd: isoDay(new Date(today.getTime() - RECENT_DAYS * 86400_000)),
    baseStart: isoDay(new Date(today.getTime() - (RECENT_DAYS + BASE_DAYS) * 86400_000)),
  }
}

function dailyTable(channel: string): { table: 'phrase_daily' | 'skel_daily'; col: 'phrase' | 'skel' } {
  const table = channel === 'skeleton' ? 'skel_daily' as const : 'phrase_daily' as const
  return { table, col: table === 'phrase_daily' ? 'phrase' as const : 'skel' as const }
}

/**
 * 词头的终身出现次数（日聚合账本的总和）——体量线的数据源。
 * 用绝对次数而非跨视频数：同一视频下的反复复读同样是复读指征（操作员
 * 2026-11-22 判定），跨视频数会把单视频评论区的梗浪漏掉。次数 ≥ 跨视频数
 * 恒成立，次数线是跨视频线的严格放宽。图梗无日聚合账本，返回 0（调用方
 * 对图梗改用跨视频数）。
 */
export function lifetimeCount(db: DatabaseSync, head: string, channel: string): number {
  if (channel === 'image') return 0
  const { table, col } = dailyTable(channel)
  return (db.prepare(`SELECT COALESCE(SUM(cnt),0) AS s FROM ${table} WHERE ${col}=?`)
    .get(head) as Row).s as number
}

/**
 * 词头的 keyness：近 7 天计数 vs 8-90 天基线，全表总量为背景。
 * 表按通道选（phrase/copy → phrase_daily；skeleton → skel_daily）。
 * 全表总量按 (表+窗口) 进程内缓存——day 列无索引，基线聚合是全表扫描，
 * 数千候选各扫两遍是存量模式的主要耗时源（36 万行 × 1.4 万次）；
 * 词头自身计数走 (phrase, day) 主键前缀定位，无需缓存。
 */
const keynessTotMemo = new Map<string, { tr: number; tb: number }>()

export function keynessOf(db: DatabaseSync, head: string, channel: string, today = new Date()): number | null {
  if (channel === 'image') return null
  const { table, col } = dailyTable(channel)
  const { day0, recentStart, baseStart, baseEnd } = dayWindows(today)
  const totKey = `${table}|${recentStart}|${day0}|${baseStart}|${baseEnd}`
  let tot = keynessTotMemo.get(totKey)
  if (!tot) {
    const totQ = db.prepare(`SELECT COALESCE(SUM(cnt),0) AS s FROM ${table} WHERE day>=? AND day<=?`)
    tot = {
      tr: (totQ.get(recentStart, day0) as Row).s as number,
      tb: (totQ.get(baseStart, baseEnd) as Row).s as number,
    }
    keynessTotMemo.set(totKey, tot)
  }
  const headQ = db.prepare(`SELECT COALESCE(SUM(cnt),0) AS s FROM ${table} WHERE ${col}=? AND day>=? AND day<=?`)
  const a = (headQ.get(head, recentStart, day0) as Row).s as number
  const c = (headQ.get(head, baseStart, baseEnd) as Row).s as number
  if (tot.tb <= 0) return null // 基线窗口无数据（安装未满 8 天/重建初期）→ 时间维未立，不可测
  return llr2x2(a, Math.max(tot.tr - a, 0), c, Math.max(tot.tb - c, 0))
}

/**
 * 边界熵：用例文本里词头的左/右邻字分布熵取 min，归一到 0..1。
 * 真梗词头边界自由（前后接法多样）；切片（"灵笼第"→"二"）被单一邻居主导。
 * 词头在用例中原样出现才可测；模板/图梗词头不在文本中 → null。
 */
export function boundaryEntropy(usages: UsageSample[], head: string): number | null {
  if (!head || head.includes('<') || head.startsWith('img:')) return null
  const lefts = new Map<string, number>()
  const rights = new Map<string, number>()
  let hits = 0
  const neighborClass = (ch: string): string => /[\u4e00-\u9fff]/.test(ch) ? ch : /[A-Za-z]/.test(ch) ? 'A' : /[0-9０-９]/.test(ch) ? 'N' : ''
  for (const u of usages) {
    const idx = u.text ? u.text.indexOf(head) : -1
    if (idx < 0) continue
    hits++
    const l = idx > 0 ? neighborClass(u.text[idx - 1]) : '#'
    const r = idx + head.length < u.text.length ? neighborClass(u.text[idx + head.length]) : '#'
    if (l) lefts.set(l, (lefts.get(l) ?? 0) + 1)
    if (r) rights.set(r, (rights.get(r) ?? 0) + 1)
  }
  if (hits < 2) return null
  const entropy = (m: Map<string, number>): number => {
    let total = 0
    for (const v of m.values()) total += v
    if (total <= 1) return 0
    let h = 0
    for (const v of m.values()) {
      const p = v / total
      h -= p * Math.log2(p)
    }
    return h
  }
  return Math.min(entropy(lefts), entropy(rights), 2) / 2
}

// ---- 综合评分 ----

/** 词头字面核心是否全为功能词性（模板取槽位以外的字面段）。 */
export function allFunctionCore(head: string): boolean {
  const lit = head.replace(/<[^>]+>/g, '').replace(/\s+/g, '')
  if (!lit) return false
  const toks = segmentTagged(lit).filter((t) => t.word.trim())
  if (!toks.length) return false
  return toks.every((t) => !isContentTag(t.tag))
}

const scoreMemo = new Map<string, ScoreResult>()

/** 候选综合分（含特征 + flags + keyness + 边界熵）。进程内按 cid+updated_at+flags 记忆。 */
export function scoreCandidate(db: DatabaseSync, cand: Candidate, flags: ScoreFlags = {}): ScoreResult {
  const memoKey = `${cand.cid}|${cand.head}|${cand.channel}|${cand.evidence_usages.length}|${cand.updated_at}|${flags.response_generic ? 1 : 0}${flags.praise_generic ? 1 : 0}${flags.weak_template ? 1 : 0}${flags.all_function_core ? 1 : 0}`
  const cached = scoreMemo.get(memoKey)
  if (cached) return cached
  const features = memeFeatures(cand.evidence_usages, cand.head)
  const keyness = keynessOf(db, cand.head, cand.channel)
  const entropy = boundaryEntropy(cand.evidence_usages, cand.head)
  const effFlags: ScoreFlags = { ...flags }
  if (!effFlags.all_function_core && cand.channel !== 'image') {
    effFlags.all_function_core = allFunctionCore(cand.head)
  }
  const score = composeScore(features, keyness, cand, effFlags)
  const res: ScoreResult = { features, flags: effFlags, score, keyness, boundary_entropy: entropy }
  scoreMemo.set(memoKey, res)
  if (scoreMemo.size > 20000) scoreMemo.clear()
  return res
}

/**
 * 分数合成（手设权重；标定依据 docs/baseline-v0.10.md 与 replay 标定输出，
 * 不做自动训练）：
 * 复读 > 骨架坍缩 > 显著性(keyness/burst，生产时间维) > 独立成评/文本重复。
 * 实测教训（2026-11-22）：dv 广度项与边界熵项曾试验加入——前者把 dv 高的
 * 单字泛用词（哥/找/骂）从 0.04 抬到 1.2 盖过真梗，后者同样利好泛用词
 * （自由边界），双双回退。区分 硬控(dv4) 与 哥(dv16) 的正解是 keyness
 * 与 burst 的时间维（湖回放压缩时间线测不出，生产滚动窗口有效）。
 * 泛回应标记重罚（−3.0，标定无误标，需压过其复读特征分 2.5-4.5）；弱模板/全虚词减分。
 */
export function composeScore(
  f: MemeFeatures, keyness: number | null,
  cand: Candidate, flags: ScoreFlags = {},
): number {
  let s = 2.0 * Math.min(f.copy_pairs, 3)
    + 1.0 * f.skel_top_share
    + 0.5 * f.usage_text_share
    + 0.5 * f.standalone_rate
    + (keyness !== null ? Math.min(keyness / 15, 1) : 0)
    + (cand.z_score !== null ? Math.min(Math.max(cand.z_score, 0) / 2, 1) * 0.5 : 0)
  if (flags.response_generic) s -= 3.0
  if (flags.praise_generic) s -= 2.0
  if (flags.weak_template) s -= 1.0
  if (flags.all_function_core) s -= 0.8
  return s
}

export { PUNCT }
