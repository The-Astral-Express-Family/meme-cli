import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  loadDataset, renderMarkdown, scoreDataset, scoreModel, validateOutput,
  type BenchmarkOutput,
} from '../scripts/benchmark-score.ts'

const V4 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v4')

function outputRows(): BenchmarkOutput[] {
  const d = loadDataset(V4)
  return d.cases.map((c) => ({
    case_id: c.case_id,
    source_cid: c.source_cid,
    head: c.head,
    verdict: 'not-meme',
    family_id: null,
    canonical_head: null,
    confidence: 'high',
    rationale: '测试输出',
    evidence_ids: c.evidence[0] ? [c.evidence[0].evidence_id] : [],
  }))
}

describe('candidate judgment benchmark v4', () => {
  it('loads the confirmed 72-case dataset and verifies LF-normalized hashes', () => {
    const d = loadDataset(V4)
    expect(d.manifest.labels_are_evaluation_only).toBe(true)
    expect(d.manifest.operator_review).toMatchObject({ status: 'confirmed' })
    expect(d.manifest.source).toMatchObject({ surf_round: 25, new_videos: 83, new_comments: 10127 })
    expect(d.cases).toHaveLength(72)
    expect(d.labels).toHaveLength(72)
    expect(new Set(d.cases.map((c) => c.case_id)).size).toBe(72)
    expect(d.cases.every((c) => c.evidence.length > 0)).toBe(true)
    expect(d.cases.filter((c) => c.channel === 'phrase')).toHaveLength(54)
    expect(d.cases.filter((c) => c.channel === 'skeleton')).toHaveLength(10)
    expect(d.cases.filter((c) => c.channel === 'copy')).toHaveLength(8)
    expect(d.cases.filter((c) => c.case_id.startsWith('cjv4-'))).toHaveLength(24)

    const prompt = readFileSync(join(V4, 'prompt.md'), 'utf8')
    expect(prompt).toContain('72 条模型可见案例')
    expect(prompt).toContain('"case_id": "example-001"')
    expect(prompt).not.toMatch(/"case_id"\s*:\s*"cjv[134]-/)
    expect(prompt).not.toMatch(/"source_cid"\s*:\s*"c_\d+"/)
    expect(prompt).not.toMatch(/"evidence_ids"\s*:\s*\["cjv[134]-/)

    const familyByCanonical = new Map<string, string>()
    for (const label of d.labels) {
      if (!label.canonical_head) continue
      const prev = familyByCanonical.get(label.canonical_head)
      if (prev !== undefined) expect(label.family_id).toBe(prev)
      else familyByCanonical.set(label.canonical_head, label.family_id!)
    }
  })

  it('defaults to v4 and renders an explicit empty report before fresh model runs', () => {
    const d = loadDataset()
    expect(d.manifest.dataset_id).toBe('candidate-judgment-v4')
    const report = scoreDataset(d)
    expect(report.models).toEqual([])
    const md = renderMarkdown(report)
    expect(md).toContain('candidate-judgment-v4')
    expect(md).toContain('案例数：72')
    expect(md).toContain('暂无模型输出')
  })

  it('keeps candidate/family/canonical scoring separate', () => {
    const d = loadDataset(V4)
    const score = scoreModel(d, 'all-not-meme', outputRows())
    expect(score.total).toBe(72)
    expect(score.decided + score.abstained).toBe(72)
    expect(score.tp + score.fp + score.fn + score.tn).toBe(score.decided)
    expect(score.evidence_invalid).toBe(0)
    expect(score.canonical_total).toBeGreaterThan(0)
    expect(score.family_tp + score.family_fp + score.family_fn).toBeGreaterThan(0)
  })

  it('rejects duplicate, missing, extra, and invalid evidence references', () => {
    const d = loadDataset(V4)
    const rows = outputRows()
    expect(validateOutput(d, rows)).toEqual([])
    expect(validateOutput(d, [...rows, rows[0]]).some((e) => e.includes('重复'))).toBe(true)
    expect(validateOutput(d, rows.slice(1)).some((e) => e.includes('缺少'))).toBe(true)
    const extra = { ...rows[0], case_id: 'unknown' }
    expect(validateOutput(d, [...rows, extra]).some((e) => e.includes('未知'))).toBe(true)
    const badEvidence = rows.map((r, i) => i === 0 ? { ...r, evidence_ids: ['missing'] } : r)
    expect(validateOutput(d, badEvidence).some((e) => e.includes('引用不存在'))).toBe(true)
  })

  it('renders a markdown report with all 72 cases', () => {
    const d = loadDataset(V4)
    const score = scoreModel(d, 'all-not-meme', outputRows())
    const md = renderMarkdown({ dataset_id: 'candidate-judgment-v4', version: 4, case_count: 72, models: [score], agreement: [] })
    expect(md).toContain('候选词头判断与家族/完整形识别分开计分')
    expect(md).toContain('cjv4-072')
    expect(md.match(/^\| cjv/gm)).toHaveLength(72)
  })
})
