/** add/iterate 入库流（操作员亲写 entry）：闸门、重名守卫、候选收口、iterate 证据收集。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runAddEntry, runIterate, collectIterateEvidence } from '../src/induct/inductor.ts'
import { MemeError } from '../src/errors.ts'
import * as audit from '../src/audit.ts'
import * as entries from '../src/entries.ts'
import * as candidates from '../src/candidates.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

const entry = (name = '青铜巨像') => ({
  name,
  aliases: ['青铜像'],
  class: 'word' as const,
  birth_circa: '2026',
  card: { gist: '测试用词梗', usage: ['青铜巨像，名场面'], taboo: null, register: null, aggression: '低' },
  examples: ['青铜巨像，第1个名场面', '真青铜巨像'],
  matcher: { patterns: [{ kind: 'lex', terms: [name, '青铜像'] }], constraints: {} },
  notes: '操作员测试词条',
})

function seedCandidateWithEvidence(db: ReturnType<typeof openDb>): string {
  const usages = Array.from({ length: 6 }, (_, i) => ({
    text: `青铜巨像名场面第${i}弹`, aid: 7000 + (i % 2), rpid: 8000 + i,
    root: 0, parent: 0, mid: 0, ctime: 0, chain: false,
  }))
  candidates.upsertFromSignal(db, {
    head: '青铜巨像', channel: 'phrase', kind_guess: 'word',
    usages, video_pairs: [{ aid: 7000, up_mid: 0 }, { aid: 7001, up_mid: 0 }],
    day: '2026-11-09', round_id: 1,
  })
  return candidates.byHead(db, '青铜巨像')!.cid
}

describe('add：操作员亲写 entry', () => {
  it('闸门全保留；审计带 entry_notes；候选收口 inducted', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const res = await runAddEntry(env.db, env.cfg, entry(), { cids: [cid], holdout_texts: ['青铜巨像独立留出例'] })
    expect(res.meme.id.startsWith('m_')).toBe(true)
    expect(res.meme.state).toBe('observing')
    expect(res.meme.matcher).not.toBeNull()
    expect(res.backtest?.passed).toBe(true)
    expect(entries.get(env.db, res.meme.id)).not.toBeNull()
    expect(candidates.get(env.db, cid)!.state).toBe('inducted')
    const audits = audit.forMeme(env.db, res.meme.id)
    expect(audits.length).toBeGreaterThan(0)
    expect((audits[0].payload as { entry_notes: string }).entry_notes).toBe('操作员测试词条')
  })

  it('backtest 未达标：报 MEME_BACKTEST_FAIL 附样例；词条不入库', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const bad = entry('绝不存在词')
    bad.matcher = { patterns: [{ kind: 'lex', terms: ['绝不存在的词'] }], constraints: {} }
    await expect(runAddEntry(env.db, env.cfg, bad, {
      cids: [cid], holdout_texts: ['绝不存在词独立留出例'],
    })).rejects.toMatchObject({ code: 'MEME_BACKTEST_FAIL' })
    expect(entries.get(env.db, 'm_0001')).toBeNull() // 未入库
    expect(candidates.get(env.db, cid)!.state).not.toBe('inducted')
  })

  it('force：闸门不过仍入库（纯向量降级），进审计与警告', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const bad = entry('绝不存在词二')
    bad.matcher = { patterns: [{ kind: 'lex', terms: ['绝不存在的词二'] }], constraints: {} }
    const res = await runAddEntry(env.db, env.cfg, bad, {
      cids: [cid], force: true, holdout_texts: ['绝不存在词二独立留出例'],
    })
    expect(res.meme.matcher).toBeNull()
    expect(res.warnings.length).toBeGreaterThan(0)
    const audits = audit.forMeme(env.db, res.meme.id)
    expect((audits[0].payload as { forced_vector_only: boolean }).forced_vector_only).toBe(true)
  })

  it('force 但 matcher 实际通过时，forced_vector_only 记录 false', async () => {
    const good = { ...entry('正常词'), examples: ['正常词例句'] }
    const res = await runAddEntry(env.db, env.cfg, good, { force: true })
    expect(res.meme.matcher).not.toBeNull()
    const logs = audit.forMeme(env.db, res.meme.id)
    expect((logs[0].payload as { forced_vector_only: boolean }).forced_vector_only).toBe(false)
  })

  it('schema 不合法 → MEME_ENTRY_INVALID', async () => {
    await expect(runAddEntry(env.db, env.cfg, { name: '只有名字' }, { text: '随便' }))
      .rejects.toMatchObject({ code: 'MEME_ENTRY_INVALID' })
  })

  it('失败不烧 ID：编译失败后的成功入库拿到 m_0001', async () => {
    const bad = {
      name: '测试梗', aliases: [], class: 'word' as const,
      card: { gist: 'x', usage: [], taboo: null, register: null, aggression: null },
      examples: ['测试梗例句'],
      // matcher 用纯槽位骨架 → 编译失败 → 严格路径报错
      matcher: { patterns: [{ kind: 'skeleton', tokens: ['<ent>', '<num>'] }], constraints: {} },
    }
    await expect(runAddEntry(env.db, env.cfg, bad, { text: '测试梗' })).rejects.toBeInstanceOf(MemeError)
    const good = {
      name: '好梗', aliases: [], class: 'word' as const,
      card: { gist: '好', usage: [], taboo: null, register: null, aggression: null },
      examples: ['好梗'], matcher: null,
    }
    const res = await runAddEntry(env.db, env.cfg, good, { text: '好梗' })
    expect(res.meme.id).toBe('m_0001')
  })
})

describe('重名守卫 + iterate', () => {
  const entry2 = (gist = '关键局操作变形的自嘲', aliases = ['软脚了']) => ({
    name: '我软脚了', aliases, class: 'word' as const, birth_circa: null,
    card: { gist, usage: ['决胜局我软脚了'], taboo: null, register: '电竞圈', aggression: '低' },
    examples: ['决胜局我软脚了'],
    matcher: { patterns: [{ kind: 'lex', terms: ['我软脚了', ...aliases] }], constraints: {} },
    lineage_parent: null, lineage_mutation: null, notes: null,
  })

  it('同名再 add → MEME_DUPLICATE 引导 iterate', async () => {
    const res = await runAddEntry(env.db, env.cfg, entry2(), { text: '我软脚了' })
    expect(res.meme.id).toBe('m_0001')
    await expect(runAddEntry(env.db, env.cfg, entry2(), { text: '我软脚了' }))
      .rejects.toMatchObject({ code: 'MEME_DUPLICATE' })
  })

  it('iterate 原位修订：id/state 保留，释义变化 → drift 留痕', async () => {
    await runAddEntry(env.db, env.cfg, entry2(), { text: '我软脚了' })
    const before = entries.get(env.db, 'm_0001')!
    const res = await runIterate(env.db, env.cfg, 'm_0001', {
      entry: entry2('修正版释义：不限电竞，泛指关键时刻掉链子', ['软脚了', '脚软了']),
    })
    expect(res.meme.id).toBe('m_0001') // iterate 必须原位更新
    expect(res.meme.state).toBe(before.state)
    expect(res.meme.card.gist.startsWith('修正版释义')).toBe(true)
    expect(res.meme.drift.some((d) => d.evidence === 'iterate'), '释义变化未留 drift').toBe(true)
    expect(res.meme.aliases).toContain('脚软了')
    const logs = env.db.prepare("SELECT action FROM audit_log WHERE meme_id='m_0001' ORDER BY seq").all() as { action: string }[]
    expect(logs.map((r) => r.action)).toEqual(['induct', 'iterate'])
  })

  it('iterate 接受多个 cid，成功后精确收口并审计 closed cids/heads', async () => {
    await runAddEntry(env.db, env.cfg, entry2())
    const c1 = candidates.upsertFromSignal(env.db, {
      head: '脚软了', channel: 'phrase', kind_guess: 'word', usages: [],
      video_pairs: [{ aid: 1, up_mid: 1 }], round_id: 1,
    })
    const c2 = candidates.upsertFromSignal(env.db, {
      head: '我软脚了', channel: 'copy', kind_guess: 'word', usages: [],
      video_pairs: [{ aid: 2, up_mid: 2 }], round_id: 1,
    })
    const res = await runIterate(env.db, env.cfg, 'm_0001', {
      entry: entry2('修订版', ['软脚了', '脚软了']), cids: [c1.cid, c2.cid],
      holdout_texts: ['决胜局我软脚了'],
    })
    expect(res.meme.id).toBe('m_0001')
    expect(candidates.get(env.db, c1.cid)!.state).toBe('inducted')
    expect(candidates.get(env.db, c2.cid)!.state).toBe('inducted')
    const logs = audit.forMeme(env.db, 'm_0001')
    const payload = logs.find((l) => l.action === 'iterate')!.payload as { closed_cids: string[]; closed_heads: string[] }
    expect(payload.closed_cids.sort()).toEqual([c1.cid, c2.cid].sort())
    expect(payload.closed_heads.sort()).toEqual(['脚软了', '我软脚了'].sort())
  })

  it('iterate 证据收集：当前 matcher 在湖中的野外命中文本进入证据包', async () => {
    const { makeMeme, matcher, pattern } = await import('./helpers.ts')
    entries.save(env.db, makeMeme({
      id: 'm_0001', name: '难绷', state: 'observing',
      matcher: matcher([pattern({ kind: 'lex', terms: ['难绷'] })]),
    }))
    seedComments(env.db, ['真的难绷', '难绷时刻', '无关评论'], [901, 902, 903], 1)
    const ev = collectIterateEvidence(env.db, entries.get(env.db, 'm_0001')!)
    const texts = ev.usages.map((u) => u.text)
    expect(texts).toContain('真的难绷')
    expect(texts).toContain('难绷时刻')
    expect(texts).not.toContain('无关评论')
  })
})
