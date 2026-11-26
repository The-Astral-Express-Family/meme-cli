/**
 * 每轮日聚合台账：signals 对 phrase_daily / skel_daily / meme_hit_daily 的写入
 * 先查本轮台账，按"新绝对值 − 台账值"的差量入账，再把台账更新为新绝对值。
 * 同一轮重跑（崩溃恢复后重新入账）差量为零，不会记两次；整轮回滚按台账精确扣回。
 * 台账 key 恒为 `业务key\x00day`——一轮只归属一个采集日，回滚可精确定位目标行。
 * bot 进程等不属 surf 轮次的直写不经台账，不受影响。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { tx } from './db.ts'

export type Bucket = 'phrase_daily' | 'skel_daily' | 'meme_hit_daily'

interface Target { table: string; keyCol: string; withVideos: boolean }

const TARGET: Record<Bucket, Target> = {
  phrase_daily: { table: 'phrase_daily', keyCol: 'phrase', withVideos: true },
  skel_daily: { table: 'skel_daily', keyCol: 'skel', withVideos: true },
  meme_hit_daily: { table: 'meme_hit_daily', keyCol: 'meme_id', withVideos: false },
}

interface LedgerRow { cnt: number; videos: number }

function prevOf(db: DatabaseSync, roundId: number, bucket: Bucket, ledgerKey: string): LedgerRow {
  const row = db.prepare('SELECT cnt, videos FROM round_bumps WHERE round_id=? AND bucket=? AND key=?')
    .get(roundId, bucket, ledgerKey) as Row | undefined
  return { cnt: row ? Number(row.cnt) : 0, videos: row ? Number(row.videos) : 0 }
}

/**
 * 按"本轮新绝对值"入账（cnt = 本轮累计出现次数；videos = 本轮跨视频数）。
 * 与旧 bumpDaily 的差异：cnt 从 `cnt+excluded.cnt` 累加改为差量入账——重跑安全。
 * videos 沿用旧 MAX 语义（只增不减），回滚时按台账值扣减并下限 0（近似可接受：
 * 该列仅进呈现，burst/触发判定只读 cnt）。
 */
export function bumpRound(
  db: DatabaseSync, roundId: number, bucket: Bucket, key: string, day: string,
  cnt: number, videos = 0,
): void {
  const t = TARGET[bucket]
  const ledgerKey = `${key}\x00${day}`
  const prev = prevOf(db, roundId, bucket, ledgerKey)
  const dCnt = Math.max(0, cnt) - prev.cnt
  const dVids = Math.max(0, videos) - prev.videos
  // 目标表差量与台账更新必须同事务：进程若死在两条语句之间，会留下没有台账的脏差量
  tx(db, () => {
    if (dCnt !== 0) {
      db.prepare(
        `INSERT INTO ${t.table}(${t.keyCol},day,cnt${t.withVideos ? ',videos' : ''}) `
        + `VALUES(?,?,?${t.withVideos ? ',?' : ''}) `
        + `ON CONFLICT(${t.keyCol},day) DO UPDATE SET cnt=MAX(0, cnt+excluded.cnt)`
        + (t.withVideos
          ? ', videos=CASE WHEN excluded.videos>0 THEN MAX(videos, excluded.videos) ELSE videos END'
          : ''),
      ).run(...(t.withVideos ? [key, day, dCnt, Math.max(dVids, 0)] : [key, day, dCnt]))
    } else if (t.withVideos && dVids > 0) {
      db.prepare(
        `INSERT INTO ${t.table}(${t.keyCol},day,cnt,videos) VALUES(?,?,0,?) `
        + `ON CONFLICT(${t.keyCol},day) DO UPDATE SET videos=MAX(videos, excluded.videos)`,
      ).run(key, day, dVids)
    }
    db.prepare(
      'INSERT INTO round_bumps(round_id,bucket,key,cnt,videos) VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(round_id,bucket,key) DO UPDATE SET cnt=excluded.cnt, videos=excluded.videos',
    ).run(roundId, bucket, ledgerKey, Math.max(0, cnt), Math.max(0, videos))
  })
}

/** 整轮回滚：按台账把该轮差量全部扣回（崩溃半轮恢复用），返回回滚条数并清台账。 */
export function rollbackRound(db: DatabaseSync, roundId: number): number {
  const rows = db.prepare('SELECT bucket, key, cnt, videos FROM round_bumps WHERE round_id=?')
    .all(roundId) as Row[]
  const undo = {
    phrase_daily: db.prepare('UPDATE phrase_daily SET cnt=MAX(0,cnt-?), videos=MAX(0,videos-?) WHERE phrase=? AND day=?'),
    skel_daily: db.prepare('UPDATE skel_daily SET cnt=MAX(0,cnt-?), videos=MAX(0,videos-?) WHERE skel=? AND day=?'),
    meme_hit_daily: db.prepare('UPDATE meme_hit_daily SET cnt=MAX(0,cnt-?) WHERE meme_id=? AND day=?'),
  } as const
  for (const r of rows) {
    const bucket = r.bucket as Bucket
    const i = String(r.key).indexOf('\x00')
    const key = String(r.key).slice(0, i)
    const day = String(r.key).slice(i + 1)
    if (bucket === 'meme_hit_daily') {
      undo.meme_hit_daily.run(Number(r.cnt), key, day)
    } else {
      undo[bucket].run(Number(r.cnt), Number(r.videos), key, day)
    }
  }
  db.prepare('DELETE FROM round_bumps WHERE round_id=?').run(roundId)
  return rows.length
}
