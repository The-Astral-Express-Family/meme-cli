/**
 * 语义层测试：假嵌入器注入，验证泛回应标记的两个通路（用例均值/词头本体）
 * 与弱模板标记的填充离散度门。全部离线（不触真模型）。
 * 假嵌入器：字符→维度无碰撞映射（同字同维、异字异维），余弦=共享字符占比。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { semanticFlags } from '../src/detect/semantics.ts'
import { makeCfg, openDb } from './helpers.ts'
import { kvSet } from '../src/db.ts'
import type { Candidate, UsageSample } from '../src/models.ts'
import type { Embedder } from '../src/match/vector.ts'

/** 假嵌入器：每个不同字符占独立维度，余弦 ≈ 共享字符占比（测试尺度内无碰撞）。 */
function fakeEmbedder(): Embedder {
  const dims = new Map<string, number>()
  const dimOf = (ch: string): number => {
    if (!dims.has(ch)) dims.set(ch, dims.size)
    return dims.get(ch)!
  }
  const vecOf = (t: string): number[] => {
    const v = new Array(512).fill(0)
    for (const ch of t) v[dimOf(ch)] += 1
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
  return {
    available: true,
    dim: 512,
    async embed(texts: string[]) {
      return texts.map(vecOf)
    },
  }
}

const usage = (text: string): UsageSample =>
  ({ text, aid: 1, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false })

const cand = (head: string, channel: string, texts: string[]): Candidate =>
  ({
    cid: 'c_0001', head, kind_guess: 'word', channel: channel as never, state: 'pending',
    z_score: null, distinct_videos: 2, distinct_ups: 2, first_seen: '', last_seen: '',
    surfs_seen: 1, last_round: 1, evidence_usages: texts.map(usage), related: [],
    provenance: '', created_at: '', updated_at: '',
  }) as unknown as Candidate

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('泛回应标记', () => {
  it('内置/配置客套种子仍触发 response_generic', async () => {
    env.cfg.genericExtra.push('来吧')
    const c = cand('来吧', 'copy', ['来吧', '来吧'])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.response_generic).toBe(true)
  })

  it('generic_auto 精确 ban 不进入语义云，不做家族式连带否决', async () => {
    kvSet(env.db, 'generic_auto', JSON.stringify(['独特客套词']))
    const c = cand('独特客套词', 'copy', ['独特客套词', '独特客套词'])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.response_generic).toBeFalsy()
  })

  it('真梗词头与客套云远离（绷）→ 不标记', async () => {
    kvSet(env.db, 'generic_auto', JSON.stringify(['来吧', '吧', '哦']))
    const c = cand('绷', 'phrase', ['绷住了', '绷'])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.response_generic).toBeFalsy()
  })

  it('embedder 不可用 → 优雅降级为无标记', async () => {
    const nullEmb: Embedder = { available: false, dim: null, async embed() { return null } }
    const c = cand('来吧', 'copy', ['来吧'])
    const flags = await semanticFlags(env.db, env.cfg, c, nullEmb)
    expect(Object.keys(flags)).toEqual([])
  })
})

describe('泛夸标记', () => {
  it('词头与夸赞云近同（可爱）→ praise_generic', async () => {
    const c = cand('可爱', 'phrase', ['好可爱', '可爱捏'])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.praise_generic).toBe(true)
  })

  it('真梗词头远离夸赞云（没绷住）→ 不标记', async () => {
    const c = cand('没绷住', 'phrase', ['没绷住', '没绷住我15w'])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.praise_generic).toBeFalsy()
  })
})

describe('弱模板标记（填充离散度）', () => {
  it('模板填充过于近同（槽位不自由）→ weak_template', async () => {
    // 槽填充只差一个字（"整整四分钟/五分钟/六分钟的大片"）→ 数量词槽二道闸
    const c = cand('等了<X>才好', 'skeleton', [
      '等了整整四分钟的大片才好', '等了整整五分钟的大片才好', '等了整整六分钟的大片才好',
    ])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.weak_template).toBe(true)
  })

  it('填充语义多样（真公式槽位）→ 不标记', async () => {
    const c = cand('等了<X>才好', 'skeleton', [
      '等了原神的大片才好', '等了高考的成绩才好', '等了快递的到货才好',
    ])
    const flags = await semanticFlags(env.db, env.cfg, c, fakeEmbedder())
    expect(flags.weak_template).toBeFalsy()
  })
})
