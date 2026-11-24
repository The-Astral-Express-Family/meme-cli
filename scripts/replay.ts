/**
 * 重放工具：用真实湖数据按轮重放信号管线，量化发现质量。
 *
 * 用法：npx tsx scripts/replay.ts [--top 40] [--db <path>] [--rounds 6]
 *
 * 指标：
 * - 每轮入榜候选数/触发数/耗时；
 * - 真梗标注集（TRUTH = 操作员 2026-11-22 人工判定的真梗完整标准形，
 *   集内 42 条见下方 TRUTH 常量）的入榜召回，按三档评级：
 *   ✓ 完整形在池 ｜ ◐ 只有截断/部分形 ｜ ✗ 未发现——直接量化"提取不完整"；
 * - 负例集（操作员判定的专名/泛回应/泛用词/假模板/事件句）的入榜与 top-N 侵入数；
 * - 榜单 top N（人工目检）。
 *
 * 标注集只存在于本文件（评估标定用途），绝不参与运行时检测/打分/触发。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { connect } from '../src/db.ts'
import { resolveConfig } from '../src/config.ts'
import { updateSignals } from '../src/detect/signals.ts'
import { scoreCandidate } from '../src/detect/evidence.ts'
import { semanticFlags } from '../src/detect/semantics.ts'
import { transitionCandidates, reapCandidates } from '../src/lifecycle.ts'
import { allActive } from '../src/candidates.ts'
import type { Candidate } from '../src/models.ts'

/**
 * 真梗标注集 v5：操作员 2026-11-22 两轮人工判定——首轮 17 条（上午）+
 * round 12-14 池审查确认的 ~24 条（下午），标准形以操作员改述为准；
 * 2026-11-24 追加 24 条队列中此前无记录项的判定（牢师、来股市条件真梗）。
 * full = 完整标准形的匹配规则（命中即 ✓）；partial = 截断/部分形（只命中它则 ◐）。
 * 规则函数：head 为候选词头（小写化后），template=true 表示模板通道候选。
 */
interface TruthItem {
  std: string
  full: (h: string, template: boolean) => boolean
  partial?: (h: string, template: boolean) => boolean
  note?: string
}

const has = (needle: string) => (h: string) => h.includes(needle)
const is = (w: string) => (h: string) => h === w
const anyOf = (...ws: string[]) => (h: string) => ws.some((w) => h === w || h.includes(w))
const tplWith = (lit: string) => (h: string, t: boolean) => t && h.includes(lit) && h.includes('<')

const TRUTH: TruthItem[] = [
  // ---- 首轮判定（2026-11-22 上午，17 条）----
  { std: '硬控', full: has('硬控') },
  { std: '绷家族', full: anyOf('没绷住', '绷不住', '绷住了', '破绷', '炸绷', '难绷', '这谁绷得住', '绷了'), partial: (h) => h === '绷' || h === '绷住', note: '<X>绷 有负面动词限制（破/炸/难），家族归并不独立立梗' },
  { std: '笑死', full: anyOf('笑死我了', '笑死了', '笑死'), },
  { std: '请输入文本', full: has('请输入文本'), partial: has('请输入') },
  { std: 'XX你做人真的可以', full: has('做人真的可以'), partial: (h, t) => !t && h.includes('做人'), note: '✓ 含槽位模板或完整句式；◐ 仅词头截断' },
  { std: '上号', full: has('上号') },
  { std: 'steam管家', full: has('steam管家'), partial: (h) => h === 'steam' },
  { std: 'x环', full: has('x环'), partial: (h) => h === '异环', note: '称呼"x环"本身是梗；游戏名异环只是宿主（◐）' },
  { std: '美美', full: has('美美') },
  { std: '纷争开始了', full: has('纷争开始了'), partial: (h) => h === '纷争' },
  { std: '一股X（味）', full: (h, t) => (t && h.includes('一股') && h.includes('<')) || h.includes('一股味') || h.includes('一股ai'), partial: (h) => h === '一股' },
  { std: '爆了', full: (h) => h === '爆了', partial: (h) => h === '爆', note: '词头"爆"混入抽爆/自爆等非梗用法，只算 ◐' },
  { std: '感觉不如', full: has('感觉不如') },
  { std: 'gta6', full: has('gta6'), note: '谨慎采纳：偏事件性' },
  { std: 'XX启动', full: tplWith('启动'), partial: (h, t) => !t && h === '启动' },
  { std: '刷到极品了', full: has('刷到极品了'), partial: has('刷到') },
  { std: '急', full: () => false, note: '湖内无证据（0 条评论），本轮不可评估，不计入召回分母' },
  // ---- 第二轮判定（2026-11-22 下午，round 12-14 池审查）----
  { std: '神了（形容词用法）', full: has('神了'), note: '神系是梗但需主控判定：仅形容词用法（哭笑不得式赞叹）；单字"神"不计；旧词回潮不自动放行' },
  { std: '生死不明，那就是死了', full: (h, t) => h === '死了' || (t && h.includes('死了')), note: '操作员给定标准形为整句引文；死了/<X>死了 两候选证据皆归此梗' },
  { std: '家人们', full: has('家人们'), partial: (h) => h === '家', note: '◐ 单字"家"混入泛用语境' },
  { std: '鲸鲸', full: has('鲸鲸') },
  { std: 'nb', full: is('nb'), note: '牛逼缩写' },
  { std: '你只是怕了（交互）', full: has('你只是怕了'), partial: (h, t) => (t && h.includes('怕了')) || h === '我怕了' || h === '我真怕了', note: '交互梗：根本没有这样的<X>→你只是怕了' },
  { std: '这里不送<X>', full: tplWith('这里不送'), note: '交互梗（猛夸A→回复不送B），配对不可自动化，操作员注明可不管' },
  { std: 'AABB<X>冠军', full: () => false, partial: tplWith('冠军'), note: 'AA/BB=两人组叠词称呼，前缀槽未成（◐）；<X>冠军只算部分形' },
  { std: '我觉得真正的<X>就不会<Y>', full: tplWith('真正的') },
  { std: '学了三天<X>做出来的<Y>', full: (h, t) => t && h.includes('做出来的') && (h.includes('学了') || h.includes('三天')) },
  { std: '我活到头了', full: has('活到头'), note: '非公式梗' },
  { std: '洗眼睛', full: has('洗眼睛'), partial: (h, t) => t && h.includes('眼睛'), note: '证据在模板用例中，词头未立户' },
  { std: '豆姐', full: has('豆姐') },
  { std: 'This is the true music', full: (h) => h.includes('true music') || h.includes('this is the true'), partial: has('true') },
  { std: '哈气', full: has('哈气'), note: '=生气；"夸夸"候选的证据句里才是真梗单元' },
  { std: '不飞<X>', full: tplWith('不飞'), partial: (h) => h === '不飞', note: '交互梗：A评论夸up主，追评发"不飞<A的IP地>"' },
  { std: 'up主觉得很赞', full: has('觉得很赞'), partial: (h) => h === '主觉得' },
  { std: '依旧i<X>', full: has('依旧i') },
  { std: '可爱喵', full: has('可爱喵') },
  { std: '老霸道了', full: has('老霸道了') },
  { std: '太变态了', full: has('太变态了') },
  { std: '诗人', full: is('诗人'), note: '"是人"错写' },
  { std: '站中间串两边', full: (h) => h.includes('站中间') || h.includes('串两边') },
  { std: '别人<A>我<B>就很', full: (h, t) => t && h.includes('就很') && h.includes('<'), partial: (h) => h === '别人看', note: '可能简化成独立"就很"' },
  // ---- 第三轮判定（2026-11-24，triggered 24 队列补标）----
  { std: '牢师', full: has('牢师'), note: '五条悟的圈内诨名；"牢X"前缀梗的实例，操作员确认' },
  { std: '来股市（来古士谐音）', full: (h) => h === '来股市' || h === '浪漫股市', note: '条件真梗：仅"来古士"谐音语境成立；普通股市讨论不算，词头"股市"不立户' },
]

/**
 * 负例集：操作员判定不是梗的词头/模板（首轮错误识别案例 + 第二轮池审查未确认项 +
 * 2026-11-24 triggered 24 队列补标）。专名/话题词、泛回应词、泛用词、假模板、
 * 事件性整句。词头**精确**匹配（v5：截断家族归 TRUTH 的 partial，不进负例，
 * 避免与真梗子串互撞；"死我了"是操作员明确判非梗的日常程度补语，例外入负例）。
 */
const NEGATIVE_HEADS = [
  // 专名/话题（提及量 ≠ 梗）
  '韩立', 'blg', '饭堂', '驾考宝典', '作业帮', '异环', '元中',
  // 应用名切片（复读通道会拆出）
  '作业', '驾考', '宝典',
  // 泛回应/客套
  '是的', '来啦', '来吧', '哦哦哦', '好快', '耶',
  // 泛用词/泛夸（第二轮审查未确认为梗的高频词）
  '精彩', '小时', '回来', '骂的', '更新了', '惊喜', '貌似',
  '可爱', '好看', '天才', '牛', '神', '摸摸', '上班', '两把', '供', '活动', '图片',
  // triggered 24 队列补标（2026-11-24）：操作员判定非梗
  '死我了', '泡', '老师说', '一手', '绮', '家伙', '股市', '参与', '赢', '艺术', '你太',
  // 事件性整句复读
  '就不能找个客厅沙发', '鳄鱼伯涛',
]
const NEGATIVE_TEMPLATES = ['<x>分钟', '<x>行了', '<x>场啊', '<x>特效', '<x>我了', '<x>文本', '<x>新了', '<x>不错', '<x>大了', '<x>牛逼']

const args = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const top = Number(flag('--top', '30'))
const dbArg = flag('--db', join(process.env.USERPROFILE ?? '~', '.meme', 'memes.db'))
const roundsArg = Number(flag('--rounds', '99')) // 全量湖轮次（基准固定：真网轮次会污染过期动态）

const tmp = join(mkdtempSync(join(tmpdir(), 'meme-replay-')), 'replay.db')
copyFileSync(dbArg, tmp)

// 清空派生状态：候选/日聚合/序列，只留原始湖
const raw = new DatabaseSync(tmp)
for (const t of ['candidates', 'cand_video', 'phrase_daily', 'skel_daily', 'meme_hit_daily']) {
  raw.exec(`DELETE FROM ${t}`)
}
raw.exec("DELETE FROM kv_meta WHERE key LIKE 'seq_%'")
raw.close()

const cfg = resolveConfig()
const db = connect(tmp)
const rounds = (db.prepare(
  'SELECT DISTINCT round_id AS rid FROM lake_comments WHERE round_id>0 ORDER BY round_id',
).all() as Array<{ rid: number }>).map((r) => r.rid).slice(0, roundsArg)

let totalCreated = 0
let totalDemoted = 0
for (const rid of rounds) {
  const t0 = Date.now()
  const sig = await updateSignals(db, cfg, rid)
  const trans = await transitionCandidates(db, cfg, rid)
  const reap = reapCandidates(db, cfg.lifecycle, rid)
  totalCreated += sig.phrase_candidates + sig.skeleton_candidates + sig.copy_candidates
  totalDemoted += trans.demoted.length
  console.log(
    `round ${rid} (${Date.now() - t0}ms): scanned=${sig.scanned} phrase=${sig.phrase_candidates} `
    + `copy=${sig.copy_candidates} skel=${sig.skeleton_candidates} img=${sig.image_candidates} `
    + `merged=${sig.merged} pruned=${sig.pruned_spam} `
    + `triggered=${trans.triggered.length} demoted=${trans.demoted.length} reaped=${reap.low_value + reap.dead}`,
  )
}

const cands = allActive(db).filter((c) => c.state === 'pending' || c.state === 'triggered')
// 两阶段评分：先无语义标记的基础分排序，取前 400 算语义标记（嵌入调用有成本），
// 再用带标记的 score v2 重排——与 surf 呈现层（enrichFlags top 40）同构
const base = cands.map((c) => ({ c, base: scoreCandidate(db, c).score }))
  .sort((a, b) => b.base - a.base || b.c.distinct_videos - a.c.distinct_videos || (a.c.cid < b.c.cid ? -1 : 1))
const flagMap = new Map<string, import('../src/detect/evidence.ts').ScoreFlags>()
for (const s of base.slice(0, 400)) {
  flagMap.set(s.c.cid, await semanticFlags(db, cfg, s.c))
}
const scored = base.map((s) => ({ c: s.c, score: scoreCandidate(db, s.c, flagMap.get(s.c.cid) ?? {}).score }))
  .sort((a, b) => b.score - a.score || b.c.distinct_videos - a.c.distinct_videos || (a.c.cid < b.c.cid ? -1 : 1))
console.log(`\n总入榜候选 ${totalCreated}，当前队列 ${cands.length}，累计降级 ${totalDemoted}`)

console.log(`\n=== 榜单 top ${top}（score v2 排序）===`)
for (const { c, score } of scored.slice(0, top)) {
  const z = c.z_score !== null ? c.z_score.toFixed(1) : '-'
  console.log(
    `  ${c.cid} [${c.state.padEnd(9)}] [${c.channel.padEnd(8)}] dv=${String(c.distinct_videos).padStart(3)} `
    + `z=${z.padStart(6)} score=${score.toFixed(2).padStart(5)}  "${c.head.slice(0, 40)}"`,
  )
}

// ---- 真梗召回（三档评级）----
console.log('\n=== 真梗标注集召回（TRUTH v5，2026-11-22/24 操作员判定）===')
const lower = (h: string) => h.toLowerCase()
const isTemplate = (c: Candidate) => c.channel === 'skeleton' && c.head.includes('<')
const active = scored.map((s) => s.c)

function grade(t: TruthItem): '✓' | '◐' | '✗' {
  if (active.some((c) => t.full(lower(c.head), isTemplate(c)))) return '✓'
  if (t.partial && active.some((c) => t.partial!(lower(c.head), isTemplate(c)))) return '◐'
  return '✗'
}
const gradeOf = new Map<string, string>()
for (const t of TRUTH) {
  // 湖内无证据的条目（如"急"）标 '-' 跳过，不计入召回分母
  const g = t.note?.startsWith('湖内无证据') ? '-' : grade(t)
  gradeOf.set(t.std, g)
  const hitHead = active.find((c) => t.full(lower(c.head), isTemplate(c)))
  const partialHead = !hitHead && t.partial ? active.find((c) => t.partial!(lower(c.head), isTemplate(c))) : undefined
  const detail = hitHead ? hitHead.head : partialHead ? `仅截断: ${partialHead.head}` : ''
  console.log(`  ${g} ${t.std.padEnd(14)} ${detail.slice(0, 44)}${t.note ? '  ⟨' + t.note + '⟩' : ''}`)
}
const evaluable = TRUTH.filter((t) => gradeOf.get(t.std) !== '-')
const nFull = evaluable.filter((t) => gradeOf.get(t.std) === '✓').length
const nPartial = evaluable.filter((t) => gradeOf.get(t.std) === '◐').length
console.log(`\n完整形召回 ${nFull}/${evaluable.length}，另有截断形 ${nPartial}（◐）；未发现 ${evaluable.length - nFull - nPartial}`)

// ---- 负例侵入 ----
console.log('\n=== 负例侵入（操作员判定非梗）===')
const rankOf = new Map<string, number>()
scored.forEach((s, i) => rankOf.set(s.c.cid, i + 1))
let nInPool = 0
let nTop = 0
const negRows: Array<{ head: string; where: string; rank: number }> = []
for (const w of NEGATIVE_HEADS) {
  const hit = active.find((c) => lower(c.head) === w) // 精确匹配：真梗的子串家族归 TRUTH partial，不在此计侵入
  if (!hit) continue
  nInPool++
  const rank = rankOf.get(hit.cid) ?? 999
  if (rank <= top) nTop++
  negRows.push({ head: hit.head, where: `#${rank}`, rank })
}
for (const w of NEGATIVE_TEMPLATES) {
  const hit = active.find((c) => isTemplate(c) && lower(c.head).replace(/ /g, '') === w)
  if (!hit) continue
  nInPool++
  const rank = rankOf.get(hit.cid) ?? 999
  if (rank <= top) nTop++
  negRows.push({ head: hit.head, where: `#${rank}`, rank })
}
for (const r of negRows.sort((a, b) => a.rank - b.rank)) {
  console.log(`  池内 #${String(r.rank).padStart(4)}  "${r.head.slice(0, 36)}"`)
}
console.log(`\n负例入池 ${nInPool}，其中 top ${top} 侵入 ${nTop}`)

db.close()
rmSync(join(tmp, '..'), { recursive: true, force: true })
