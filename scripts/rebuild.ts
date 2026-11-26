/**
 * 候选池重建：候选是可从原始湖重建的派生状态（hygienePass 注释的承诺）。
 * 当发现层规则修复后（如容器词守卫），旧规则造成的误删不会自愈——
 * updateSignals 只扫每轮新证据，历史证据不会自动重放。本工具清空派生
 * 状态后按湖内轮次重放，让修复后的规则在全部历史证据上重新裁决。
 *
 * 用法：
 *   npx tsx scripts/rebuild.ts                 # 预览：临时副本上重建，只读
 *   npx tsx scripts/rebuild.ts --apply         # 对真实库（~/.meme/memes.db）就地重建
 *   npx tsx scripts/rebuild.ts --db <path> --apply
 *
 * 保留的运维状态：curation 记录（已收录词条的候选标记重建后按 head+channel
 * 复原）、meme_hit_daily（词条命中日聚合，与候选无关）、
 * kv（generic_auto 封禁表、轮次序号）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { connect } from '../src/db.ts'
import { backupDatabase } from '../src/backup.ts'
import { resolveConfig } from '../src/config.ts'
import { updateSignals } from '../src/detect/signals.ts'
import { transitionCandidates, reapCandidates } from '../src/lifecycle.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(name)
const dbArg = flag('--db') ?? join(process.env.USERPROFILE ?? '~', '.meme', 'memes.db')
const apply = has('--apply')

let target = dbArg
if (!apply) {
  target = join(mkdtempSync(join(tmpdir(), 'meme-rebuild-')), 'rebuild.db')
  // VACUUM INTO 一致性快照：WAL 下手工 copy 主库会丢未合并提交
  backupDatabase(dbArg, target, connect)
  console.log(`[预览模式] 重建在临时副本上进行：${target}`)
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bak = `${dbArg}.bak-pre-rebuild-${stamp}`
  backupDatabase(dbArg, bak, connect)
  console.log(`[就地重建] ${dbArg}（已先做一致性备份：${bak}）`)
}

const db = connect(target)
const raw = db as unknown as DatabaseSync

// 1) 抢救已收录标记（清表后按 head+channel 复原）
type Curation = { head: string; channel: string }
const curated = (raw.prepare(
  "SELECT head, channel FROM candidates WHERE state='inducted' AND reject_reason='inducted'",
).all() as Array<{ head: string; channel: string }>).map(
  (r): Curation => ({ head: r.head, channel: r.channel }),
)
console.log(`curation 复原清单：${curated.length} 条（${curated.map((c) => c.head).join(', ')}）`)

// 2) 清空派生状态（保留原始湖 + meme_hit_daily + kv；轮次台账一并清）
for (const t of ['candidates', 'cand_video', 'phrase_daily', 'skel_daily', 'round_bumps']) {
  raw.exec(`DELETE FROM ${t}`)
}
raw.exec("DELETE FROM kv_meta WHERE key='signals_done_round'")

// 3) 按湖内轮次重放（与 replay.ts 同序：updateSignals → transitionCandidates）
const cfg = resolveConfig()
const rounds = (raw.prepare(
  'SELECT DISTINCT round_id AS rid FROM lake_comments WHERE round_id>0 ORDER BY round_id',
).all() as Array<{ rid: number }>).map((r) => r.rid)
console.log(`重放轮次：${rounds.join(' → ')}`)
let totals = { merged: 0, pruned: 0 }
for (const rid of rounds) {
  const sig = await updateSignals(db, cfg, rid)
  const trans = await transitionCandidates(raw, cfg, rid)
  const reap = reapCandidates(raw, cfg.lifecycle, rid)
  totals.merged += sig.merged
  totals.pruned += sig.pruned_spam
  console.log(
    `  r${rid}: scanned=${sig.scanned} phrase=${sig.phrase_candidates} skel=${sig.skeleton_candidates} `
    + `merged=${sig.merged} pruned=${sig.pruned_spam} triggered=${trans.triggered.length} demoted=${trans.demoted.length} `
    + `reaped=${reap.low_value + reap.dead}`,
  )
}

// 4) 复原已收录标记：重建后按原理由恢复 inducted
const rows = raw.prepare("SELECT cid, head, channel FROM candidates WHERE state IN ('pending','triggered')").all() as Array<{ cid: string; head: string; channel: string }>
let restored = 0
for (const c of curated) {
  const row = rows.find((r) => r.head === c.head && r.channel === c.channel)
  if (!row) continue
  raw.prepare("UPDATE candidates SET state='inducted', reject_reason='inducted' WHERE cid=?").run(row.cid)
  restored++
}
console.log(`curation 复原：${restored}/${curated.length} 条已恢复 inducted`)

// 5) 汇总
const states = raw.prepare('SELECT state, COUNT(*) c FROM candidates GROUP BY state').all() as Array<{ state: string; c: number }>
console.log('池状态：', states.map((s) => `${s.state}=${s.c}`).join('  '))
const trig = raw.prepare("SELECT head, distinct_videos dv FROM candidates WHERE state='triggered'").all() as Array<{ head: string; dv: number }>
console.log('triggered：', trig.map((t) => `${t.head}(dv=${t.dv})`).join('  ') || '（无）')
const probe = ['感觉不如', '难绷', '抽象', '硬控', '韩立', 'BLG', 'GTA6', '笑死', '死我了', '刷到']
for (const kw of probe) {
  const rows = raw.prepare(
    'SELECT head, state, channel, distinct_videos dv FROM candidates WHERE head LIKE ?',
  ).all(`%${kw}%`) as Array<{ head: string; state: string; channel: string; dv: number }>
  if (rows.length) {
    for (const r of rows.slice(0, 4)) console.log(`  [${kw}] ${r.head}  ${r.state}/${r.channel}  dv=${r.dv}`)
  } else {
    console.log(`  [${kw}] 无任何候选行`)
  }
}
if (!apply) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(target + suffix, { force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* Windows 句柄延迟，留给系统清理 */ }
  }
  console.log('预览完成（真实库未动）')
} else {
  console.log('完成（真实库已重建）')
}
db.close()
