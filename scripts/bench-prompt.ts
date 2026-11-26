/**
 * 候选判定 benchmark 的 prompt 生成器（评估专用，不进入运行时）。
 *
 * prompt.md 是生成物，不要手改：§0/§1 在本脚本内，§2 引 src/index.ts 的 MANUAL，
 * §3 引 docs/meme-judgment-guide.md，§4 由 cases.jsonl 渲染。
 * 这消除了"手册/指南/prompt 三份手工同步"的漂移面。
 *
 * 泄题红线：§0–§3 的示例不得出现金标里的梗（labels.jsonl 的 family/canonical
 * 形式）；tests/test-benchmark.test.ts 有精确词泄漏扫描兜底。
 *
 * 用法：
 *   npx tsx scripts/bench-prompt.ts --dataset benchmarks/candidate-judgment-v4
 *   npx tsx scripts/bench-prompt.ts --check   # 只比对渲染结果与现有文件的差异，不写盘
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_DATASET = join(ROOT, 'benchmarks', 'candidate-judgment-v4')
const GUIDE_PATH = join(ROOT, 'docs', 'meme-judgment-guide.md')

interface CaseEvidence {
  evidence_id: string
  text: string
  is_reply: boolean
}
interface BenchCase {
  case_id: string
  source_cid: string
  head: string
  kind_guess: string
  channel: string
  state: string
  videos: number
  ups: number
  burst: number | null
  surfs_seen: number
  sources: Array<{ aid: number; title: string; up_name: string | null }>
  evidence: CaseEvidence[]
}

const { MANUAL } = await import('../src/index.ts')

/** §0/§1：任务说明与输出契约（与模型可见面直接相关，改前先想清楚是否要换 prompt 版本）。 */
function instructionSections(caseCount: number): string {
  return `# 任务上下文：当前上下文下的 ${caseCount} 条候选判定

## 0. 你的角色与任务

你是一个「梗百科」工具的操作 agent。工具负责从 B站评论区采集语料，用统计方法找出疑似正在流行的梗。
现在有 ${caseCount} 条已过统计触发门的候选。请逐条判断，并对每条给出严格 JSON 输出。

判定要分两层：
1. **候选词头本身**是否足以立为梗（verdict）；
2. 这些证据属于哪个**家族**、完整形是什么（family_id / canonical_head）。

注意：
- 统计门不是语义判决；话题词、普通词、泛夸词也可能过门。
- 截断头本身可以不是梗，但证据仍可能属于某个完整梗。例如"软脚"不是独立词头，但完整形"我软脚了"可以是梗。
- 不确定时用 abstain，不要硬猜。
- 不要读取 labels.jsonl、manifest.json 或任何金标文件；只允许使用本文件中的材料。
- 不要修改仓库或数据库，不要执行 meme CLI，只写输出文件。

## 1. 输出契约

最终写一个 JSONL 文件，恰好 ${caseCount} 行，每行对应一个 case_id：

\`\`\`json
{
  "case_id": "example-001",
  "source_cid": "c_example",
  "head": "示例词",
  "verdict": "meme",
  "family_id": "example-family",
  "canonical_head": "示例完整形",
  "confidence": "high",
  "rationale": "示例理由：说明判断依据",
  "evidence_ids": ["example-001:e1"]
}
\`\`\`

- verdict: meme | not-meme | conditional | abstain
- family_id / canonical_head: 字符串或 null
- confidence: high | medium | low | null
- evidence_ids: 只能引用本文件该案例中出现的 evidence_id
- rationale: 一句话理由
- family_id 用稳定的英文/拼音短标识；同一家族必须使用相同 family_id。
`
}

/** §4：逐案例渲染（与人工产出的历史格式逐字节兼容，--check 可验证）。 */
export function renderCases(cases: BenchCase[]): string {
  const blocks = cases.map((c) => {
    const lines = [
      `### ${c.case_id}（${c.source_cid}）`,
      `词头：${c.head}`,
      `通道：${c.channel}｜类别预判：${c.kind_guess}｜状态：${c.state}`,
      `传播：${c.videos} 视频 / ${c.ups} up｜burst=${c.burst === null ? '新' : c.burst}｜跨 ${c.surfs_seen} 轮存活`,
      '来源视频：',
      ...c.sources.slice(0, 5).map((s) => `  - av${s.aid} 《${s.title}》 up:${s.up_name ?? '未知'}`),
      '用例样本：',
      ...c.evidence.map((e) => `  - [${e.evidence_id}] ${e.text}${e.is_reply ? '（楼中楼）' : ''}`),
    ]
    return lines.join('\n')
  })
  return `## 4. ${cases.length} 条模型可见案例\n\n` + blocks.join('\n\n') + '\n'
}

export function renderPrompt(cases: BenchCase[], guide: string, manual: string): string {
  return instructionSections(cases.length)
    + `## 2. 当前部署的技能手册（原文）\n\n${manual.trimEnd()}\n\n`
    + `## 3. 当前判定指南（原文）\n\n${guide.trimEnd()}\n\n`
    + renderCases(cases)
}

function main(): void {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const datasetDir = resolve(flag('--dataset') ?? DEFAULT_DATASET)
  const check = args.includes('--check')
  const cases = readFileSync(join(datasetDir, 'cases.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as BenchCase)
  const guide = readFileSync(GUIDE_PATH, 'utf8')
  const prompt = renderPrompt(cases, guide, MANUAL)

  const promptPath = join(datasetDir, 'prompt.md')
  if (check) {
    const current = readFileSync(promptPath, 'utf8')
    const norm = (s: string): string => s.replace(/\r\n/g, '\n')
    if (norm(current) === norm(prompt)) {
      console.log('check：现有 prompt.md 与渲染结果一致')
      return
    }
    // 分节报告差异：§4 是案例呈现（应逐字节稳定），§0–§3 是说明面（预期随手册演进）
    const curS4 = norm(current).slice(norm(current).indexOf('\n## 4. ') + 1)
    const newS4 = norm(prompt).slice(norm(prompt).indexOf('\n## 4. ') + 1)
    if (curS4 === newS4) {
      console.log('check：§4（案例呈现）逐字节一致；差异仅在 §0–§3 说明面')
    } else {
      const a = newS4.split('\n')
      const b = curS4.split('\n')
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`check：§4 在第 ${i + 1} 行不一致`)
          console.log('渲染：', JSON.stringify(a[i]?.slice(0, 120)))
          console.log('现有：', JSON.stringify(b[i]?.slice(0, 120)))
          process.exitCode = 1
          return
        }
      }
    }
    const cur = norm(current).split('\n')
    const next = norm(prompt).split('\n')
    let diffAt = -1
    for (let i = 0; i < Math.max(cur.length, next.length); i++) {
      if (cur[i] !== next[i]) { diffAt = i; break }
    }
    console.log(`check：全文有差异（第 ${diffAt + 1} 行起；§0–§3 说明面或分节标题变化）`)
    process.exitCode = 1
    return
  }

  writeFileSync(promptPath, prompt.replace(/\r\n/g, '\n'))
  // manifest 只更新 prompt.md 哈希；cases/labels 未动则哈希不变
  const manifestPath = join(datasetDir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    hashes: Record<string, string>
    prompt_revision?: string
    notes: string[]
  }
  manifest.hashes['prompt.md'] = createHash('sha256').update(prompt).digest('hex')
  manifest.prompt_revision = '2026-11-26-sanitized：§0–§3 去除与金标同源的示例（爆/神了/没绷住家族等），修复盲评泄题'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`prompt.md 已重新生成（${cases.length} 案例）；manifest 哈希已更新`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
