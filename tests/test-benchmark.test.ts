import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  loadDataset, renderMarkdown, scoreDataset, scoreModel, validateOutput,
  type BenchmarkOutput,
} from '../scripts/benchmark-score.ts'

const V1 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v1')
const V2 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v2')
const DATASET = V1

function outputRows(modelDir: string): BenchmarkOutput[] {
  const text = readFileSync(join(DATASET, 'outputs', modelDir, 'output.jsonl'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line))
}

describe('candidate judgment benchmark', () => {
  it('loads a hermetic 24-case dataset and verifies manifest hashes', () => {
    const d = loadDataset(DATASET)
    expect(d.manifest.labels_are_evaluation_only).toBe(true)
    expect(d.cases).toHaveLength(24)
    expect(d.labels).toHaveLength(24)
    expect(new Set(d.cases.map((c) => c.case_id)).size).toBe(24)
    expect(d.cases.every((c) => c.evidence.length > 0)).toBe(true)
  })

  it('scores all four historical runs and keeps candidate/family/canonical separate', () => {
    const report = scoreDataset(loadDataset(DATASET))
    expect(report.models.map((m) => m.model)).toEqual(['GLM-5.4', 'GLM-5.3-Flash', 'GLM-5.3', 'HungerG'])
    for (const m of report.models) {
      expect(m.total).toBe(24)
      expect(m.decided + m.abstained).toBe(24)
      expect(m.tp + m.fp + m.fn + m.tn).toBe(m.decided)
      expect(m.evidence_invalid).toBe(0)
    }
    // “爆”四组都拒绝了截断头，但都没有补出完整形“爆了”：候选层不算错，完整形层必须丢分。
    for (const m of report.models) {
      const c = m.cases.find((x) => x.source_cid === 'c_52990')!
      expect(c.gold_candidate_verdict).toBe('not-meme')
      expect(c.candidate_correct).toBe(true)
      expect(c.gold_canonical).toBe('爆了')
      expect(c.canonical_correct).toBe(false)
    }
    // “神”和“死我了”证据有家族，但候选词头本身不是梗；归并不应冒充候选级正确。
    for (const m of report.models) {
      const shen = m.cases.find((x) => x.source_cid === 'c_53690')!
      const siwo = m.cases.find((x) => x.source_cid === 'c_53595')!
      expect(shen.family_correct).toBe(true)
      expect(shen.candidate_correct).toBe(false)
      expect(siwo.family_correct).toBe(true)
      expect(siwo.candidate_correct).toBe(false)
    }
  })

  it('handles the conditional stock-market case as resolved meme for this snapshot', () => {
    const d = loadDataset(DATASET)
    const rows = outputRows('glm-5.3')
    const score = scoreModel(d, 'GLM-5.3', rows)
    const stock = score.cases.find((c) => c.source_cid === 'c_57249')!
    expect(stock.gold_candidate_verdict).toBe('conditional')
    expect(stock.gold_resolved_verdict).toBe('meme')
    expect(stock.output_verdict).toBe('not-meme')
    expect(stock.candidate_correct).toBe(false)
  })

  it('rejects duplicate, missing, extra, and invalid evidence references', () => {
    const d = loadDataset(DATASET)
    const rows = outputRows('glm-5.4')
    expect(validateOutput(d, rows)).toEqual([])
    expect(validateOutput(d, [...rows, rows[0]]).some((e) => e.includes('重复'))).toBe(true)
    expect(validateOutput(d, rows.slice(1)).some((e) => e.includes('缺少'))).toBe(true)
    const extra = { ...rows[0], case_id: 'unknown' }
    expect(validateOutput(d, [...rows, extra]).some((e) => e.includes('未知'))).toBe(true)
    const badEvidence = rows.map((r, i) => i === 0 ? { ...r, evidence_ids: ['missing'] } : r)
    expect(validateOutput(d, badEvidence).some((e) => e.includes('引用不存在'))).toBe(true)
  })

  it('v2 keeps cases and gold labels byte-identical to v1 but uses the repaired context', () => {
    for (const file of ['cases.jsonl', 'labels.jsonl']) {
      expect(readFileSync(join(V2, file))).toEqual(readFileSync(join(V1, file)))
    }
    const v1Prompt = readFileSync(join(V1, 'prompt.md'), 'utf8')
    const v2Prompt = readFileSync(join(V2, 'prompt.md'), 'utf8')
    expect(v1Prompt).toContain('自动沉底永不触发')
    expect(v2Prompt).not.toContain('自动沉底永不触发')
    expect(v2Prompt).toContain('check 只读')
    expect(v2Prompt).toContain('triggered 不粘住')
    const d = loadDataset(V2)
    expect(d.manifest.dataset_id).toBe('candidate-judgment-v2')
    expect(d.manifest.based_on).toBe('candidate-judgment-v1')
  })

  it('renders an explicit empty report when a dataset has no fresh outputs', () => {
    const md = renderMarkdown({
      dataset_id: 'candidate-judgment-v2', version: 2, case_count: 24, models: [], agreement: [],
    })
    expect(md).toContain('candidate-judgment-v2')
    expect(md).toContain('暂无模型输出')
  })

  it('renders a markdown report with model summary and all 24 cases', () => {
    const md = renderMarkdown(scoreDataset(loadDataset(DATASET)))
    expect(md).toContain('候选词头判断与家族/完整形识别分开计分')
    expect(md).toContain('GLM-5.3')
    expect(md).toContain('cjv1-024')
    expect(md.match(/^\| cjv1-/gm)).toHaveLength(24)
  })
})
