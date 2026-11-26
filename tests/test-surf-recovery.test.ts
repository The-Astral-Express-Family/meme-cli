/** surf 单飞锁、半轮恢复与轮次台账（差量入账/回滚）回归。 */
import { describe, expect, it } from 'vitest'
import { kvGet } from '../src/db.ts'
import { nextId } from '../src/ids.ts'
import { bumpRound, rollbackRound } from '../src/ledger.ts'
import { runSurf } from '../src/surf/run.ts'
import { makeCfg, openDb, seedComments, fakeFetchRound } from './helpers.ts'

const today = (): string => new Date().toISOString().slice(0, 10)

describe('原子 ID 与轮次台账', () => {
  it('nextId 事务外连续分配不重号（单条 upsert+RETURNING 原子分配）', () => {
    const { cfg } = makeCfg()
    const db = openDb(cfg)
    const ids = new Set(Array.from({ length: 50 }, () => nextId(db, 'c')))
    expect(ids.size).toBe(50)
    expect(nextId(db, 'c')).toBe('c_0051')
  })

  it('bumpRound 同轮重跑按差量入账不双计，跨轮正常累加', () => {
    const { cfg } = makeCfg()
    const db = openDb(cfg)
    bumpRound(db, 1, 'phrase_daily', '没绷住', '2026-11-26', 5, 2)
    bumpRound(db, 1, 'phrase_daily', '没绷住', '2026-11-26', 5, 2) // 同轮重跑：绝对值不变 → 差量 0
    const row = db.prepare("SELECT cnt, videos FROM phrase_daily WHERE phrase='没绷住'").get() as { cnt: number; videos: number }
    expect(row.cnt).toBe(5)
    expect(row.videos).toBe(2)
    bumpRound(db, 2, 'phrase_daily', '没绷住', '2026-11-27', 3, 1)
    const total = db.prepare("SELECT SUM(cnt) AS s FROM phrase_daily WHERE phrase='没绷住'").get() as { s: number }
    expect(total.s).toBe(8)
  })

  it('rollbackRound 按台账精确扣回并清台账', () => {
    const { cfg } = makeCfg()
    const db = openDb(cfg)
    bumpRound(db, 7, 'phrase_daily', '爆了', today(), 4, 2)
    bumpRound(db, 7, 'meme_hit_daily', 'm_0001', today(), 3)
    expect(rollbackRound(db, 7)).toBe(2)
    const phrase = db.prepare("SELECT COALESCE(SUM(cnt),0) AS s FROM phrase_daily WHERE phrase='爆了'").get() as { s: number }
    const hit = db.prepare('SELECT COALESCE(SUM(cnt),0) AS s FROM meme_hit_daily').get() as { s: number }
    expect(phrase.s).toBe(0)
    expect(hit.s).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM round_bumps').get() as { c: number }).c).toBe(0)
  })
})

describe('surf 单飞锁与半轮恢复', () => {
  it('持锁中的 surf 拒绝并发第二轮（MEME_SURF_BUSY），结束后锁释放', async () => {
    const { cfg } = makeCfg()
    const db = openDb(cfg)
    let releaseFetch!: () => void
    const gate = new Promise<void>((r) => { releaseFetch = r })
    const slowFetch = async () => {
      await gate
      return { new_videos: 0, new_comments: 0, degraded: false, reason: null, probed: [], hot_keywords: [] }
    }
    const first = runSurf(db, cfg, { fetch: slowFetch as never })
    await new Promise((r) => setTimeout(r, 20)) // 让第一轮先拿到锁
    await expect(runSurf(db, cfg, { noFetch: true, fetch: fakeFetchRound() as never }))
      .rejects.toMatchObject({ code: 'MEME_SURF_BUSY' })
    releaseFetch()
    await first
    expect(kvGet(db, 'surf_lock')).toBeNull()
    // 锁释放后可正常开新一轮
    await expect(runSurf(db, cfg, { noFetch: true, fetch: fakeFetchRound() as never })).resolves.toBeDefined()
  })

  it('崩溃遗留的 running 半轮被恢复：回滚台账、评论退回未入轮、标记 failed 并被新一轮重新认领', async () => {
    const { cfg } = makeCfg()
    const db = openDb(cfg)
    // 参照库：同样 3 条评论走一遍干净 surf，得到"正确"的日聚合值
    const { cfg: refCfg } = makeCfg()
    const refDb = openDb(refCfg)
    for (const target of [db, refDb]) {
      // 伪造一个上一进程留下的半轮：running 状态 + 评论已入轮 + 脏日聚合（仅主库）
      if (target === db) {
        target.prepare("INSERT INTO surf_runs(round_id, started_at, fetched, status) VALUES(888, ?, 1, 'running')")
          .run(new Date().toISOString())
        // 半轮崩溃现场：脏值已入日聚合，台账还在（bumpRound 同事务写入，两者不会分叉）
        bumpRound(target, 888, 'phrase_daily', '没绷住', today(), 99, 3)
      }
      seedComments(target, ['没绷住', '没绷住哈哈', '这波没绷住'], [11, 11, 12], target === db ? 888 : 0, 0, 91000)
    }
    const dirty = (db.prepare("SELECT cnt FROM phrase_daily WHERE phrase='没绷住'").get() as { cnt: number }).cnt
    expect(dirty).toBe(99)

    const out = await runSurf(db, cfg, { noFetch: true, fetch: fakeFetchRound() as never })
    await runSurf(refDb, refCfg, { noFetch: true, fetch: fakeFetchRound() as never })
    const payload = out.payload as { recovered_rounds: number[]; claimed: number }
    expect(payload.recovered_rounds).toEqual([888])
    expect((db.prepare('SELECT status FROM surf_runs WHERE round_id=888').get() as { status: string }).status).toBe('failed')
    // 脏值被回滚后按新账本重新入账，与干净参照库完全一致
    const fixed = (db.prepare("SELECT cnt FROM phrase_daily WHERE phrase='没绷住'").get() as { cnt: number }).cnt
    const expected = (refDb.prepare("SELECT cnt FROM phrase_daily WHERE phrase='没绷住'").get() as { cnt: number }).cnt
    expect(fixed).toBe(expected)
    // 崩溃轮的评论已并入新轮
    expect(payload.claimed).toBeGreaterThanOrEqual(3)
    expect((db.prepare('SELECT COUNT(*) AS c FROM round_bumps WHERE round_id=888').get() as { c: number }).c).toBe(0)
  })
})
