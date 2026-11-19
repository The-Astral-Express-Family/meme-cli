/** 候选队列：跨 surf 轮次持续累积证据。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { nextId } from './ids.ts'
import { CandidateSchema, type Candidate, type UsageSample, nowIso, todayIso } from './models.ts'

export interface VideoPair { aid: number; up_mid: number }

function fromRow(row: Row): Candidate {
  return CandidateSchema.parse({
    cid: row.cid,
    head: row.head,
    kind_guess: row.kind_guess,
    channel: row.channel,
    state: row.state,
    z_score: row.z_score ?? null,
    distinct_videos: row.distinct_videos,
    distinct_ups: row.distinct_ups,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    surfs_seen: row.surfs_seen,
    last_round: row.last_round,
    evidence_usages: JSON.parse(row.evidence_usages || '[]'),
    related: JSON.parse(row.related || '[]'),
    provenance: row.provenance,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

/**
 * 信号通道写入：不存在则建候选，存在则合流证据。返回最新候选。
 * kind 只升不降：回复复读（interaction 证据）可以升级 word 预判，反之不降级。
 */
export function upsertFromSignal(
  db: DatabaseSync,
  opts: {
    head: string
    channel: string
    kind_guess: string
    usages: UsageSample[]
    video_pairs: VideoPair[]
    day?: string
    round_id?: number
  },
): Candidate {
  const day = opts.day ?? todayIso()
  const roundId = opts.round_id ?? 0
  let row = db.prepare('SELECT * FROM candidates WHERE head=? AND channel=?')
    .get(opts.head, opts.channel) as Row | undefined
  const ts = nowIso()
  if (!row) {
    const cid = nextId(db, 'c')
    db.prepare(
      'INSERT INTO candidates(cid,head,kind_guess,channel,state,first_seen,last_seen,'
      + 'evidence_usages,related,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(cid, opts.head, opts.kind_guess, opts.channel, 'pending', ts, ts, '[]', '[]', ts, ts)
    row = db.prepare('SELECT * FROM candidates WHERE cid=?').get(cid) as Row
  } else if (row.state === 'rejected') {
    // 拒绝不是永刑：新浪再来 = 新证据，重开候选（显式跳过只代表当时的判断）
    db.prepare("UPDATE candidates SET state='pending', rejected_at=NULL, reject_reason=NULL WHERE cid=?")
      .run(row.cid)
    row = db.prepare('SELECT * FROM candidates WHERE cid=?').get(row.cid) as Row
  }
  const cand = fromRow(row)
  if (cand.kind_guess === 'word' && opts.kind_guess === 'interaction') {
    cand.kind_guess = 'interaction'
  }
  // 证据合流：用例样本封顶 40 条，保留跨视频多样性
  const merged = cand.evidence_usages.concat(opts.usages)
  const uniq = new Map<string, UsageSample>()
  for (const u of merged) uniq.set(`${u.text}\x00${u.rpid}`, u)
  cand.evidence_usages = [...uniq.values()].slice(-40)
  // 跨视频/up 计数走 cand_video 链接表（每候选封顶 500 行 FIFO）
  const ins = db.prepare('INSERT OR IGNORE INTO cand_video(cid,aid,up_mid,ts) VALUES(?,?,?,?)')
  for (const { aid, up_mid } of opts.video_pairs) ins.run(cand.cid, aid, up_mid, ts)
  const cnt = (db.prepare('SELECT COUNT(*) AS c FROM cand_video WHERE cid=?').get(cand.cid) as Row).c as number
  if (cnt > 500) {
    db.prepare(
      'DELETE FROM cand_video WHERE cid=? AND aid NOT IN '
      + '(SELECT aid FROM cand_video WHERE cid=? ORDER BY ts DESC LIMIT 500)',
    ).run(cand.cid, cand.cid)
  }
  const stats = db.prepare(
    'SELECT COUNT(DISTINCT aid) AS v, COUNT(DISTINCT up_mid) AS u FROM cand_video WHERE cid=?',
  ).get(cand.cid) as Row
  cand.distinct_videos = stats.v as number
  cand.distinct_ups = stats.u as number
  cand.last_seen = ts
  cand.surfs_seen += 1
  if (roundId) cand.last_round = roundId
  save(db, cand)
  return cand
}

export function save(db: DatabaseSync, cand: Candidate): void {
  db.prepare(
    'UPDATE candidates SET kind_guess=?, state=?, z_score=?, distinct_videos=?, distinct_ups=?,'
    + 'first_seen=?, last_seen=?, surfs_seen=?, last_round=?, evidence_usages=?, related=?, updated_at=? WHERE cid=?',
  ).run(
    cand.kind_guess, cand.state, cand.z_score, cand.distinct_videos, cand.distinct_ups,
    cand.first_seen, cand.last_seen, cand.surfs_seen, cand.last_round,
    JSON.stringify(cand.evidence_usages), JSON.stringify(cand.related), cand.updated_at, cand.cid,
  )
}

export function get(db: DatabaseSync, cid: string): Candidate | null {
  const row = db.prepare('SELECT * FROM candidates WHERE cid=?').get(cid) as Row | undefined
  return row ? fromRow(row) : null
}

export function byHead(db: DatabaseSync, head: string): Candidate | null {
  const row = db.prepare(
    "SELECT * FROM candidates WHERE head=? AND state IN ('pending','triggered') "
    + 'ORDER BY updated_at DESC LIMIT 1',
  ).get(head) as Row | undefined
  return row ? fromRow(row) : null
}

export function allActive(db: DatabaseSync): Candidate[] {
  const rows = db.prepare("SELECT * FROM candidates WHERE state IN ('pending','triggered') ORDER BY cid").all()
  return (rows as Row[]).map(fromRow)
}

/**
 * 显式跳过：pending/triggered → rejected。
 * - true：本次生效；false：已出队（幂等成功）；throw：cid 不存在（多半手抄错）。
 */
export function reject(db: DatabaseSync, cid: string, reason = 'operator'): boolean {
  const res = db.prepare(
    "UPDATE candidates SET state='rejected', rejected_at=?, reject_reason=? "
    + "WHERE cid=? AND state IN ('pending','triggered')",
  ).run(nowIso(), reason, cid)
  if (res.changes > 0) return true
  const exists = db.prepare('SELECT 1 AS x FROM candidates WHERE cid=?').get(cid)
  if (exists) return false // 已出队：幂等
  throw new Error(`KeyError: ${cid}`)
}
