/**
 * OJ lookup 模型作答 prompt 生成器（评估专用）。
 *
 * 从 entries.jsonl + cases.jsonl 生成不含期望（expect）的判题 prompt：
 * 模型拿到词条定义与输入文本（含会话上下文），对每条输入判断是否命中、命中哪个家族。
 * 输出按 chunk 切分（--chunks N），每个 chunk 一个 prompt 文件，便于小窗口模型作答。
 *
 * 用法：
 *   npx tsx scripts/oj-judge-prompt.ts                # 单文件 judge-prompt.md
 *   npx tsx scripts/oj-judge-prompt.ts --chunks 4     # judge-prompt/chunk-1..4.md
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET = join(ROOT, 'benchmarks', 'oj-lookup-v1')

interface EntryRow {
  id: string
  name: string
  family: string
  class: string
  gist: string
  matcher: {
    patterns: Array<{ kind: string; terms?: string[]; tokens?: string[]; trigger_terms?: string[]; response_terms?: string[] }>
    constraints?: Record<string, unknown>
  }
}
interface CaseRow {
  id: string
  channel: 'phrase' | 'formula' | 'interaction' | 'conditional'
  input: { text: string; ctx?: string[] }
}

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as T)

const entries = readJsonl<EntryRow>(join(DATASET, 'entries.jsonl'))
const cases = readJsonl<CaseRow>(join(DATASET, 'cases.jsonl'))

function describeMatcher(e: EntryRow): string {
  const parts: string[] = []
  for (const p of e.matcher.patterns) {
    if (p.kind === 'lex') parts.push(`词表命中：${(p.terms ?? []).join(' / ')}`)
    else if (p.kind === 'skeleton') parts.push(`骨架槽位：${(p.tokens ?? []).join(' ')}`)
    else if (p.kind === 'interaction') parts.push(`交互配对：上句特征[${(p.trigger_terms ?? []).join('、')}] → 本句特征[${(p.response_terms ?? []).join('、')}]`)
  }
  const cons = e.matcher.constraints ?? {}
  const notes: string[] = []
  if (cons.forbid_inner) notes.push('forbid_inner=命中不得是更长词的一部分')
  if (cons.standalone) notes.push('standalone=需独立/胶水语境')
  if (Array.isArray(cons.forbid_context) && cons.forbid_context.length) notes.push(`forbid_context=附近出现这些词则否决：${cons.forbid_context.join('、')}`)
  if (Array.isArray(cons.require_context) && cons.require_context.length) notes.push(`require_context=附近必须出现这些词之一：${cons.require_context.join('、')}`)
  return parts.join('；') + (notes.length ? `。约束：${notes.join('；')}` : '')
}

const HEAD = `# OJ lookup 判题任务

你是一个梗识别评测中的判题模型。下面先给出梗库词条（含匹配规则），然后给出 ${cases.length} 条待判输入。
请判断每条输入是否"命中"某个词条——按词条的匹配规则与常识语义综合判断：

- 固定表达词条：文本包含词条的字面（名称或别名），且用法是玩梗而非字面义/更长词内部；
- 模板词条：文本填入了槽位且公式成立（语法受限的槽不能乱填，字面义不算）；
- 交互词条：需要会话上下文——上一句出现触发特征、最后一句出现回应特征才命中；
  没有上下文或上下文无关一律不命中；
- 约束：标注 forbid 的语境词出现即否决，标注 require 的语境词缺失即否决。

拿不准时倾向判不命中（宁漏不滥）。禁止臆造词条里没有的家族名。

## 输出契约

只输出一个 JSONL 代码块，每行一条，恰好 ${cases.length} 行：

\`\`\`json
{"case_id":"oj-0001","hit":true,"families":["家族id"]}
\`\`\`

- hit=false 时 families 给 []；
- hit=true 时 families 列出命中的家族 id（通常一个；确实同时命中多个梗时给多个）；
- 家族 id 必须来自下面词条列表中的 family 字段，逐字一致。

## 词条列表（family → 定义）

`

function entrySection(): string {
  return entries.map((e) => `- **${e.name}**（family=${e.family}，${e.class}）：${e.gist}\n  - ${describeMatcher(e)}`).join('\n')
}

function caseSection(chunk: CaseRow[]): string {
  return '## 待判输入\n\n' + chunk.map((c) => {
    const ctx = c.input.ctx ? `\n上句：${c.input.ctx[0]}\n本句（待判）：${c.input.ctx[1]}` : ''
    return `- ${c.id}（${c.channel}）：${JSON.stringify(c.input.text)}${ctx}`
  }).join('\n') + '\n'
}

const args = process.argv.slice(2)
const chunksN = args.includes('--chunks') ? Number(args[args.indexOf('--chunks') + 1]) : 1
if (!Number.isInteger(chunksN) || chunksN < 1) throw new Error('--chunks 必须是正整数')

const head = HEAD + entrySection() + '\n\n'
if (chunksN === 1) {
  writeFileSync(join(DATASET, 'judge-prompt.md'), head + caseSection(cases))
  console.log(`judge-prompt.md 已生成（${cases.length} 题）`)
} else {
  const dir = join(DATASET, 'judge-prompt')
  mkdirSync(dir, { recursive: true })
  const size = Math.ceil(cases.length / chunksN)
  for (let i = 0; i < chunksN; i++) {
    const chunk = cases.slice(i * size, (i + 1) * size)
    if (!chunk.length) break
    // 每片的输出契约只覆盖该片
    const chunkHead = head.replace(`恰好 ${cases.length} 行`, `恰好 ${chunk.length} 行（只判本片列出的 case）`)
    writeFileSync(join(dir, `chunk-${i + 1}.md`), chunkHead + caseSection(chunk))
  }
  console.log(`judge-prompt/chunk-1..${Math.min(chunksN, Math.ceil(cases.length / size))}.md 已生成（每片 ≤ ${size} 题）`)
}
