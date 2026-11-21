/** 检索/FTS/呈现/审计修复第二批回归。 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { save as saveMeme } from '../src/entries.ts'
import { makeMeme, matcher, constraints, pattern } from './test-matchers.test.ts'
import { searchFts } from '../src/retrieve/fts.ts'
import { hybridSearch } from '../src/retrieve/fuse.ts'
import { validateAndCompile, MatcherError } from '../src/induct/compileMatcher.ts'
import { MemeError } from '../src/errors.ts'
import * as notes from '../src/notes.ts'
import * as candidates from '../src/candidates.ts'
import { connect, APP_ID } from '../src/db.ts'
import { lookup } from '../src/match/pipeline.ts'
import { renderZones, candDict, candLine, orderKey } from '../src/surf/present.ts'
import { makeCfg, openDb } from './helpers.ts'
import { noEmbed } from './test-matchers.test.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('FTS', () => {
  it('文档已分词，查询按词命中', () => {
    saveMeme(env.db, makeMeme({ id: 'm_0100', name: '华强买瓜', matcher: null }))
    const hits = searchFts(env.db, '华强', 5)
    expect(hits.some(([mid]) => mid === 'm_0100')).toBe(true)
  })

  it('旧版/异构库一律拒收（schema 无迁移路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meme-fgn-'))
    const dbPath = join(dir, 'old.db')
    const sqlite = new DatabaseSync(dbPath)
    sqlite.exec('CREATE TABLE t(x); PRAGMA application_id=0x4D454D45; PRAGMA user_version=3;')
    sqlite.close()
    expect(() => connect(dbPath)).toThrow(MemeError)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('matcher 校验', () => {
  it('纯槽位/空 token 模式被拒（曾编译出匹配一切的正则）', () => {
    const mk = (tokens: string[]) => matcher([pattern({ kind: 'skeleton', tokens })])
    expect(() => validateAndCompile(mk(['<any>']))).toThrow(MatcherError)
    expect(() => validateAndCompile(mk(['<ent>', '<ent>']))).toThrow(MatcherError)
    expect(() => validateAndCompile(mk(['']))).toThrow(MatcherError)
    expect(() => validateAndCompile(matcher([pattern({
      kind: 'interaction', trigger_tokens: [''], response_terms: ['对'],
    })]))).toThrow(MatcherError)
    // 合法模式不受影响
    const spec = validateAndCompile(matcher([pattern({ kind: 'skeleton', tokens: ['一眼', '<ent>'] })]))
    expect(spec.patterns[0].tokens).toEqual(['一眼', '<ent>'])
  })
})

describe('候选呈现', () => {
  it('related 从库重载后不崩溃且排序键稳定', () => {
    saveMeme(env.db, makeMeme({ id: 'm_0101', name: '典', matcher: null }))
    env.db.prepare(
      "INSERT INTO candidates(cid,head,kind_guess,channel,state,first_seen,last_seen,"
      + "evidence_usages,related,created_at,updated_at) VALUES('c_0500','典中典','word','phrase','pending',"
      + "'2026-01-01','2026-01-01','[]','[{\"id\":\"m_0101\",\"type\":\"same_form\",\"score\":0.9}]','2026-01-01','2026-01-01')",
    ).run()
    const cand = candidates.get(env.db, 'c_0500')!
    expect(candLine(cand, new Map([['m_0101', '典']]))).toBeTruthy()
    expect((candDict(cand).related as Array<{ id: string }>)[0].id).toBe('m_0101')
    expect(orderKey(cand)).toEqual(orderKey(candidates.get(env.db, 'c_0500')!)) // 确定性
  })
})

describe('融合检索权重', () => {
  it('fading 减半权重要在排序前施加（D7）', async () => {
    saveMeme(env.db, makeMeme({ id: 'm_0110', name: '独一无二甲', matcher: null }))
    // fading 词条给更强的 FTS 信号（gist 双命中），加权后必须被 active 反超
    saveMeme(env.db, makeMeme({ id: 'm_0111', name: '独一无二乙', state: 'fading', matcher: null }))
    const res = await hybridSearch(env.db, '独一无二', env.cfg.retrieval, { embedder: noEmbed() })
    expect(res[0].meme.id).toBe('m_0110')
  })
})

describe('笔记去重', () => {
  it('去重键含 head：不同词头同内容的悬挂笔记不是重复', () => {
    notes.add(env.db, '同内容', null, '急孝')
    notes.add(env.db, '同内容', null, '急了')
    expect(notes.dedupe(env.db)).toBe(0)
    notes.add(env.db, '同内容', null, '急孝')
    expect(notes.dedupe(env.db)).toBe(1)
  })
})

describe('交互梗 lookup 上下文', () => {
  it('待查文本作为会话末行参与匹配', async () => {
    saveMeme(env.db, makeMeme({
      id: 'm_0121', name: '对答',
      matcher: matcher([pattern({ kind: 'interaction', trigger_terms: ['你说啥'], response_terms: ['对'] })]),
    }))
    // 契约同工具层：lines = [...ctx, text]（末行是待查文本）
    const hits = await lookup(env.db, '对', ['你说啥', '对'], 0.6, noEmbed())
    expect(hits.some((h) => h.meme_id === 'm_0121')).toBe(true) // 修复前：response 去匹配 ctx 行，必然 miss
  })
})

describe('surf 呈现', () => {
  it('判梗参考进呈现（轻强调：视角而非模板）', () => {
    const zones = {
      counts: { new: 0, dynamics: 0, fading: 0, backlog: 0 },
      new_candidates: [], dynamics: [], fading: [],
      backlog_line: 'x', page: 0, has_more: false,
    }
    expect(renderZones(zones, 'footer')).toContain('判梗参考')
  })
})

describe('surf 轮次（存量模式）', () => {
  it('no_fetch 不触网照常呈现', async () => {
    const { runSurf } = await import('../src/surf/run.ts')
    const { fakeFetchRound } = await import('./helpers.ts')
    const r = await runSurf(env.db, env.cfg, {
      noFetch: true, fetch: fakeFetchRound() as never,
    })
    const payload = r.payload as Record<string, unknown>
    expect(payload.counts).toBeDefined()
    expect(r.human).toContain('新候选')
    expect(r.human).toContain('存量模式')
  })

  it('机器输出一次给全量候选；more 翻页照旧', async () => {
    const { runSurf } = await import('../src/surf/run.ts')
    const { fakeFetchRound } = await import('./helpers.ts')
    for (let i = 0; i < 15; i++) {
      candidates.upsertFromSignal(env.db, {
        head: `独特测试词${String(i).padStart(2, '0')}`, channel: 'phrase', kind_guess: 'word',
        usages: [], video_pairs: [{ aid: 9000 + i, up_mid: 0 }], day: '2026-11-09', round_id: 1,
      })
    }
    const full = (await runSurf(env.db, env.cfg, { noFetch: true, full: true, fetch: fakeFetchRound() as never })).payload as Record<string, unknown>
    expect((full.new_candidates_raw as unknown[]).length).toBe(15)
    expect(full.has_more).toBe(false)
    const { kvSet } = await import('../src/db.ts')
    kvSet(env.db, 'surf_page', '0')
    const page2 = (await runSurf(env.db, env.cfg, { noFetch: true, more: true, roundSize: 10, fetch: fakeFetchRound() as never })).payload as Record<string, unknown>
    expect((page2.new_candidates_raw as unknown[]).length).toBe(5) // 第 2 页 = 剩余 5 条
    expect(page2.has_more).toBe(false)
  })

  it('probe 定向探测词原样传给 fetcher', async () => {
    const { runSurf } = await import('../src/surf/run.ts')
    const captured: string[] = []
    const fake = async (_db: unknown, _cfg: unknown, _rid: number, _sess: string, probe: string[]) => {
      captured.push(...probe)
      const { FetchResult } = await import('../src/fetch/sampler.ts')
      const res = new FetchResult()
      res.probed = [...probe]
      return res
    }
    await runSurf(env.db, env.cfg, { probe: ['我记下了', '烧心'], fetch: fake as never })
    expect(captured).toEqual(['我记下了', '烧心'])
  })

  it('野外复查：observing 命中记录 + 动态区反映变化', async () => {
    const { runSurf } = await import('../src/surf/run.ts')
    const { fakeFetchRound } = await import('./helpers.ts')
    saveMeme(env.db, makeMeme({
      id: 'm_0002', name: '绷', state: 'observing',
      matcher: matcher([pattern({ kind: 'lex', terms: ['绷'] })], constraints({ standalone: true })),
    }))
    // runSurf 会开出新一轮（全新库为 round 1），评论灌进同一轮
    const { seedComments } = await import('./helpers.ts')
    seedComments(env.db, ['绷。', '绷不住了。', '我直接绷。'], [401, 402, 403], 1)
    const r = await runSurf(env.db, env.cfg, { noFetch: true, fetch: fakeFetchRound() as never })
    const m2 = (await import('../src/entries.ts')).get(env.db, 'm_0002')!
    expect(m2.stats.last_matched_round === 1 || m2.wild_rounds.length > 0).toBe(true) // 命中已记录
    expect(Array.isArray(r.payload.dynamics_raw)).toBe(true)
  })
})
