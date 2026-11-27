/** curator-v1 run 管理：
 *
 *   init   建空库（71 行种子候选）+ 生成 run 专属 wrapper + agent 任务书
 *   judge  冻结库快照，逐条隐藏查询跑 lookup → lookups.jsonl，写 meta.json
 *   verify 同库快照重跑 judge，与现有 lookups.jsonl 逐字节比对（可复现性自检）
 *
 * judge 只读 run 库（VACUUM INTO 快照），不触碰 agents 建库时用的 db/。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from '../src/db.ts'
import { lookup } from '../src/match/pipeline.ts'
import {
  BENCH_ROOT, QUERIES_FILE, SEED_FILE, RUNS_DIR, AGENT_PROMPT_FILE, readJsonl, sha256File, buildAttribution, parseTranscriptLinks, loadGold, jsonl,
} from './curator-lib.ts'
import { seedRunDb } from './curator-seed.ts'

process.env.MEME_EMBED_OFF = '1'

const WRAPPER_FILES = ['meme.mjs', 'fetch-block.cjs', 'meme', 'meme.cmd', 'meme.ps1']
const BUDGET = { commands: 200, minutes: 20 }

interface Query {
  query_id: string
  channel: string
  text: string
  ctx: string[] | null
  expect: { hit: boolean; family: string | null }
  from_candidate: string | null
  tags: string[]
}

const runDir = (id: string) => `${RUNS_DIR}/${id}`

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[key] = argv[++i]
      else flags[key] = true
    }
  }
  return flags
}

function cmdInit(argv: string[]): void {
  const flags = parseFlags(argv)
  const id = String(flags['run-id'] ?? '')
  if (!id) throw new Error('init 需要 --run-id')
  const dir = runDir(id)
  if (existsSync(dir) && !flags['force']) throw new Error(`${dir} 已存在（--force 覆盖）`)
  if (flags['force']) rmSync(dir, { recursive: true, force: true })
  if (!existsSync(QUERIES_FILE)) throw new Error(`缺少 ${QUERIES_FILE}（先完成出题与合并）`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(`${dir}/wrapper`, { recursive: true })

  const dbAbs = resolve(`${dir}/db/memes.db`)
  const n = seedRunDb(dbAbs)
  console.log(`run ${id}：已建库并写入 ${n} 条候选 → db/memes.db`)

  for (const f of WRAPPER_FILES) copyFileSync(`${BENCH_ROOT}/wrapper/${f}`, `${dir}/wrapper/${f}`)
  writeFileSync(`${dir}/wrapper/wrapper-config.json`, JSON.stringify({
    db: dbAbs,
    cli: resolve('lib/cli.js'),
    transcript: resolve(`${dir}/transcript.jsonl`),
    budget_commands: BUDGET.commands,
    budget_minutes: BUDGET.minutes,
  }, null, 2))
  copyFileSync(SEED_FILE, `${dir}/candidates.jsonl`)
  if (existsSync(AGENT_PROMPT_FILE)) copyFileSync(AGENT_PROMPT_FILE, `${dir}/brief.md`)

  writeFileSync(`${dir}/meta.json`, JSON.stringify({
    run_id: id,
    model: flags['model'] ? String(flags['model']) : null,
    prompt_version: `agent-prompt.md@${new Date().toISOString().slice(0, 10)}`,
    status: 'open',
    created_at: new Date().toISOString(),
    budget: BUDGET,
    notes: flags['notes'] ? String(flags['notes']) : null,
    dataset: { queries_sha256: sha256File(QUERIES_FILE), seed_sha256: sha256File(SEED_FILE) },
  }, null, 2) + '\n')
  console.log(`wrapper/candidates.jsonl/brief.md/meta.json 就绪。答题 agent 工作目录：${resolve(dir)}`)
}

interface LookupRow {
  query_id: string
  hit: boolean
  hits: Array<{ meme_id: string; name: string; tier: number; confidence: number; method: string; family: string | null; attribution: string; via: string | null }>
}

async function doJudge(id: string): Promise<{ rows: LookupRow[]; outFile: string }> {
  const dir = runDir(id)
  const dbPath = `${dir}/db/memes.db`
  if (!existsSync(dbPath)) throw new Error(`${dbPath} 不存在`)
  if (!existsSync(QUERIES_FILE)) throw new Error(`缺少 ${QUERIES_FILE}`)
  const queries = readJsonl<Query>(QUERIES_FILE)

  // 冻结快照：VACUUM INTO 会把 WAL 一并压实，judge 在快照上跑
  const snap = join(tmpdir(), `curator-judge-${id}-${Date.now()}.db`)
  rmSync(snap, { force: true })
  const raw = connect(dbPath)
  raw.exec(`VACUUM INTO '${snap.replace(/\\/g, '/')}'`)
  raw.close()

  const db = connect(snap)
  const gold = loadGold()
  const attr = buildAttribution(db, gold, parseTranscriptLinks(`${dir}/transcript.jsonl`))
  const rows: LookupRow[] = []
  for (const q of queries) {
    // 与 CLI 同语义：ctxLines = [...ctx, text]（交互梗匹配对象是末行，见 commands.ts runLookup）
    const hits = await lookup(db, q.text, [...(q.ctx ?? []), q.text])
    const byMeme = new Map<string, typeof hits[number]>()
    for (const h of hits) if (!byMeme.has(h.meme_id)) byMeme.set(h.meme_id, h)
    const out: LookupRow['hits'] = []
    for (const h of byMeme.values()) {
      const a = attr.byMeme.get(h.meme_id) ?? { kind: 'none' as const }
      out.push({
        meme_id: h.meme_id,
        name: h.name,
        tier: h.tier,
        confidence: h.confidence,
        method: h.method,
        family: a.kind === 'family' ? a.family : null,
        attribution: a.kind,
        via: a.kind === 'family' ? a.via : null,
      })
    }
    rows.push({ query_id: q.query_id, hit: out.length > 0, hits: out })
  }
  db.close()
  rmSync(snap, { force: true })
  const outFile = `${dir}/lookups.jsonl`
  jsonl(outFile, rows)
  return { rows, outFile }
}

async function cmdJudge(argv: string[]): Promise<void> {
  const flags = parseFlags(argv)
  const id = String(flags['run-id'] ?? '')
  if (!id) throw new Error('judge 需要 --run-id')
  const reason = String(flags['finish-reason'] ?? 'unknown')
  const model = flags['model'] ? String(flags['model']) : null
  const dir = runDir(id)
  const { rows, outFile } = await doJudge(id)

  // transcript 统计 + meta 终结
  let commands = 0
  let invalid = 0
  let startedAt: string | null = null
  const transcriptFile = `${dir}/transcript.jsonl`
  if (existsSync(transcriptFile)) {
    for (const line of readFileSync(transcriptFile, 'utf8').split('\n').filter((l) => l.trim())) {
      const e = JSON.parse(line) as { ts: string; invalid?: string }
      commands++
      if (e.invalid) invalid++
      if (!startedAt) startedAt = e.ts
    }
  }
  const elapsedMinutes = startedAt
    ? (Date.now() - new Date(startedAt).getTime()) / 60000
    : 0
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) as Record<string, unknown>
  const next = {
    ...meta,
    model: model ?? meta.model,
    status: 'judged',
    finish_reason: reason,
    judged_at: new Date().toISOString(),
    commands: { total: commands, invalid },
    elapsed_minutes: Math.round(elapsedMinutes * 10) / 10,
    lookups: { count: rows.length, sha256: sha256File(outFile) },
  }
  writeFileSync(`${dir}/meta.json`, JSON.stringify(next, null, 2) + '\n')
  const hitCount = rows.filter((r) => r.hit).length
  console.log(`judge 完成：${rows.length} 条查询（hit ${hitCount} / miss ${rows.length - hitCount}）→ ${outFile}`)
}

async function cmdVerify(id: string): Promise<boolean> {
  const dir = runDir(id)
  const existing = `${dir}/lookups.jsonl`
  if (!existsSync(existing)) throw new Error(`${existing} 不存在（先 judge）`)
  const before = readFileSync(existing, 'utf8')
  // 临时输出：重跑并比对
  const bak = `${existing}.verify-bak`
  copyFileSync(existing, bak)
  try {
    await doJudge(id)
    const after = readFileSync(existing, 'utf8')
    if (before === after) {
      console.log('verify 通过：同库快照重跑逐字节一致')
      return true
    } else {
      const a = before.split('\n')
      const b = after.split('\n')
      const diffAt = a.findIndex((v, i) => v !== b[i])
      console.error(`verify 失败：第 ${diffAt + 1} 行不一致\n  旧: ${a[diffAt]?.slice(0, 300)}\n  新: ${b[diffAt]?.slice(0, 300)}`)
      return false
    }
  } finally {
    copyFileSync(bak, existing)
    rmSync(bak, { force: true })
  }
}

async function main(): Promise<number> {
  const [cmd, ...argv] = process.argv.slice(2)
  if (cmd === 'init') {
    cmdInit(argv)
    return 0
  }
  if (cmd === 'judge') {
    await cmdJudge(argv)
    return 0
  }
  if (cmd === 'verify') {
    const ok = await cmdVerify(String(parseFlags(argv)['run-id'] ?? ''))
    return ok ? 0 : 1
  }
  console.error('用法: npx tsx scripts/curator-run.ts init|judge|verify --run-id <id> [flags]')
  return 2
}

main().then((code) => { process.exitCode = code }).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
