// curator run 的 meme wrapper：固定库与离线环境、命令白名单、预算、transcript。
// 每个 run 目录里有自己的一份拷贝 + wrapper-config.json（init 时由 curator-run.ts 生成）。
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'wrapper-config.json'), 'utf8'))
const args = process.argv.slice(2)
const ts = new Date().toISOString()

const ALLOWED = ['add', 'iterate', 'edit', 'ban', 'allow', 'note', 'show', 'search', 'check', 'lookup']
const BUDGET_COMMANDS = cfg.budget_commands ?? 200
const BUDGET_MINUTES = cfg.budget_minutes ?? 20
const CAP = 8000

const cap = (s) =>
  s.length <= CAP ? s : s.slice(0, CAP) + `…[truncated ${s.length - CAP} chars]`

// 已用命令数 = transcript 行数（含 invalid）；计时锚点 = 首次调用时刻
let used = 0
if (existsSync(cfg.transcript)) {
  used = readFileSync(cfg.transcript, 'utf8').split('\n').filter(Boolean).length
}
const startFile = join(here, '.start')
if (!existsSync(startFile)) writeFileSync(startFile, ts)
const startedMs = new Date(readFileSync(startFile, 'utf8').trim()).getTime()
const elapsedMin = (Date.now() - startedMs) / 60000

let invalid = null
if (!args.length || !ALLOWED.includes(args[0])) invalid = `command-not-allowed: ${args[0] ?? '(empty)'}（白名单外命令被拒绝）`
else if (used >= BUDGET_COMMANDS) invalid = `budget-exhausted: 已用 ${used} 条命令（上限 ${BUDGET_COMMANDS}）`
else if (elapsedMin > BUDGET_MINUTES) invalid = `budget-exhausted: 已用时 ${elapsedMin.toFixed(1)} 分钟（上限 ${BUDGET_MINUTES}）`

let exit = 0
let stdout = ''
let stderr = ''
if (invalid) {
  exit = 1
  stdout = JSON.stringify({ error: { code: 'MEME_CURATOR_INVALID', message: invalid } })
  stderr = invalid
} else {
  const t0 = Date.now()
  const r = spawnSync(
    process.execPath,
    ['--require', join(here, 'fetch-block.cjs'), cfg.cli, ...args],
    {
      env: { ...process.env, MEME_DB: cfg.db, MEME_EMBED_OFF: '1' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  stdout = r.stdout ?? ''
  stderr = r.stderr ?? ''
  exit = r.status ?? (r.error ? 1 : 0)
  appendFileSync(
    cfg.transcript,
    JSON.stringify({
      seq: used + 1,
      ts,
      argv: args,
      exit_code: exit,
      stdout: cap(stdout),
      stderr: cap(stderr),
      ms: Date.now() - t0,
    }) + '\n',
  )
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  process.exitCode = exit
}
if (invalid) {
  // 拒绝同样入 transcript，记 invalid 标记
  appendFileSync(
    cfg.transcript,
    JSON.stringify({ seq: used + 1, ts, argv: args, exit_code: exit, stdout: cap(stdout), stderr: cap(stderr), ms: 0, invalid }) + '\n',
  )
  process.stdout.write(stdout + '\n')
  process.stderr.write(stderr + '\n')
  process.exitCode = exit
}
