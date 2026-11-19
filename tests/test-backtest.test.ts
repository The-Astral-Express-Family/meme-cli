/** backtest 闸门与生命周期状态机。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runBacktest } from '../src/induct/backtest.ts'
import { CompiledMatcher } from '../src/match/pipeline.ts'
import * as entries from '../src/entries.ts'
import * as lifecycle from '../src/lifecycle.ts'
import { upsertFromSignal } from '../src/candidates.ts'
import { makeMeme, matcher, constraints, pattern } from './test-matchers.test.ts'
import { makeCfg, openDb, seedComments } from './helpers.ts'
import type { UsageSample } from '../src/models.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('backtest 闸门', () => {
  it('好 matcher：留出命中 ≥0.7、负例误报 ≤0.02', () => {
    const m = makeMeme({
      id: 'm_0001', name: '一眼X鉴定为Y', class: 'formula',
      matcher: matcher([pattern({ kind: 'skeleton', tokens: ['一眼', '<ent>', '鉴定为', '<ent>'] })]),
    })
    const positives = Array.from({ length: 14 }, (_, i) => `一眼${i}鉴定为${i}玩家`)
    seedComments(env.db, Array.from({ length: 300 }, (_, i) => `普通评论第${i}条，今天天气不错`), undefined, 1)
    const res = runBacktest(env.db, m, new CompiledMatcher(m), positives, { min_hit: 0.7, max_fp: 0.02, negatives: 200 })
    expect(res.passed).toBe(true)
    expect(res.hit_rate).toBeGreaterThanOrEqual(0.7)
    expect(res.fp_rate).toBeLessThanOrEqual(0.02)
  })

  it('宽 matcher（泛用虚词）必误报且收集样本', () => {
    const m = makeMeme({
      id: 'm_0002', name: '太宽了',
      matcher: matcher([pattern({ kind: 'lex', terms: ['的'] })]),
    })
    seedComments(env.db, Array.from({ length: 300 }, (_, i) => `这是第${i}条很普通很普通的评论`), undefined, 1)
    const res = runBacktest(env.db, m, new CompiledMatcher(m), ['我的的看法', '你的意思'], {
      min_hit: 0.7, max_fp: 0.02, negatives: 200,
    })
    expect(res.passed).toBe(false)
    expect(res.false_hits.length).toBeGreaterThan(0) // 误报样本被收集（修订轮的输入）
  })

  it('交互梗 tier 3 计入命中（对话式例句拆 ctx）', () => {
    const m = makeMeme({
      id: 'm_0120', name: '对答',
      matcher: matcher([pattern({ kind: 'interaction', trigger_terms: ['你说啥'], response_terms: ['对'] })]),
    })
    const res = runBacktest(env.db, m, new CompiledMatcher(m), [], {
      holdout_texts: ['对'], holdout_ctx: [['你说啥', '对']], min_hit: 0.7, max_fp: 0.02, negatives: 50,
    })
    expect(res.hits).toBe(1)
    expect(res.hit_rate).toBe(1)
  })
})

describe('候选触发门', () => {
  it('视频数走 wide 通道', () => {
    const cand = upsertFromSignal(env.db, {
      head: '绷', channel: 'phrase', kind_guess: 'word',
      usages: [{ text: '绷不住了', aid: 1, rpid: 1, root: 0, parent: 0, mid: 0, ctime: 0, chain: false }],
      video_pairs: [{ aid: 1, up_mid: 1 }], round_id: 1,
    })
    expect(lifecycle.candidateShouldTrigger(cand, env.cfg.lifecycle)).toBe(false) // 单视频不足
    let cur = cand
    for (let aid = 2; aid <= 17; aid++) {
      cur = upsertFromSignal(env.db, {
        head: '绷', channel: 'phrase', kind_guess: 'word', usages: [],
        video_pairs: [{ aid, up_mid: aid }], round_id: 2,
      })
    }
    expect(cur.distinct_videos).toBeGreaterThanOrEqual(env.cfg.lifecycle.trigger_videos_alt)
    expect(lifecycle.candidateShouldTrigger(cur, env.cfg.lifecycle)).toBe(true)
  })

  it('单轮候选也过期（pending 队列只进不出的病灶）', async () => {
    seedComments(env.db, ['我记下了', '我记下了', '我记下了'], [811, 812, 813], 1)
    await (await import('../src/detect/signals.ts')).updateSignals(env.db, env.cfg, 1)
    const cand = (await import('../src/candidates.ts')).byHead(env.db, '我记下了')
    expect(cand).not.toBeNull()
    const summary = lifecycle.transitionCandidates(env.db, env.cfg.lifecycle, 1 + env.cfg.lifecycle.candidate_expire_rounds)
    expect(summary.expired).toContain(cand!.cid)
  })
})

describe('词条状态机', () => {
  it('observing 连续野外命中 → active', () => {
    const m = makeMeme({
      id: 'm_0010', name: '急',
      matcher: matcher([pattern({ kind: 'lex', terms: ['急'] })], constraints({ standalone: true })),
    })
    entries.save(env.db, m)
    const day = new Date().toISOString().slice(0, 10)
    lifecycle.noteWildMatch(env.db, m, 1, day, 3, env.cfg.lifecycle.promote_rounds)
    expect(entries.get(env.db, 'm_0010')!.state).toBe('observing') // 1 轮不够
    lifecycle.noteWildMatch(env.db, entries.get(env.db, 'm_0010')!, 2, day, 2, env.cfg.lifecycle.promote_rounds)
    expect(entries.get(env.db, 'm_0010')!.state).toBe('active') // 连续 2 轮 → 升格
  })

  it('衰减：active → fading → tombstone', () => {
    const m = makeMeme({ id: 'm_0020', name: '过气梗', state: 'active' })
    entries.save(env.db, m)
    const today = new Date()
    const iso = (d: number) => new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10)
    // 90 天窗口：第 60~31 天前每天 10 次，近 30 天归零
    const ins = env.db.prepare('INSERT OR REPLACE INTO meme_hit_daily VALUES(?,?,?)')
    for (let d = 60; d > 30; d--) ins.run('m_0020', iso(d), 10)
    const changes = lifecycle.checkFade(env.db, env.cfg.lifecycle)
    expect(changes.some((c) => c.id === 'm_0020' && c.to === 'fading')).toBe(true)
    expect(entries.get(env.db, 'm_0020')!.state).toBe('fading')
    lifecycle.checkFade(env.db, env.cfg.lifecycle)
    expect(entries.get(env.db, 'm_0020')!.state).toBe('tombstone') // 持续衰减至近零
  })

  it('复活流：revive → 最小卡 → revived_pending 不塌缩', async () => {
    const m = makeMeme({ id: 'm_0030', name: '考古梗', state: 'tombstone' })
    entries.save(env.db, m)
    const m2 = lifecycle.revive(env.db, entries.get(env.db, 'm_0030')!, 'edit', '野外重现')
    expect(m2.state).toBe('active')
    expect(m2.revived_pending).toBe(1)
    const { card } = await import('../src/render/cards.ts')
    const [, d] = card(entries.get(env.db, 'm_0030')!) // 第一次 show → 最小卡
    expect(d.minimal).toBe(true)
    // int 不塌缩（bool 下二次确认永远走不到）
    const m3 = entries.get(env.db, 'm_0030')!
    m3.revived_pending = 2
    entries.save(env.db, m3)
    expect(entries.get(env.db, 'm_0030')!.revived_pending).toBe(2)
  })
})

describe('候选 reject 幂等', () => {
  it('已出队候选重复 reject 不报错；不存在才报错', async () => {
    seedComments(env.db, ['我记下了', '我记下了', '我记下了'], [1201, 1202, 1203], 1)
    await (await import('../src/detect/signals.ts')).updateSignals(env.db, env.cfg, 1)
    const cand = (await import('../src/candidates.ts')).allActive(env.db)[0]
    const cands = await import('../src/candidates.ts')
    expect(cands.reject(env.db, cand.cid)).toBe(true)
    expect(cands.reject(env.db, cand.cid)).toBe(false) // 幂等
    expect(() => cands.reject(env.db, 'c_9999')).toThrow()
  })
})

describe('usage sample 类型', () => {
  it('UsageSample roundtrip', () => {
    const u: UsageSample = { text: 'x', aid: 1, rpid: 2, root: 0, parent: 0, mid: 0, ctime: 0, chain: true }
    expect(u.chain).toBe(true)
  })
})
