/**
 * OJ lookup benchmark 的系统运行器：把 entries 装进临时库，对每条 case 跑
 * 真实 lookup 管线（①词表 → ②骨架 → ③交互；向量层强制关闭，OJ v1 只评前三层），
 * 产出与模型作答同 schema 的 output.jsonl，交给 scripts/oj-score.ts 评分。
 *
 * 两种用法，评的是不同东西：
 *   --entries <file>  装入外部词条（例如某个模型生成的 entries.jsonl），
 *                     本质是"这套 matcher 好不好用"——同一批用例、同一执行器。
 *   （缺省）          装入数据集自带 fixture 词条，得到系统基线行。
 *
 * 用法：
 *   npx tsx scripts/oj-run.ts                          # 运行 matcher 行（系统基线）
 *   npx tsx scripts/oj-run.ts --run-name matcher-v2    # 自定义输出目录名
 *   npx tsx scripts/oj-run.ts --entries path/entries.jsonl --run-name glm-matcher
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET = join(ROOT, 'benchmarks', 'oj-lookup-v1')

interface EntryRow {
  id: string
  name: string
  family: string
  class: string
  gist: string
  matcher: unknown
}
interface CaseRow {
  id: string
  channel: string
  family: string
  entry_ref: string
  input: { text: string; ctx?: string[] }
  expect: { hit: boolean; family?: string; forbid?: string[] }
  tags: string[]
}

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.trim()).map((line) => JSON.parse(line) as T)

const flagOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const entriesFile = flagOf('--entries')
  ? join(process.cwd(), flagOf('--entries')!)
  : join(DATASET, 'entries.jsonl')
if (!existsSync(entriesFile)) throw new Error(`entries 文件不存在：${entriesFile}`)

const entries = readJsonl<EntryRow>(entriesFile)
const cases = readJsonl<CaseRow>(join(DATASET, 'cases.jsonl'))
const manifest = JSON.parse(readFileSync(join(DATASET, 'manifest.json'), 'utf8')) as { hashes: Record<string, string> }
for (const [file, expected] of Object.entries(manifest.hashes)) {
  const actual = createHash('sha256').update(readFileSync(join(DATASET, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex')
  if (actual !== expected) throw new Error(`manifest 哈希不匹配：${file}`)
}

// 外部词条先做结构预检：缺 family/class/matcher 的条目会让整行静默失分，必须在跑之前报出来
const bad = entries.filter((e) => !e.id || !e.name || !e.family || !e.class || e.matcher === undefined)
if (bad.length) {
  throw new Error(`entries 结构不完整（需 id/name/family/class/matcher）：${bad.slice(0, 3).map((e) => e.id || '(无 id)').join(', ')}（共 ${bad.length} 条）`)
}
const dupIds = entries.map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i)
if (dupIds.length) throw new Error(`entries 含重复 id：${[...new Set(dupIds)].slice(0, 5).join(', ')}`)

// ---- 临时库装载词条（向量层不参与 OJ v1）----
process.env.MEME_EMBED_OFF = '1'
const { connect } = await import('../src/db.ts')
const { save } = await import('../src/entries.ts')
const { lookup } = await import('../src/match/pipeline.ts')

const dir = mkdtempSync(join(tmpdir(), 'oj-run-'))
const db = connect(join(dir, 'oj.db'))
for (const e of entries) {
  const meme = {
    id: e.id,
    name: e.name,
    aliases: [] as string[],
    class: e.class,
    lineage: { parent: null, mutation: null },
    platform: [] as string[],
    state: 'active',
    birth: { circa: null },
    matcher: e.matcher ?? null,
    card: { gist: e.gist, usage: [], taboo: null, register: null, aggression: '低' },
    examples: [] as string[],
    drift: [],
    stats: { wild_freq_30d: 0, peak_freq: 0, last_seen: null, last_matched_round: 0 },
    wild_rounds: [],
    revived_pending: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  save(db, meme as never)
}

// ---- 逐 case 跑 lookup ----
const runName = flagOf('--run-name')
  ?? (flagOf('--entries') ? basename(entriesFile).replace(/\.jsonl?$/i, '') : 'matcher')
const outDir = join(DATASET, 'outputs', runName)
mkdirSync(outDir, { recursive: true })

const rows = []
for (const c of cases) {
  const hits = await lookup(db, c.input.text, c.input.ctx ?? null)
  const firstByMeme = new Map<string, (typeof hits)[number]>()
  for (const h of hits) if (!firstByMeme.has(h.meme_id)) firstByMeme.set(h.meme_id, h)
  rows.push({
    case_id: c.id,
    hit: hits.length > 0,
    families: [...firstByMeme.entries()].map(([mid, h]) => {
      const e = entries.find((x) => x.id === mid)
      return { family: e?.family ?? mid, name: e?.name ?? mid, confidence: h.confidence, method: h.method }
    }),
  })
}
writeFileSync(join(outDir, 'output.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  model: runName, run_order: flagOf('--entries') ? 1 : 0, runner: 'scripts/oj-run.ts',
  entries_file: entriesFile,
  note: flagOf('--entries')
    ? `外部词条（${entries.length} 条）：评这套 matcher 在固定用例上的行为`
    : '系统基线：真实 lookup 管线（词表/骨架/交互，无向量）',
}, null, 2) + '\n')
db.close()
rmSync(dir, { recursive: true, force: true })

// 就地快速对账：给操作员看一眼有没有结构性翻车
let tp = 0, fp = 0, fn = 0, tn = 0
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]
  const r = rows[i]
  const forbid = new Set(c.expect.forbid ?? [])
  const bad = r.families.some((f) => forbid.has(f.family))
  const good = r.families.some((f) => c.expect.hit && f.family === c.expect.family)
  if (c.expect.hit) { if (good && !bad) tp++; else fn++ } else { if (!bad) tn++; else fp++ }
}
console.log(`outputs → ${outDir}`)
console.log(`matcher 行快速对账：TP=${tp} FP=${fp} FN=${fn} TN=${tn}（准确率 ${Math.round(((tp + tn) / cases.length) * 100)}%）`)
