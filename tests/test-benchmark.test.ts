import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  loadDataset, renderMarkdown, scoreDataset, scoreModel, validateOutput,
  type BenchmarkOutput,
} from '../scripts/benchmark-score.ts'

const V3 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v3')
const V4 = join(process.cwd(), 'benchmarks', 'candidate-judgment-v4')

function outputRows(modelDir: string): BenchmarkOutput[] {
  const text = readFileSync(join(V3, 'outputs', modelDir, 'output.jsonl'), 'utf8')
  return text.trim().split('\n').map((line) => JSON.parse(line))
}

describe('candidate judgment benchmark', () => {
  it('loads the 72-case v4 dataset and verifies LF-normalized manifest hashes', () => {
    const d = loadDataset(V4)
    expect(d.manifest.labels_are_evaluation_only).toBe(true)
    expect(d.manifest.operator_review).toMatchObject({ status: 'confirmed' })
    expect(d.manifest.source).toMatchObject({ surf_round: 25, new_videos: 83, new_comments: 10127 })
    expect(d.cases).toHaveLength(72)
    expect(d.labels).toHaveLength(72)
    expect(new Set(d.cases.map((c) => c.case_id)).size).toBe(72)
    expect(d.cases.every((c) => c.evidence.length > 0)).toBe(true)
    expect(d.cases.filter((c) => c.channel === 'copy')).toHaveLength(8)
    expect(d.cases.filter((c) => c.case_id.startsWith('cjv4-'))).toHaveLength(24)
    const prompt = readFileSync(join(V4, 'prompt.md'), 'utf8')
    expect(prompt).toContain('72 条模型可见案例')
    expect(prompt).toContain('"case_id": "example-001"')
    // 输出契约示例不得泄漏任何真实题号/证据号
    expect(prompt).not.toMatch(/"case_id"\s*:\s*"cjv[134]-/)
    expect(prompt).not.toMatch(/"source_cid"\s*:\s*"c_\d+"/)
    expect(prompt).not.toMatch(/"evidence_ids"\s*:\s*\["cjv[134]-/)
    // 同一 canonical 必须使用稳定且唯一的 family_id
    const familyByCanonical = new Map<string, string>()
    for (const label of d.labels) {
      if (!label.canonical_head) continue
      const prev = familyByCanonical.get(label.canonical_head)
      if (prev !== undefined) expect(label.family_id).toBe(prev)
      else familyByCanonical.set(label.canonical_head, label.family_id!)
    }
    // v3 的 48 题原样保留
    const v3 = loadDataset(V3)
    expect(d.cases.slice(0, 48)).toEqual(v3.cases)
    expect(d.labels.slice(0, 48)).toEqual(v3.labels)
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

  it('scores both OpenCode Go runs and keeps candidate/family/canonical separate', () => {
    const report = scoreDataset(loadDataset(V3))
    expect(report.models.map((m) => m.model)).toEqual(['hungerg-free', 'hy4-flash-free'])
    for (const m of report.models) {
      expect(m.total).toBe(48)
      expect(m.decided + m.abstained).toBe(48)
      expect(m.tp + m.fp + m.fn + m.tn).toBe(m.decided)
      expect(m.evidence_invalid).toBe(0)
    }
    // “神”候选词头不是梗，hy4 判对了候选，却没有补出完整形“神了”。
    const hy4 = report.models.find((m) => m.model === 'hy4-flash-free')!
    const shen = hy4.cases.find((c) => c.source_cid === 'c_53690')!
    expect(shen.gold_candidate_verdict).toBe('not-meme')
    expect(shen.candidate_correct).toBe(true)
    expect(shen.gold_canonical).toBe('神了')
    expect(shen.canonical_correct).toBe(false)
  })

  it('handles the conditional stock-market case as resolved meme for this snapshot', () => {
    const d = loadDataset(V3)
    const score = scoreModel(d, 'hungerg-free', outputRows('hungerg-free'))
    const stock = score.cases.find((c) => c.source_cid === 'c_57249')!
    expect(stock.gold_candidate_verdict).toBe('conditional')
    expect(stock.gold_resolved_verdict).toBe('meme')
    expect(stock.output_verdict).toBe('not-meme')
    expect(stock.candidate_correct).toBe(false)
  })

  it('rejects duplicate, missing, extra, and invalid evidence references', () => {
    const d = loadDataset(V3)
    const rows = outputRows('hungerg-free')
    expect(validateOutput(d, rows)).toEqual([])
    expect(validateOutput(d, [...rows, rows[0]]).some((e) => e.includes('重复'))).toBe(true)
    expect(validateOutput(d, rows.slice(1)).some((e) => e.includes('缺少'))).toBe(true)
    const extra = { ...rows[0], case_id: 'unknown' }
    expect(validateOutput(d, [...rows, extra]).some((e) => e.includes('未知'))).toBe(true)
    const badEvidence = rows.map((r, i) => i === 0 ? { ...r, evidence_ids: ['missing'] } : r)
    expect(validateOutput(d, badEvidence).some((e) => e.includes('引用不存在'))).toBe(true)
  })

  it('keeps the integrated cases and operator-approved formula labels', () => {
    const d = loadDataset(V3)
    expect(d.manifest.dataset_id).toBe('candidate-judgment-v3')
    expect(d.manifest.source).toMatchObject({ surf_round: 22, new_videos: 30, new_comments: 3015 })
    expect(d.cases.filter((c) => c.case_id.startsWith('cjv1-'))).toHaveLength(24)
    expect(d.cases.filter((c) => c.case_id.startsWith('cjv3-'))).toHaveLength(24)
    const labelByCid = new Map(d.labels.map((l) => [l.source_cid, l]))
    expect(labelByCid.get('c_54771')?.canonical_head).toBe('<X>你做人真的可以')
    expect(labelByCid.get('c_57162')?.canonical_head).toBe('<X>be like')
    expect(labelByCid.get('c_55226')?.canonical_head).toBe('天不生<X>万古如长夜')
    expect(labelByCid.get('c_56987')?.canonical_head).toBe('<X>来')
    expect(labelByCid.get('c_56987')?.accepted_canonical_forms).toContain('token来')
    expect(labelByCid.get('c_61427')?.candidate_verdict).toBe('not-meme')
    expect(labelByCid.get('c_61427')?.canonical_head).toBeNull()
    expect(labelByCid.get('c_55219')?.candidate_verdict).toBe('meme')
    expect(labelByCid.get('c_55219')?.canonical_head).toBe('省流')
    expect(labelByCid.get('c_59854')?.candidate_verdict).toBe('not-meme')
    expect(labelByCid.get('c_59854')?.canonical_head).toBe('去见拉瓦锡')
    const prompt = readFileSync(join(V3, 'prompt.md'), 'utf8')
    expect(prompt).toContain('48 条模型可见案例')
    expect(prompt).not.toContain('旧 `surf --reject/--ban/--allow`')
    expect(prompt).toContain('`surf` 只负责执行轮次')
  })

  it('renders an explicit empty report when a dataset has no fresh outputs', () => {
    const md = renderMarkdown({
      dataset_id: 'candidate-judgment-v3', version: 3, case_count: 48, models: [], agreement: [],
    })
    expect(md).toContain('candidate-judgment-v3')
    expect(md).toContain('暂无模型输出')
  })

  it('renders a markdown report with model summary and all 48 cases', () => {
    const md = renderMarkdown(scoreDataset(loadDataset(V3)))
    expect(md).toContain('候选词头判断与家族/完整形识别分开计分')
    expect(md).toContain('hungerg-free')
    expect(md).toContain('hy4-flash-free')
    expect(md).toContain('cjv3-048')
    expect(md.match(/^\| cjv/gm)).toHaveLength(48)
  })
})
