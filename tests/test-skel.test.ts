/** 骨架归一化与单槽掩码变体。 */
import { describe, expect, it } from 'vitest'
import { normalize, normalizeSpanned, skeletonHash, skeletonVariants } from '../src/detect/skel.ts'
import { phrases } from '../src/detect/ngram.ts'

describe('detect/skel', () => {
  it('槽位归一化：数字/表情/URL/@', () => {
    const toks = normalize('这有 3 个 [doge] 和 https://b23.tv/abc 以及 @某人 的链接')
    expect(toks).toContain('<num>')
    expect(toks).toContain('<emo>')
    expect(toks).toContain('<url>')
    expect(toks).toContain('<at>')
  })

  it('成对槽掩码使实体坍缩到同一骨架', () => {
    const a = skeletonVariants('一眼原神鉴定为云玩家')
    const b = skeletonVariants('一眼华为鉴定为遥遥领先')
    const shared = a.filter((s) => b.includes(s))
    expect(shared.some((s) => s.includes('一眼') && s.includes('鉴定') && s.includes('<ent>'))).toBe(true)
  })

  it('骨架哈希稳定', () => {
    expect(skeletonHash('一眼 <ent> 鉴定为 <ent>')).toBe(skeletonHash('一眼 <ent> 鉴定为 <ent>'))
  })

  it('spanned 偏移覆盖原文', () => {
    const text = '一眼原神，鉴定为 3a 玩家'
    for (const { token, start, end } of normalizeSpanned(text)) {
      if (!token.startsWith('<')) expect(text.slice(start, end)).toBe(token)
    }
  })
})

describe('detect/ngram', () => {
  it('短语过滤标点且保留内容词', () => {
    const out = phrases('这个视频真的太好笑了，泪目')
    expect(out.some((p) => p.includes('笑'))).toBe(true)
    expect(out.every((p) => !p.includes('，'))).toBe(true)
  })

  it('gram 不跨标点（"太酷辣，直接showhand"拼不出"太酷辣直接"）', () => {
    const ps = phrases('太酷辣，直接showhand')
    expect(ps).not.toContain('太酷辣直接')
    expect(ps).not.toContain('辣直接')
    const ps2 = phrases('不愧是你，典中典')
    expect(ps2).not.toContain('不愧是你典')
  })

  it('功能词头/尾句式热梗不被误杀（金标准集）', () => {
    for (const m of ['我记下了', '乐子人', '属于是', '那咋了', '太抽象了', '你说得对', '什么水平', '绷不住了', '蚌埠住了']) {
      expect(phrases(m)).toContain(m)
    }
  })
})
