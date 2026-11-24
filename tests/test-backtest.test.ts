/** backtest 闸门与生命周期状态机。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { runBacktest } from '../src/induct/backtest.ts'
import { CompiledMatcher } from '../src/match/pipeline.ts'
import * as entries from '../src/entries.ts'
import * as lifecycle from '../src/lifecycle.ts'
import { upsertFromSignal, get as getCand } from '../src/candidates.ts'
import { reapLake } from '../src/lake.ts'
import { makeMeme, matcher, constraints, pattern } from './test-matchers.test.ts'
import { makeCfg, openDb, seedComments, type Row } from './helpers.ts'
import type { UsageSample } from '../src/models.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg({ lifecycle: { trigger_videos: 5, trigger_videos_alt: 8 } })
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

  it('显式留出过滤空文本时同步过滤 ctx', () => {
    const m = makeMeme({
      id: 'm_0121', name: '对答', class: 'interaction',
      matcher: matcher([pattern({ kind: 'interaction', trigger_terms: ['你说啥'], response_terms: ['对'] })]),
    })
    const res = runBacktest(env.db, m, new CompiledMatcher(m), [], {
      holdout_texts: ['', '对'], holdout_ctx: [['错误上下文', ''], ['你说啥', '对']], negatives: 10,
    })
    expect(res.holdout_size).toBe(1)
    expect(res.hits).toBe(1)
  })

  it('交互梗无有效触发上下文的样本不进留出分母', () => {
    const m = makeMeme({
      id: 'm_0122', name: '对答', class: 'interaction',
      matcher: matcher([pattern({ kind: 'interaction', trigger_terms: ['你说啥'], response_terms: ['对'] })]),
    })
    const res = runBacktest(env.db, m, new CompiledMatcher(m), [], {
      holdout_texts: ['孤立回应', '上句：你说啥 本句：对'], negatives: 10,
    })
    expect(res.holdout_size).toBe(1)
    expect(res.hits).toBe(1)
    expect(res.missed).toEqual([])
  })

  it('已知正例与留出文本都不进入负例，避免正负例重叠', () => {
    const m = makeMeme({
      id: 'm_0123', name: '留出测试',
      matcher: matcher([pattern({ kind: 'lex', terms: ['样本'] })]),
    })
    seedComments(env.db, [
      ...Array.from({ length: 300 }, (_, i) => `普通评论第${i}条，今天天气不错`),
      '样本留出文本', '样本已知正例但未留出',
    ], undefined, 1)
    const res = runBacktest(env.db, m, new CompiledMatcher(m), ['样本留出文本', '样本已知正例但未留出'], {
      holdout_texts: ['样本留出文本'], negatives: 300, seed: 42,
    })
    expect(res.holdout_size).toBe(1)
    expect(res.negatives).toBe(300)
    expect(res.false_positives).toBe(0)
    expect(res.false_hits).not.toContain('样本留出文本')
    expect(res.false_hits).not.toContain('样本已知正例但未留出')
  })
})

describe('候选触发门', () => {
  /** 直建候选不经信号层，日聚合账本需自备（体量线读终身出现次数）。 */
  const ledger = (head: string, cnt: number): void => {
    env.db.prepare('INSERT OR REPLACE INTO phrase_daily(phrase,day,cnt,videos) VALUES(?,?,?,?)')
      .run(head, new Date().toISOString().slice(0, 10), cnt, 1)
  }

  it('结构通道走 trigger_videos_alt 体量线（copy/skeleton/image = 8 次）', async () => {
    const cand = upsertFromSignal(env.db, {
      head: '绷不住了', channel: 'copy', kind_guess: 'word',
      usages: [
        { text: '绷不住了', aid: 1, rpid: 1, root: 0, parent: 0, mid: 0, ctime: 0, chain: false },
        { text: '绷不住了', aid: 2, rpid: 2, root: 0, parent: 0, mid: 0, ctime: 0, chain: false },
      ],
      video_pairs: [{ aid: 1, up_mid: 1 }, { aid: 2, up_mid: 2 }], round_id: 1,
    })
    expect(await lifecycle.candidateShouldTrigger(env.db, cand, env.cfg.lifecycle, env.cfg)).toBe(false) // 存活轮数不足（surfs_seen=1）
    let cur = cand
    for (let aid = 2; aid <= 17; aid++) {
      cur = upsertFromSignal(env.db, {
        head: '绷不住了', channel: 'copy', kind_guess: 'word', usages: [],
        video_pairs: [{ aid, up_mid: aid }], round_id: 2,
      })
    }
    ledger('绷不住了', 10)
    expect(await lifecycle.candidateShouldTrigger(env.db, cur, env.cfg.lifecycle, env.cfg)).toBe(true)
  })

  it('词类走 trigger_videos 体量线（5 次），累计轮数不限', async () => {
    // 词类候选出现 ≥5 次即达标——不论证据集中在头两轮还是缓慢积累
    let cur = upsertFromSignal(env.db, {
      head: '没绷住', channel: 'phrase', kind_guess: 'word',
      usages: [{ text: '没绷住', aid: 1, rpid: 1, root: 0, parent: 0, mid: 0, ctime: 0, chain: false }],
      video_pairs: [{ aid: 1, up_mid: 1 }], round_id: 1,
    })
    for (let aid = 2; aid <= 6; aid++) {
      cur = upsertFromSignal(env.db, {
        head: '没绷住', channel: 'phrase', kind_guess: 'word', usages: [{ text: '没绷住', aid, rpid: aid, root: 0, parent: 0, mid: 0, ctime: 0, chain: false }],
        video_pairs: [{ aid, up_mid: aid }], round_id: aid % 3 + 2,
      })
    }
    ledger('没绷住', 6)
    expect(await lifecycle.candidateShouldTrigger(env.db, cur, env.cfg.lifecycle, env.cfg)).toBe(true)
  })

  it('无自动过期：末次证据超存活窗口的候选休眠（不出队、不标 rejected），新证据唤醒', async () => {
    seedComments(env.db, ['我记下了', '我记下了', '我记下了'], [811, 812, 813], 1)
    await (await import('../src/detect/signals.ts')).updateSignals(env.db, env.cfg, 1)
    const cands = await import('../src/candidates.ts')
    const cand = cands.byHead(env.db, '我记下了')
    expect(cand).not.toBeNull()
    const summary = await lifecycle.transitionCandidates(env.db, env.cfg, 1 + env.cfg.lifecycle.surf_survive_rounds)
    expect(summary.triggered).not.toContain(cand!.cid) // 休眠：跳过评估
    expect(cands.get(env.db, cand!.cid)!.state).toBe('pending') // 不出队、不标 rejected
  })
})

describe('部署生命周期', () => {
  it('收割：休眠且从未达体量线的候选删除（低价值早清）；达线的保留到 28 天', async () => {
    const low = upsertFromSignal(env.db, {
      head: '随口一说', channel: 'phrase', kind_guess: 'word', usages: [],
      video_pairs: [{ aid: 1, up_mid: 1 }, { aid: 2, up_mid: 2 }], round_id: 1,
    })
    let kept = upsertFromSignal(env.db, {
      head: '没绷住', channel: 'phrase', kind_guess: 'word', usages: [],
      video_pairs: [{ aid: 11, up_mid: 1 }], round_id: 1,
    })
    for (let aid = 12; aid <= 16; aid++) {
      kept = upsertFromSignal(env.db, {
        head: '没绷住', channel: 'phrase', kind_guess: 'word', usages: [],
        video_pairs: [{ aid, up_mid: aid }], round_id: 2,
      })
    }
    env.db.prepare('INSERT OR REPLACE INTO phrase_daily(phrase,day,cnt,videos) VALUES(?,?,?,?)')
      .run('没绷住', new Date().toISOString().slice(0, 10), 10, 5)
    const reap = lifecycle.reapCandidates(env.db, env.cfg.lifecycle, 2 + env.cfg.lifecycle.surf_survive_rounds)
    expect(reap.low_value).toBe(1)
    expect(reap.dead).toBe(0) // last_seen 都是新鲜的，28 天死亡不触发
    expect(getCand(env.db, low.cid)).toBeNull()
    expect(getCand(env.db, kept.cid)).not.toBeNull()
  })

  it('收割：末次证据超 28 天的候选死亡（pending 与 triggered 一视同仁），inducted 豁免', async () => {
    const old = new Date(Date.now() - 29 * 86400_000).toISOString()
    const mk = (head: string, state: string): string => {
      const c = upsertFromSignal(env.db, {
        head, channel: 'phrase', kind_guess: 'word', usages: [],
        video_pairs: [{ aid: 1, up_mid: 1 }], round_id: 1,
      })
      env.db.prepare('UPDATE candidates SET state=?, last_seen=? WHERE cid=?').run(state, old, c.cid)
      return c.cid
    }
    const deadPending = mk('久违了', 'pending')
    const deadTriggered = mk('还在传', 'triggered')
    const keptInducted = mk('已收录', 'inducted')
    const reap = lifecycle.reapCandidates(env.db, env.cfg.lifecycle, 1)
    expect(reap.dead).toBe(2)
    expect(getCand(env.db, deadPending)).toBeNull()
    expect(getCand(env.db, deadTriggered)).toBeNull()
    expect(getCand(env.db, keptInducted)).not.toBeNull() // inducted 不在收割范围
  })

  it('原始湖留存：retention=0 不清理（开发期）；retention=7 删除旧轮', async () => {
    for (let rid = 1; rid <= 10; rid++) {
      seedComments(env.db, [`第${rid}轮评论甲`, `第${rid}轮评论乙`, `第${rid}轮评论丙`], undefined, rid, 0, 60000 + rid * 100)
    }
    expect(reapLake(env.db, 10, 0)).toBe(0)
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM lake_comments').get() as Row).c).toBe(30)
    expect(reapLake(env.db, 10, 7)).toBe(9) // 删除第 1-3 轮
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM lake_comments').get() as Row).c).toBe(21)
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

  it('衰减：active → fading → tombstone（观测日口径，空档日不补零）', () => {
    const m = makeMeme({ id: 'm_0020', name: '过气梗', state: 'active' })
    entries.save(env.db, m)
    const today = new Date()
    const iso = (d: number) => new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10)
    // 90 天窗口：第 60~31 天前每天 10 次命中且有采集；近 14 天有采集但零命中
    // （观测日口径：均值只数有采集的日子，不再被日历空档补零压低）
    const ins = env.db.prepare('INSERT OR REPLACE INTO meme_hit_daily VALUES(?,?,?)')
    const run = env.db.prepare('INSERT INTO surf_runs(started_at, fetched) VALUES(?, 1)')
    for (let d = 60; d > 30; d--) {
      ins.run('m_0020', iso(d), 10)
      run.run(`${iso(d)}T12:00:00`)
    }
    for (let d = 13; d >= 0; d--) run.run(`${iso(d)}T12:00:00`)
    const changes = lifecycle.checkFade(env.db, env.cfg.lifecycle)
    expect(changes.some((c) => c.id === 'm_0020' && c.to === 'fading')).toBe(true)
    expect(entries.get(env.db, 'm_0020')!.state).toBe('fading')
    lifecycle.checkFade(env.db, env.cfg.lifecycle)
    expect(entries.get(env.db, 'm_0020')!.state).toBe('tombstone') // 持续衰减至近零
  })

  it('假衰减修复：采集稀疏（长期未 surf）不压低均值', () => {
    const m = makeMeme({ id: 'm_0021', name: '长青梗', state: 'active' })
    entries.save(env.db, m)
    const today = new Date()
    const iso = (d: number) => new Date(today.getTime() - d * 86400_000).toISOString().slice(0, 10)
    const ins = env.db.prepare('INSERT OR REPLACE INTO meme_hit_daily VALUES(?,?,?)')
    const run = env.db.prepare('INSERT INTO surf_runs(started_at, fetched) VALUES(?, 1)')
    // 峰值期（第 30~24 天前）每天 10 次；此后只在第 3 天前采集过一次，命中 9 次
    // ——日历口径会把空档记 0 压低均值造成假衰减；观测日口径下 9/10 不触发衰减
    for (let d = 30; d > 23; d--) {
      ins.run('m_0021', iso(d), 10)
      run.run(`${iso(d)}T12:00:00`)
    }
    ins.run('m_0021', iso(3), 9)
    run.run(`${iso(3)}T12:00:00`)
    const changes = lifecycle.checkFade(env.db, env.cfg.lifecycle)
    expect(changes.some((c) => c.id === 'm_0021')).toBe(false)
    expect(entries.get(env.db, 'm_0021')!.state).toBe('active')
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

describe('usage sample 类型', () => {
  it('UsageSample roundtrip', () => {
    const u: UsageSample = { text: 'x', aid: 1, rpid: 2, root: 0, parent: 0, mid: 0, ctime: 0, chain: true }
    expect(u.chain).toBe(true)
  })
})
