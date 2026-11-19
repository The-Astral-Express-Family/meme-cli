/**
 * 重放工具：用真实湖数据按轮重放信号管线，量化发现质量。
 *
 * 用法：npx tsx scripts/replay.ts [--top 40] [--db <path>] [--rounds 6]
 *
 * 指标：每轮入榜候选数/触发数、真梗标注集的入榜召回与触发召回、榜首质量（人工目检 top N）。
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { connect } from '../src/db.ts'
import { resolveConfig } from '../src/config.ts'
import { updateSignals } from '../src/detect/signals.ts'
import { memeFeatures, memeScore } from '../src/detect/evidence.ts'
import { transitionCandidates } from '../src/lifecycle.ts'
import { allActive } from '../src/candidates.ts'
import { orderKey } from '../src/surf/present.ts'

/** 真梗标注集 v2：经语料验证（≥2 次 ≥2 视频才算可发现；语料中不存在的已剔除）。 */
const TRUTH = [
  '绷不住', '赢麻', '开香槟', '香槟', '难绷', '乐子', '赚麻', '一眼',
  '启动', '红温', '蚌埠', '米哈游', '警钟长鸣', '我软脚了', '老铁', '润',
  '抽象', '电子', '赢麻了',
  'X麻了', // 公式族（骨架通道应坍缩出含这些字面的形状）
]

const args = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const top = Number(flag('--top', '30'))
const dbArg = flag('--db', join(process.env.USERPROFILE ?? '~', '.meme', 'memes.db'))
const roundsArg = Number(flag('--rounds', '6')) // 只重放前 N 轮（基准固定：真网轮次会污染过期动态）

const tmp = join(mkdtempSync(join(tmpdir(), 'meme-replay-')), 'replay.db')
copyFileSync(dbArg, tmp)

// 清空派生状态：候选/日聚合/序列，只留原始湖
const raw = new DatabaseSync(tmp)
for (const t of ['candidates', 'cand_video', 'phrase_daily', 'skel_daily', 'meme_hit_daily', 'induction_queue']) {
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
for (const rid of rounds) {
  const sig = await updateSignals(db, cfg, rid)
  const trans = transitionCandidates(db, cfg.lifecycle, rid)
  totalCreated += sig.phrase_candidates + sig.skeleton_candidates
  console.log(
    `round ${rid}: scanned=${sig.scanned} phrase=${sig.phrase_candidates} `
    + `skel=${sig.skeleton_candidates} img=${sig.image_candidates} `
    + `triggered=${trans.triggered.length} expired=${trans.expired.length}`,
  )
}

const cands = allActive(db)
  .filter((c) => c.state === 'pending' || c.state === 'triggered')
  .sort((a, b) => {
    const ka = orderKey(a)
    const kb = orderKey(b)
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : 1)
  })
console.log(`\n总入榜候选 ${totalCreated}，当前队列 ${cands.length}`)

console.log(`\n=== 榜单 top ${top}（order_key 排序）===`)
for (const c of cands.slice(0, top)) {
  const f = memeFeatures(c.evidence_usages)
  const z = c.z_score !== null ? c.z_score.toFixed(1) : '-'
  console.log(
    `  ${c.cid} [${c.state.padEnd(9)}] [${c.channel.padEnd(8)}] dv=${String(c.distinct_videos).padStart(3)} du=${String(c.distinct_ups).padStart(3)} `
    + `z=${z.padStart(6)} score=${memeScore(f).toFixed(2).padStart(5)} copy=${f.copy_pairs} `
    + `skel=${f.skel_top_share.toFixed(2)} sa=${f.standalone_rate.toFixed(2)}  "${c.head.slice(0, 36)}"`,
  )
}

console.log('\n=== 真梗标注集召回 ===')
const heads = new Set(cands.map((c) => c.head))
const allHeads = new Set((db.prepare('SELECT head FROM candidates').all() as Array<{ head: string }>).map((r) => r.head))
const triggeredHeads = new Set(cands.filter((c) => c.state === 'triggered').map((c) => c.head))

function found(t: string): string {
  if (t === 'X麻了') { // 公式族：合成候选 head 形如 "<X>麻了"
    const sk = [...allHeads].find((h) => h.includes('麻了') && h.startsWith('<X>'))
    return sk ? `✓ 公式族 ${sk.slice(0, 30)}` : '✗ 公式未合成'
  }
  if (triggeredHeads.has(t)) return '✓✓ 已触发'
  if (heads.has(t)) return '✓ 入榜'
  if (allHeads.has(t)) return '○ 曾入榜（已过期/被拒）'
  if ([...heads].some((h) => h.includes(t))) return '✓ 子串入榜' // 同为子串的 gram 也算（"赢麻" ⊂ "赢麻了"）
  return '✗ 从未入榜'
}

let nHit = 0
for (const t of TRUTH) {
  const r = found(t)
  if (r.startsWith('✓')) nHit++
  console.log(`  ${r.padEnd(24)} ${t}`)
}
console.log(`\n入榜召回 ${nHit}/${TRUTH.length}`)
db.close()
rmSync(join(tmp, '..'), { recursive: true, force: true })
