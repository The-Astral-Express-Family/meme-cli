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

// ---- 候选池卫生：治"同句分身 + 复制粘贴切片"污染 ----

export interface HygieneResult {
  /** 包含族合并掉的候选数（证据并入存活方）。 */
  merged: number
  /** 纯复制粘贴切片剪枝数（跨 ≥2 视频但全部用例是同一句）。 */
  pruned_spam: number
}

/**
 * 候选池卫生（每轮信号更新末尾自愈）：
 * 1) 纯复制粘贴剪枝：phrase 候选跨 ≥2 视频但用例归一后只有一句——这是复读通道的
 *    领地（整句重复由 copy 候选承载），phrase 侧切片（代练广告/活动文案的子串）删除；
 * 2) 包含族合并：head 互为包含且视频重合 ≥50%×较小 dv → 并入排名更高的一方
 *    （phrase_daily 终身计数 desc → dv desc → 更长 head desc），证据并集、视频迁移。
 * 只动 phrase 通道——copy/skeleton/image 各有独立判别语义；rejected 不参与
 * （操作员已裁决）。candidates 是可从原始湖重建的派生状态，删除安全。
 */
export function hygienePass(db: DatabaseSync): HygieneResult {
  const res: HygieneResult = { merged: 0, pruned_spam: 0 }
  const rows = db.prepare(
    "SELECT * FROM candidates WHERE channel='phrase' AND state IN ('pending','triggered')",
  ).all() as Row[]
  const cands = rows.map(fromRow)
  const delC = db.prepare('DELETE FROM candidates WHERE cid=?')
  const delV = db.prepare('DELETE FROM cand_video WHERE cid=?')

  // 1) 自推式垃圾剪枝：同一句、同一作者（mid）跨 ≥2 视频——复制粘贴推广
  //    的确定性签名。不同用户的相同短句是复读信号（copy 通道的主粮），不剪。
  //    判重用保数字的轻归一化（去标点/符号/空白）——不能用 normText：它把数字
  //    掩码成 <num> 再丢弃，"评论0/评论1/…" 会坍缩成一句造成误剪。
  const spamKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const dead = new Set<string>()
  for (const c of cands) {
    if (c.distinct_videos < 2 || !c.evidence_usages.length) continue
    const texts = new Set(c.evidence_usages.map((u) => spamKey(u.text)))
    const mids = new Set(c.evidence_usages.map((u) => u.mid).filter((m) => m > 0))
    if (texts.size <= 1 && mids.size <= 1) {
      delC.run(c.cid)
      delV.run(c.cid)
      dead.add(c.cid)
      res.pruned_spam += 1
    }
  }

  // 2) 包含族合并。存活规则 = (phrase_daily 终身出现计数 desc → dv desc → 更长
  //    head desc)：计数区分"蚌埠住了"（词，出现 20 次）与"蚌埠住了蚌埠住"
  //    （叠用截断，10 次）——仅靠 dv 会把完整词并进截断垃圾；计数打平时才
  //    依次看 dv 与 head 长度（"笑死我/笑死我了"等次数相同 → 取完整习语）。
  const cntByPhrase = new Map<string, number>()
  for (const r of db.prepare('SELECT phrase, SUM(cnt) AS c FROM phrase_daily GROUP BY phrase').all() as Row[]) {
    cntByPhrase.set(r.phrase as string, r.c as number)
  }
  const rank = (c: Candidate): number => cntByPhrase.get(c.head) ?? 0
  const vids = new Map<string, Array<{ aid: number; up_mid: number }>>()
  for (const r of db.prepare('SELECT cid, aid, up_mid FROM cand_video').all() as Row[]) {
    if (!vids.has(r.cid as string)) vids.set(r.cid as string, [])
    vids.get(r.cid as string)!.push({ aid: r.aid as number, up_mid: r.up_mid as number })
  }
  const shared = (a: Candidate, b: Candidate): number => {
    const va = new Set((vids.get(a.cid) ?? []).map((v) => v.aid))
    let n = 0
    for (const { aid } of vids.get(b.cid) ?? []) if (va.has(aid)) n += 1
    return n
  }
  const alive = cands.filter((c) => !dead.has(c.cid))
  const sorted = [...alive].sort((a, b) =>
    rank(b) - rank(a) || b.distinct_videos - a.distinct_videos
    || b.head.length - a.head.length || (a.cid < b.cid ? -1 : 1))
  const keepers: Candidate[] = []
  const ts = nowIso()
  const insV = db.prepare('INSERT OR IGNORE INTO cand_video(cid,aid,up_mid,ts) VALUES(?,?,?,?)')
  const stats = db.prepare('SELECT COUNT(DISTINCT aid) AS v, COUNT(DISTINCT up_mid) AS u FROM cand_video WHERE cid=?')
  for (const c of sorted) {
    const host = keepers.find((k) =>
      k.head.length >= 2 && c.head.length >= 2
      && (k.head.includes(c.head) || c.head.includes(k.head))
      && shared(k, c) * 2 >= Math.min(k.distinct_videos, c.distinct_videos))
    if (!host) {
      keepers.push(c)
      continue
    }
    const uniq = new Map<string, UsageSample>()
    for (const u of [...host.evidence_usages, ...c.evidence_usages]) uniq.set(`${u.text}\x00${u.rpid}`, u)
    host.evidence_usages = [...uniq.values()].slice(-40)
    for (const v of vids.get(c.cid) ?? []) {
      insV.run(host.cid, v.aid, v.up_mid, ts)
      vids.get(host.cid)!.push(v) // 后续兄弟与 host 的重合判定要用上并集
    }
    const st = stats.get(host.cid) as Row
    host.distinct_videos = st.v as number
    host.distinct_ups = st.u as number
    if (c.first_seen < host.first_seen) host.first_seen = c.first_seen
    if (c.state === 'triggered' && host.state !== 'triggered') host.state = 'triggered'
    host.updated_at = ts
    save(db, host)
    delC.run(c.cid)
    delV.run(c.cid)
    res.merged += 1
  }
  return res
}
