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
import { validateAndCompile, ValueError } from '../src/induct/compileMatcher.ts'
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

  it('v1 存量库（未分词 FTS 文档）升 v2 时自动重建索引', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meme-mig-'))
    const dbPath = join(dir, 'old.db')
    const card = JSON.stringify({ gist: '你这瓜保熟吗' })
    const sqlite = new DatabaseSync(dbPath)
    sqlite.exec(
      'CREATE TABLE memes(id TEXT PRIMARY KEY, name TEXT, aliases TEXT, class TEXT,'
      + 'lineage TEXT, platform TEXT, state TEXT, birth TEXT, matcher TEXT, card TEXT,'
      + 'examples TEXT, drift TEXT, stats TEXT, wild_rounds TEXT, revived_pending INTEGER,'
      + 'created_at TEXT, updated_at TEXT);'
      + "CREATE VIRTUAL TABLE memes_fts USING fts5(meme_id UNINDEXED, name, aliases, gist, examples, tokenize='unicode61');"
      + `INSERT INTO memes VALUES('m_0001','华强买瓜','[]','word','{}','["bilibili"]','observing','{}',NULL,'${card}','[]','[]','{}','[]',0,'x','x');`
      + "INSERT INTO memes_fts VALUES('m_0001','华强买瓜','','你这瓜保熟吗','');" // v1 未分词原文
      + `PRAGMA application_id=${APP_ID};`
      + 'PRAGMA user_version=1;',
    )
    sqlite.close()
    const db = connect(dbPath) // 打开即触发 v1→v2 迁移
    const hits = searchFts(db, '华强', 5)
    expect(hits.some(([mid]) => mid === 'm_0001')).toBe(true)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('matcher 校验', () => {
  it('纯槽位/空 token 模式被拒（曾编译出匹配一切的正则）', () => {
    const mk = (tokens: string[]) => matcher([pattern({ kind: 'skeleton', tokens })])
    expect(() => validateAndCompile(mk(['<any>']))).toThrow(ValueError)
    expect(() => validateAndCompile(mk(['<ent>', '<ent>']))).toThrow(ValueError)
    expect(() => validateAndCompile(mk(['']))).toThrow(ValueError)
    expect(() => validateAndCompile(matcher([pattern({
      kind: 'interaction', trigger_tokens: [''], response_terms: ['对'],
    })]))).toThrow(ValueError)
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
  it('判梗参考进呈现与归纳提示词（轻强调：视角而非模板）', async () => {
    const { SYSTEM } = await import('../src/induct/prompts.ts')
    expect(SYSTEM).toContain('判梗参考')
    expect(SYSTEM).toContain('不是判定模板')
    expect(SYSTEM).toContain('以证据为准')
    const zones = {
      counts: { new: 0, dynamics: 0, fading: 0, backlog: 0 },
      new_candidates: [], dynamics: [], fading: [],
      backlog_line: 'x', page: 0, has_more: false,
    }
    expect(renderZones(zones, 'footer')).toContain('判梗参考')
  })
})

describe('队列不丢行', () => {
  it('预算耗尽时 processQueue 全部重新排队', async () => {
    const budget = await import('../src/induct/budget.ts')
    const { runSurf } = await import('../src/surf/run.ts')
    const { fakeFetchRound } = await import('./helpers.ts')
    env.cfg.induction.daily_call_budget = 0 // 立即触发预算闸门（llm 不会被调用）
    budget.enqueue(env.db, 'c_0001', null)
    budget.enqueue(env.db, 'c_0002', null)
    budget.enqueue(env.db, null, '测试裸文本归纳')
    await runSurf(env.db, env.cfg, { noFetch: true, llm: null, fetch: fakeFetchRound() as never })
    const remaining = (env.db.prepare('SELECT COUNT(*) AS c FROM induction_queue').get() as { c: number }).c
    expect(remaining).toBe(3) // 三行全部还在队里，一行未丢
  })
})

describe('surf 轮次（存量模式）', () => {
  it('no_fetch 不触网照常呈现', async () => {
    const { runSurf } = await import('../src/surf/run.ts')
    const { fakeFetchRound } = await import('./helpers.ts')
    const r = await runSurf(env.db, env.cfg, {
      noFetch: true, llm: null, fetch: fakeFetchRound() as never,
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
    const full = (await runSurf(env.db, env.cfg, { noFetch: true, full: true, llm: null, fetch: fakeFetchRound() as never })).payload as Record<string, unknown>
    expect((full.new_candidates_raw as unknown[]).length).toBe(15)
    expect(full.has_more).toBe(false)
    const { kvSet } = await import('../src/db.ts')
    kvSet(env.db, 'surf_page', '0')
    const page2 = (await runSurf(env.db, env.cfg, { noFetch: true, more: true, roundSize: 10, llm: null, fetch: fakeFetchRound() as never })).payload as Record<string, unknown>
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
    await runSurf(env.db, env.cfg, { probe: ['我记下了', '烧心'], llm: null, fetch: fake as never })
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
    const r = await runSurf(env.db, env.cfg, { noFetch: true, llm: null, fetch: fakeFetchRound() as never })
    const m2 = (await import('../src/entries.ts')).get(env.db, 'm_0002')!
    expect(m2.stats.last_matched_round === 1 || m2.wild_rounds.length > 0).toBe(true) // 命中已记录
    expect(Array.isArray(r.payload.dynamics_raw)).toBe(true)
  })
})
