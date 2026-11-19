/** add 归纳流（假 LLM）：triage、解析、修复、backtest 修订、降级、预算排队、entry 路径。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { extractJson, runAdd, runAddEntry, runIterate, collectIterateEvidence } from '../src/induct/inductor.ts'
import { MemeError } from '../src/errors.ts'
import * as audit from '../src/audit.ts'
import * as entries from '../src/entries.ts'
import * as candidates from '../src/candidates.ts'
import { FakeLLM, makeCfg, openDb, seedComments } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

const GOOD_OUTPUT = JSON.stringify({
  name: '典',
  aliases: ['典中典', '太典了'],
  class: 'word',
  birth_circa: '2021',
  card: {
    gist: '单字反讽"经典"，嘲讽对方发言陈旧套路化',
    usage: ['这波啊，这波是典', '典中典'],
    taboo: '对方真诚分享时用会显得刻薄', register: '泛B站', aggression: '中',
  },
  examples: ['这就是典中典吧', '典，太典了'],
  matcher: {
    patterns: [{ kind: 'lex', terms: ['典', '典中典', '太典了'] }],
    constraints: { standalone: false, forbid_inner: true, forbid_context: ['古典', '经典'], require_context: [] },
  },
  lineage_parent: null, lineage_mutation: null, notes: null,
})

describe('extractJson', () => {
  it('围栏与裸 JSON 均可提取', () => {
    expect(extractJson(`前置说明\n\`\`\`json\n${GOOD_OUTPUT}\n\`\`\`\n后记`).name).toBe('典')
    expect(extractJson(GOOD_OUTPUT).name).toBe('典')
  })
})

describe('LLM 路径 add', () => {
  it('裸文本 happy path：入库 observing + 审计', async () => {
    seedComments(env.db, Array.from({ length: 300 }, (_, i) => `完全无关的普通评论${i}`), undefined, 1)
    const llm = new FakeLLM(['```json\n' + GOOD_OUTPUT + '\n```'])
    const res = await runAdd(env.db, env.cfg, { text: '典中典了属于是', ctx: '游戏区热评', llm })
    expect(res.meme.id.startsWith('m_')).toBe(true)
    expect(res.meme.state).toBe('observing')
    expect(res.meme.matcher).not.toBeNull()
    expect(res.backtest).not.toBeNull()
    expect(res.backtest!.passed || res.backtest!.fp_rate <= 0.02).toBe(true)
    const logs = audit.forMeme(env.db, res.meme.id)
    expect(logs.some((a) => a.action === 'induct')).toBe(true)
  })

  it('坏 JSON 触发修复轮', async () => {
    const llm = new FakeLLM(['这不是JSON', '```json\n' + GOOD_OUTPUT + '\n```'])
    const res = await runAdd(env.db, env.cfg, { text: '典', llm })
    expect(res.meme.name).toBe('典')
    expect(llm.calls).toHaveLength(2) // 修复轮发生了
  })

  it('backtest 不达标 → 纯向量降级 + 警告', async () => {
    const wide = JSON.stringify({
      name: '泛词梗', aliases: [], class: 'word', birth_circa: null,
      card: { gist: 'x', usage: [], taboo: null, register: null, aggression: '低' },
      examples: ['哈哈出的'],
      matcher: { patterns: [{ kind: 'lex', terms: ['的'] }], constraints: {} },
    })
    seedComments(env.db, Array.from({ length: 300 }, (_, i) => `普通但是的评论${i}`), undefined, 1)
    const llm = new FakeLLM(['```json\n' + wide + '\n```', '```json\n' + wide + '\n```']) // 原始 + 修订轮仍然宽
    const res = await runAdd(env.db, env.cfg, { text: '的', llm })
    expect(res.meme.matcher).toBeNull() // backtest 未达标 → 纯向量
    expect(res.matcher_degraded).toBe(true)
    expect(res.warnings.some((w) => w.includes('纯向量'))).toBe(true)
  })

  it('预算耗尽 → 排队', async () => {
    const budget = await import('../src/induct/budget.ts')
    env.cfg.induction.daily_call_budget = 1
    budget.spend(env.db, 10 ** 9) // 耗尽预算
    await expect(runAdd(env.db, env.cfg, { text: '典', llm: new FakeLLM([]) }))
      .rejects.toMatchObject({ code: 'MEME_BUDGET_EXCEEDED' })
    const n = (env.db.prepare('SELECT COUNT(*) AS c FROM induction_queue').get() as { c: number }).c
    expect(n).toBe(1)
  })
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

describe('entry 路径（操作员亲写词条）', () => {
  it('零外部 LLM，闸门全保留；审计 model=operator；候选收口 inducted', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const res = await runAddEntry(env.db, env.cfg, entry(), { cid })
    expect(res.model).toBe('operator')
    expect(res.meme.matcher).not.toBeNull()
    expect(res.backtest?.passed).toBe(true)
    expect(entries.get(env.db, res.meme.id)).not.toBeNull()
    expect(candidates.get(env.db, cid)!.state).toBe('inducted')
    const audits = audit.forMeme(env.db, res.meme.id)
    expect(audits.length).toBeGreaterThan(0)
    expect((audits[0].payload as { model: string }).model).toBe('operator')
  })

  it('backtest 未达标：报 MEME_BACKTEST_FAIL 附样例；词条不入库', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const bad = entry('绝不存在词')
    bad.matcher = { patterns: [{ kind: 'lex', terms: ['绝不存在的词'] }], constraints: {} }
    await expect(runAddEntry(env.db, env.cfg, bad, { cid })).rejects.toMatchObject({ code: 'MEME_BACKTEST_FAIL' })
    expect(entries.get(env.db, 'm_0001')).toBeNull() // 未入库
    expect(candidates.get(env.db, cid)!.state).not.toBe('inducted')
  })

  it('force：闸门不过仍入库（纯向量降级），进审计与警告', async () => {
    const cid = seedCandidateWithEvidence(env.db)
    const bad = entry('绝不存在词二')
    bad.matcher = { patterns: [{ kind: 'lex', terms: ['绝不存在的词二'] }], constraints: {} }
    const res = await runAddEntry(env.db, env.cfg, bad, { cid, force: true })
    expect(res.meme.matcher).toBeNull()
    expect(res.warnings.length).toBeGreaterThan(0)
    const audits = audit.forMeme(env.db, res.meme.id)
    expect((audits[0].payload as { forced_vector_only: boolean }).forced_vector_only).toBe(true)
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

  it('iterate 证据收集：当前 matcher 在湖中的野外命中文本进入证据包', async () => {
    const { makeMeme, matcher, pattern } = await import('./test-matchers.test.ts')
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
