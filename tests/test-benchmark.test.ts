/**
 * candidate-judgment benchmark 测试（3 个）：
 * ① 合成小金标验证 scorer 数学（含 conditional 三分类修正）与输出对齐校验；
 * ② prompt 由生成器渲染且说明部分零金标泄漏；
 * ③ 真实数据集完整性与 manifest 哈希一致。
 * 不测题目数量/渠道/来源快照——那是数据编辑产物，不属于单元测试。
 * 模型 outputs/ 是运行产物（已 gitignore），测试不依赖任何具体模型的作答。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  findGoldLeaks, loadDataset, renderMarkdown, scoreModel, validateOutput,
  type BenchmarkOutput,
} from '../scripts/benchmark-score.ts'
import { renderPrompt } from '../scripts/bench-prompt.ts'
import { MANUAL } from '../src/index.ts'

const V4 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v4')
const sha256 = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')

const mkCase = (id: string, evidenceId = `${id}:e1`) => ({
  case_id: id, source_cid: `c_${id}`, head: `词头${id}`, kind_guess: 'word', channel: 'phrase',
  state: 'triggered', videos: 3, ups: 3, burst: null, surfs_seen: 2, related: [],
  sources: [{ aid: 1, title: '视频', up_name: 'up' }],
  evidence: [{ evidence_id: evidenceId, text: `${id} 的证据句`, aid: 1, rpid: 1, mid: 1, is_reply: false, is_chain: false }],
})

const mkLabel = (o: {
  id: string
  candidate: 'meme' | 'not-meme' | 'conditional'
  resolved?: 'meme' | 'not-meme'
  family?: string | null
  canonical?: string | null
  forms?: string[]
}) => ({
  case_id: o.id, source_cid: `c_${o.id}`,
  candidate_verdict: o.candidate, resolved_verdict: o.resolved ?? (o.candidate === 'not-meme' ? 'not-meme' : 'meme'),
  family_id: o.family ?? null, canonical_head: o.canonical ?? null,
  accepted_canonical_forms: o.forms ?? (o.canonical ? [o.canonical] : []),
  rationale: '测试金标',
})

/** 合成数据集：4 题覆盖 meme/conditional/not-meme/漏报，写入临时目录并自算哈希。 */
function syntheticDataset(): string {
  const root = mkdtempSync(join(tmpdir(), 'meme-bench-synth-'))
  const cases = [
    mkCase('s-1'), mkCase('s-2'), mkCase('s-3'), mkCase('s-4'),
  ]
  const labels = [
    mkLabel({ id: 's-1', candidate: 'meme', family: 'kaoshen', canonical: '考神', forms: ['考神', '考神附体'] }),
    mkLabel({ id: 's-2', candidate: 'conditional', resolved: 'meme', family: 'liang', canonical: '早上好', forms: ['早上好'] }),
    mkLabel({ id: 's-3', candidate: 'not-meme' }),
    mkLabel({ id: 's-4', candidate: 'meme', family: 'kaoshen', canonical: '考神', forms: ['考神'] }),
  ]
  const casesText = cases.map((c) => JSON.stringify(c)).join('\n')
  const labelsText = labels.map((l) => JSON.stringify(l)).join('\n')
  writeFileSync(join(root, 'cases.jsonl'), casesText)
  writeFileSync(join(root, 'labels.jsonl'), labelsText)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    dataset_id: 'synthetic-v1', version: 1, case_count: 4,
    hashes: { 'cases.jsonl': sha256(casesText), 'labels.jsonl': sha256(labelsText) },
    labels_are_evaluation_only: true,
  }))
  return root
}

const synthOutputs = (): BenchmarkOutput[] => [
  // s-1 正确 meme + 完整形命中；s-2 conditional 答对（旧 scorer 会让它恒错）；s-3 正确 TN；s-4 漏报
  { case_id: 's-1', source_cid: 'c_s-1', head: '词头s-1', verdict: 'meme', family_id: 'kaoshen', canonical_head: '考神', confidence: 'high', rationale: 'r', evidence_ids: ['s-1:e1'] },
  { case_id: 's-2', source_cid: 'c_s-2', head: '词头s-2', verdict: 'conditional', family_id: 'liang', canonical_head: '早上好', confidence: 'high', rationale: 'r', evidence_ids: ['s-2:e1'] },
  { case_id: 's-3', source_cid: 'c_s-3', head: '词头s-3', verdict: 'not-meme', family_id: null, canonical_head: null, confidence: 'high', rationale: 'r', evidence_ids: ['s-3:e1'] },
  { case_id: 's-4', source_cid: 'c_s-4', head: '词头s-4', verdict: 'not-meme', family_id: null, canonical_head: null, confidence: 'high', rationale: 'r', evidence_ids: ['s-4:e1'] },
]

describe('candidate judgment benchmark', () => {
  it('scorer 数学：候选三分类与 resolved 二元分开计分，conditional 不再恒错', () => {
    const root = syntheticDataset()
    try {
      const d = loadDataset(root)
      const outputs = synthOutputs()
      expect(validateOutput(d, outputs)).toEqual([])
      const score = scoreModel(d, 'synthetic', outputs)
      expect(score.total).toBe(4)
      expect(score.decided + score.abstained).toBe(4)
      expect([score.tp, score.fp, score.fn, score.tn]).toEqual([2, 0, 1, 1])
      // s-1 meme✓ s-2 conditional✓ s-3 not-meme✓ s-4 not-meme✗（gold meme）
      expect(score.candidate_accuracy).toBe(3 / 4)
      expect(score.conditional_correct).toBe(1)
      expect(score.conditional_total).toBe(1)
      // resolved 层：s-1/s-2 TP（conditional 记肯定），s-4 FN，s-3 TN
      expect(score.precision).toBe(1)
      expect(score.recall).toBe(2 / 3)
      // s-1/s-2 完整形命中；s-4（gold 有完整形）答 null → 2/3
      expect(score.canonical_accuracy).toBe(2 / 3)
      expect(score.family_f1).toBeGreaterThan(0)
      const byId = new Map(score.cases.map((c) => [c.case_id, c]))
      expect(byId.get('s-2')!.candidate_correct).toBe(true)
      expect(byId.get('s-4')!.candidate_correct).toBe(false)
      const md = renderMarkdown({ dataset_id: 'synthetic-v1', version: 1, case_count: 4, models: [score], agreement: [] })
      expect(md).toContain('候选判定准确率')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('输出对齐校验：重复/缺失/未知/无效证据引用都能报错', () => {
    const root = syntheticDataset()
    try {
      const d = loadDataset(root)
      const rows = synthOutputs()
      expect(validateOutput(d, rows)).toEqual([])
      expect(validateOutput(d, [...rows, rows[0]]).some((e) => e.includes('重复'))).toBe(true)
      expect(validateOutput(d, rows.slice(1)).some((e) => e.includes('缺少'))).toBe(true)
      expect(validateOutput(d, [...rows, { ...rows[0], case_id: 'unknown' }]).some((e) => e.includes('未知'))).toBe(true)
      const badEvidence = rows.map((r, i) => i === 0 ? { ...r, evidence_ids: ['missing'] } : r)
      expect(validateOutput(d, badEvidence).some((e) => e.includes('引用不存在'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prompt 是生成器的产物且说明部分零金标泄漏；真实数据集哈希自洽', () => {
    const d = loadDataset(V4) // 哈希校验在 loadDataset 内部执行
    const prompt = readFileSync(join(V4, 'prompt.md'), 'utf8').replace(/\r\n/g, '\n')
    const guide = readFileSync(join(process.cwd(), 'docs', 'meme-judgment-guide.md'), 'utf8')
    expect(renderPrompt(d.cases, guide, MANUAL)).toBe(prompt)
    const instruction = prompt.slice(0, prompt.indexOf('\n## 4. '))
    expect(findGoldLeaks(instruction, d.labels)).toEqual([])
    expect(d.manifest.labels_are_evaluation_only).toBe(true)
    expect(d.cases).toHaveLength(d.manifest.case_count)
    // 不在这里调 scoreDataset：outputs/ 是运行产物（不入 git），测试不得依赖其存在或内容
  })
})
