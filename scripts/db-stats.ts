/**
 * 库存监控：表大小 / WAL / freelist / 轮次一屏读完（存储"先监控"的最小实现）。
 *
 * 用法：
 *   npx tsx scripts/db-stats.ts                 # 默认库 ~/.meme/memes.db
 *   npx tsx scripts/db-stats.ts --db <path>
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const dbPath = flag('--db', join(process.env.USERPROFILE ?? homedir(), '.meme', 'memes.db'))

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`

let db: DatabaseSync
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (e) {
  console.error(`无法打开 ${dbPath}：${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

const row = (sql: string, ...params: (string | number)[]): Record<string, unknown> =>
  db.prepare(sql).get(...params) as Record<string, unknown>

// 主库 / WAL / freelist
let walBytes = 0
try { walBytes = statSync(dbPath + '-wal').size } catch { /* 无 WAL */ }
const freelistPages = Number(row('PRAGMA freelist_count').freelist_count ?? 0)
const pageSize = Number(row('PRAGMA page_size').page_size ?? 0)
const pageCount = Number(row('PRAGMA page_count').page_count ?? 0)
const walMode = String(row('PRAGMA journal_mode').journal_mode)
const integrity = String(row('PRAGMA integrity_check').integrity_check)

console.log(`库：${dbPath}`)
console.log(`主文件 ${fmtBytes(statSync(dbPath).size)}｜WAL ${fmtBytes(walBytes)}｜journal=${walMode}｜integrity=${integrity}`)
console.log(`页 ${pageCount}×${pageSize}B，freelist ${freelistPages} 页（${fmtBytes(freelistPages * pageSize)}）——VACUUM 至多回收这么多`)

// 表大小（dbstat 可用时给页占用，缺失时退回行数）
const tables = (db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memes_fts%' ORDER BY name",
).all() as Array<{ name: string }>).map((t) => t.name)
console.log('\n表（行数 / 页占用）:')
const rows: Array<{ name: string; n: number; bytes: number }> = []
for (const t of tables) {
  const n = Number(row(`SELECT COUNT(*) AS c FROM "${t}"`).c)
  let bytes = 0
  try {
    bytes = Number(row('SELECT COALESCE(SUM(pgsize),0) AS s FROM dbstat WHERE name=?', t).s)
  } catch { /* dbstat 未开启 */ }
  rows.push({ name: t, n, bytes })
}
rows.sort((a, b) => b.bytes - a.bytes || b.n - a.n)
for (const r of rows) {
  console.log(`  ${r.name.padEnd(20)} ${String(r.n).padStart(8)} 行  ${r.bytes ? fmtBytes(r.bytes) : '—'}`)
}

// 轮次与留存（只读打开不会触发迁移，status 列可能尚未存在）
const rounds = row('SELECT COUNT(*) AS c, MAX(round_id) AS max FROM surf_runs') as { c: number; max: number }
const hasStatus = (db.prepare('PRAGMA table_info(surf_runs)').all() as Array<{ name: string }>).some((c) => c.name === 'status')
const status = hasStatus
  ? (db.prepare('SELECT status, COUNT(*) AS c FROM surf_runs GROUP BY status').all() as Array<{ status: string; c: number }>)
  : []
const lakeComments = Number(row('SELECT COUNT(*) AS c FROM lake_comments').c)
const lakeOldest = row('SELECT MIN(ctime) AS m FROM lake_comments').m as number | null
console.log(`\nsurf 轮次：${rounds.c} 轮（最新 round=${rounds.max}）｜状态分布 ${status.map((s) => `${s.status}:${s.c}`).join(' ')}`)
console.log(`原始湖：${lakeComments} 条评论${lakeOldest ? `，最早 ${new Date(Number(lakeOldest) * 1000).toISOString().slice(0, 10)}` : ''}`)
const candidatesN = Number(row("SELECT COUNT(*) AS c FROM candidates WHERE state IN ('pending','triggered')").c)
console.log(`候选池（pending/triggered）：${candidatesN}`)
db.close()
void readFileSync
