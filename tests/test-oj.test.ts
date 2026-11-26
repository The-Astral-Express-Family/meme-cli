/**
 * OJ 行为基准评分器的合成用例：只验证"判定规则"本身，不依赖 264 题快照。
 * 覆盖 TP/FP/FN/TN、forbid 家族、额外无关命中、公式替换分组、同文异境成对。
 */
import { describe, expect, it } from 'vitest'
import { scoreRun } from '../scripts/oj-score.ts'

type Case = Parameters<typeof scoreRun>[0][number]
type Out = Parameters<typeof scoreRun>[2][number]

const c = (
  id: string, channel: Case['channel'], text: string,
  expectSpec: Case['expect'], tags: string[] = [], ctx?: string[],
  family = 'm', entry_ref = 'e',
): Case => ({
  id, channel, family, entry_ref,
  input: ctx ? { text, ctx } : { text },
  expect: expectSpec, tags,
})

const o = (case_id: string, families: string[]): Out => ({ case_id, hit: families.length > 0, families })

const CASES: Case[] = [
  c('f1', 'formula', 'A，启动！', { hit: true, family: 'm' }, ['slot-same-domain']),
  c('f2', 'formula', 'B，启动！', { hit: true, family: 'm' }, ['slot-cross-domain']),
  c('f3', 'formula', '脚都麻了', { hit: false, forbid: ['m'] }, ['slot-literal-hard']),
  c('p1', 'phrase', '典中典', { hit: true, family: 'nb' }),
  c('p2', 'phrase', '古典文学', { hit: false, forbid: ['nb'] }),
  c('i1', 'interaction', '小黑子', { hit: true, family: 'hei' }, [], ['只因你太美', '小黑子'], 'hei'),
  c('i2', 'interaction', '小黑子', { hit: false, forbid: ['hei'] }, [], ['今天天气不错', '小黑子'], 'hei'),
  c('c1', 'conditional', '为什么不回答我？', { hit: false, forbid: ['huida'] }, ['forbid-context'], undefined, 'huida'),
]

const OUTPUTS: Out[] = [
  o('f1', ['m']),          // TP
  o('f2', []),             // FN（跨域替换没成立）
  o('f3', ['m']),          // FP（槽吞字面义）
  o('p1', ['nb', 'other']), // TP + 1 个额外无关命中
  o('p2', []),             // TN
  o('i1', ['hei']),        // TP
  o('i2', ['hei']),        // FP（同文换 ctx 后仍误报）
  o('c1', []),             // TN
]

describe('OJ 评分器', () => {
  it('混淆矩阵、公式分组与同文异境成对判定', () => {
    const s = scoreRun(CASES, 'synthetic', OUTPUTS)
    expect([s.tp, s.fp, s.fn, s.tn]).toEqual([3, 2, 1, 2])
    expect(s.total).toBe(8)
    expect(s.accuracy).toBe(5 / 8)
    expect(s.precision).toBe(3 / 5)
    expect(s.recall).toBe(3 / 4)
    // 额外命中单独统计，不污染主矩阵
    expect(s.extra_hits).toBe(1)
    // 已知硬负例失分只在带标签的负例上计
    expect(s.hard_negative_errors).toBe(1)
    // 公式正例召回：f1 命中、f2 未命中
    expect(s.formula_recall).toBe(1 / 2)
    expect(s.formula_by_tag['slot-same-domain']).toMatchObject({ total: 1, tp: 1 })
    expect(s.formula_by_tag['slot-cross-domain']).toMatchObject({ total: 1, tp: 0 })
    // 同文异境：i1 对、i2 错 → 这一对不算区分成功
    expect(s.paired_context).toMatchObject({ pairs: 1, correct: 0, accuracy: 0 })
    expect(s.failed_cases.map((f) => f.case_id)).toEqual(['f2', 'f3', 'i2'])
  })

  it('输出与用例对不齐时直接报错，不静默按 0 分处理', () => {
    expect(() => scoreRun(CASES, 'm', OUTPUTS.slice(1))).toThrow(/缺 1 题/)
    expect(() => scoreRun(CASES, 'm', [...OUTPUTS, o('nope', [])])).toThrow(/未知 1 题/)
  })
})
