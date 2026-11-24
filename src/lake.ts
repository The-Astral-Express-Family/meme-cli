/** 原始湖访问：内容寻址缓存的查询面（候选语料 + backtest 负例来源）。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { tx } from './db.ts'
import { nowIso, todayIso } from './models.ts'

export function commentsForRound(db: DatabaseSync, roundId: number): Row[] {
  return db.prepare('SELECT * FROM lake_comments WHERE round_id=? ORDER BY ctime').all(roundId) as Row[]
}

/** 本轮采集到的视频标题（重爬即换轮次归属：标题仍挂着就仍是活证据）。
 * QQ 群占位行（source='qq'）的 title 是群名不是梗证据，排除——否则群名
 * 会以标题权重进语料立户。 */
export function titlesForRound(db: DatabaseSync, roundId: number): Array<{ aid: number; title: string; pubdate: number }> {
  return (db.prepare(
    "SELECT aid, title, pubdate FROM lake_videos WHERE round_id=? AND title != '' AND source != 'qq'",
  ).all(roundId) as Row[]).map((r) => ({
    aid: r.aid as number, title: r.title as string, pubdate: Number(r.pubdate ?? 0),
  }))
}

/** aid → up_mid（跨 up 新颖性计算）。 */
export function upMidMap(db: DatabaseSync): Map<number, number> {
  const out = new Map<number, number>()
  for (const r of db.prepare('SELECT aid, up_mid FROM lake_videos').all() as Row[]) {
    out.set(r.aid as number, r.up_mid as number)
  }
  return out
}

/**
 * 轮次的归账日 = 该轮采集日期（surf_runs.started_at 的日期部分）。
 * 必须用轮次日期而非当前日期：rebuild/回放按湖重放历史轮次时，若全部记到
 * "今天"，phrase_daily 的历史天数被压塌，burst/keyness 的时间维随之失明
 * （2026-11-22 实测：重建后 phrase_daily 只剩 1 天，全表 keyness=0）。
 */
export function roundDay(db: DatabaseSync, roundId: number): string {
  const row = db.prepare('SELECT started_at FROM surf_runs WHERE round_id=?').get(roundId) as Row | undefined
  const at = row?.started_at as string | undefined
  return at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : todayIso()
}

/**
 * 原始湖轮次留存清理（部署生命周期，每轮 surf 执行）：删除留存窗口（N 轮）
 * 之前的评论/视频/评论图片。0 = 不清理（开发期默认——原始湖是唯一非派生数据，
 * 删了历史就永久不可重审；部署期设 7，接受该代价换取有界存储）。
 * 长期态（词条/封禁/日聚合/笔记/审计）不在清理范围。
 */
export function reapLake(db: DatabaseSync, currentRound: number, retentionRounds: number): number {
  if (retentionRounds <= 0) return 0
  const cut = Math.max(currentRound - retentionRounds, 0)
  const res = db.prepare('DELETE FROM lake_comments WHERE round_id>0 AND round_id<=?').run(cut)
  db.prepare('DELETE FROM lake_videos WHERE round_id>0 AND round_id<=?').run(cut)
  db.prepare('DELETE FROM lake_comment_images WHERE round_id>0 AND round_id<=?').run(cut)
  return Number(res.changes)
}

/** 确定性伪随机（mulberry32）——负例采样与留出集切分可复现。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 随机采样不含目标词的评论作为 backtest 负例。 */
export function randomNegativeComments(
  db: DatabaseSync, n: number, excludeLike: string[], seed: number | null = null,
): string[] {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM lake_comments').get() as Row).c as number
  if (total === 0) return []
  const rnd = makeRng(seed ?? 42)
  const msgs: string[] = []
  const seenRp = new Set<number>()
  const getOne = db.prepare('SELECT rpid, message FROM lake_comments LIMIT 1 OFFSET ?')
  for (let tried = 0; msgs.length < n && tried < n * 10 + 200; tried++) {
    const row = getOne.get(Math.floor(rnd() * total)) as Row | undefined
    if (!row || seenRp.has(row.rpid as number)) continue
    seenRp.add(row.rpid as number)
    const m = row.message as string
    if (!excludeLike.some((t) => t && m.includes(t))) msgs.push(m)
  }
  return msgs
}

// ---- QQ 群聊入池（内置 bot 桥接的落库端）----

/**
 * 合成负数编号：FNV-1a 64 位哈希取低 52 位后取负。与 B站正数编号空间
 * （aid/rpid/mid 恒为正）永不冲突；确定性保证同一 key 跨重启稳定、消息
 * 重投递经主键 INSERT OR IGNORE 天然去重。两个不同 key 哈希相撞会被并成
 * 同一容器（生日界下部署规模可忽略，不为它建映射表）。
 */
export function qqSyntheticId(key: string): number {
  let h = 0xcbf29ce484222325n
  for (const byte of Buffer.from(key, 'utf8')) {
    h ^= BigInt(byte)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return -(Number(h & 0xfffffffffffffn) + 1)
}

/** bot 桥接投递的一条群聊消息（QQ 官方网关事件的必要子集）。 */
export interface IngestGroupMessage {
  msg_id: string
  group: string
  group_name?: string
  sender: string
  sender_name?: string
  content: string
  /** 毫秒时间戳（缺省 = 收到时刻）。 */
  ts_ms?: number
}

/**
 * 群聊消息入池：群 = 占位视频行（lake_videos.source='qq'，up 字段存群——
 * 统计里群就是传播源），消息 = 评论行（评论表无 source 列，群评论以
 * 合成负数 oid 识别；round_id=0 = 未入轮）。下一轮 surf 开局
 * claimPendingIngest 把 0 号行认领进本轮，与 B站采集同批进抽取管线。
 * reapLake 的 round_id>0 守卫保证未入轮行永不被留存清理误删（surf 运行中
 * ingest 并发写入的安全性也由此保证）。
 */
export function ingestGroupMessages(
  db: DatabaseSync, msgs: IngestGroupMessage[],
): { inserted: number; duplicates: number } {
  let inserted = 0
  let duplicates = 0
  const insVideo = db.prepare(
    "INSERT OR IGNORE INTO lake_videos(aid,bvid,title,rid,up_mid,up_name,pubdate,reply_count,fetched_at,source,round_id) "
    + "VALUES(?,?,?,0,0,NULL,0,0,?,'qq',0)",
  )
  const insComment = db.prepare(
    'INSERT OR IGNORE INTO lake_comments(rpid,oid,root,parent,mid,message,ctime,likes,fetched_at,round_id) '
    + 'VALUES(?,?,0,0,?,?,?,0,?,0)',
  )
  const now = nowIso()
  tx(db, () => {
    for (const m of msgs) {
      if (!m.msg_id || !m.group || !m.content.trim()) continue
      const aid = qqSyntheticId(m.group)
      insVideo.run(aid, null, m.group_name ?? m.group, now)
      const res = insComment.run(
        qqSyntheticId(m.msg_id), aid, qqSyntheticId(m.sender), m.content,
        Math.floor((m.ts_ms ?? Date.now()) / 1000), now,
      )
      if (Number(res.changes) > 0) inserted += 1
      else duplicates += 1
    }
  })
  return { inserted, duplicates }
}

/** 把未入轮（round_id=0）的群聊行认领进当前轮——每轮 surf 开局第一步。
 * B站行由 fetch 写入时即带轮次号，round_id=0 只会是群聊行，无需额外过滤。 */
export function claimPendingIngest(db: DatabaseSync, roundId: number): number {
  const res = db.prepare('UPDATE lake_comments SET round_id=? WHERE round_id=0').run(roundId)
  db.prepare("UPDATE lake_videos SET round_id=? WHERE round_id=0 AND source='qq'").run(roundId)
  return Number(res.changes)
}
