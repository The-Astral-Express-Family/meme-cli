/**
 * 生命周期：候选与词条双状态机。一切转移发生在被调用时。
 * 遗忘 = 降级 + 压缩，不是删除；ID 永不回收。
 */
import type { DatabaseSync } from 'node:sqlite'
import * as audit from './audit.ts'
import { dailySeries, allMemes, recordWildHit, save as saveMeme } from './entries.ts'
import { allActive as allActiveCands, save as saveCand } from './candidates.ts'
import { memeFeatures, memeScore } from './detect/evidence.ts'
import type { LifecycleConfig } from './config.ts'
import type { Candidate, Meme } from './models.ts'
import { nowIso } from './models.ts'

// ---------- 候选状态机 ----------

/**
 * 触发归纳：跨轮次 + 跨视频 + 跨 up + 梗性证据。
 * 计数门（必要）+ 梗性门（泛用词句句不同，永远不过此门）
 * + 强度门（其一）：z≥4 爆发 ｜ dv≥8 广泛 ｜ 新物跨 ≥5 视频 fresh 传播。
 */
export function candidateShouldTrigger(cand: Candidate, cfg: LifecycleConfig): boolean {
  if (cand.state !== 'pending') return false
  if (cand.surfs_seen < cfg.trigger_rounds) return false
  if (cand.distinct_videos < cfg.trigger_videos) return false
  if (cand.distinct_ups < 3) return false
  const feats = memeFeatures(cand.evidence_usages, cand.head)
  if (memeScore(feats) < cfg.trigger_meme_score) return false
  const zOk = cand.z_score !== null && cand.z_score >= cfg.trigger_z
  const wideOk = cand.distinct_videos >= cfg.trigger_videos_alt
  const freshOk = cand.z_score === null && cand.distinct_videos >= cfg.trigger_fresh_videos
  return zOk || wideOk || freshOk
}

/** pending → triggered（达标）/ → rejected（过期）。返回变化摘要。 */
export function transitionCandidates(
  db: DatabaseSync, cfg: LifecycleConfig, currentRound: number,
): { triggered: string[]; expired: string[] } {
  const summary = { triggered: [] as string[], expired: [] as string[] }
  for (const cand of allActiveCands(db)) {
    if (candidateShouldTrigger(cand, cfg)) {
      cand.state = 'triggered'
      cand.updated_at = nowIso()
      saveCand(db, cand)
      summary.triggered.push(cand.cid)
    } else if (currentRound - cand.last_round >= cfg.candidate_expire_rounds && cand.last_round > 0) {
      // 长期无新证据且未达阈值 → 过期（单轮候选同样过期，否则 pending 队列只进不出）
      db.prepare("UPDATE candidates SET state='rejected', rejected_at=?, reject_reason='expired' WHERE cid=?")
        .run(nowIso(), cand.cid)
      summary.expired.push(cand.cid)
    }
  }
  return summary
}

// ---------- 词条状态机 ----------

/** wild_rounds 尾部是否为以 current 结尾的 n 个连续轮次。 */
function consecutiveTail(rounds: number[], n: number, current: number): boolean {
  if (rounds.length < n) return false
  const tail = rounds.slice(-n)
  return tail.every((r, i) => r === current - n + 1 + i)
}

/** 记录一轮野外命中；observing→active 存活门在此判定。 */
export function noteWildMatch(
  db: DatabaseSync, meme: Meme, roundId: number, day: string, hits: number, promoteRounds = 2,
): Meme {
  recordWildHit(db, meme.id, day, hits)
  if (!meme.wild_rounds.length || meme.wild_rounds[meme.wild_rounds.length - 1] !== roundId) {
    meme.wild_rounds = [...meme.wild_rounds, roundId].slice(-12)
  }
  meme.stats.last_seen = nowIso()
  meme.stats.last_matched_round = roundId
  const oldState = meme.state
  if (meme.state === 'observing') {
    if (consecutiveTail(meme.wild_rounds, promoteRounds, roundId)) {
      meme.state = 'active'
      audit.record(db, meme.id, 'state_change', 'system',
        { from: 'observing', to: 'active', round: roundId, reason: '连续野外存活' })
    }
  } else if (meme.state === 'fading' || meme.state === 'tombstone') {
    // 野外重现：先回移 + 最小卡（"记得但记不全"），确认后恢复
    meme.state = 'active'
    meme.revived_pending = 1
    audit.record(db, meme.id, 'state_change', 'system',
      { from: oldState, to: 'active', round: roundId, reason: '野外重现复活（最小卡待确认）' })
  }
  saveMeme(db, meme)
  return meme
}

/** 7 天滑窗峰值。 */
export function peakOf(series: number[]): number {
  let peak = 0
  for (let i = 0; i < Math.max(series.length - 6, 1); i++) {
    const win = series.slice(i, i + 7)
    peak = Math.max(peak, win.reduce((a, b) => a + b, 0) / 7)
  }
  return peak
}

/** surf 顺手执行的衰减复查：active→fading→tombstone。返回变化列表。 */
export function checkFade(db: DatabaseSync, cfg: LifecycleConfig): Array<{ id: string; name: string; from: string; to: string }> {
  const changes: Array<{ id: string; name: string; from: string; to: string }> = []
  for (const meme of allMemes(db, ['active', 'fading'])) {
    const series = dailySeries(db, meme.id, cfg.fade_window_days)
    if (!series.some((x) => x > 0)) continue
    // 峰值 = 任意 7 天滑窗均值最大值；当前 = 近 14 天均值
    const peak = peakOf(series)
    const cur = series.slice(-14).reduce((a, b) => a + b, 0) / 14
    meme.stats.peak_freq = Math.max(meme.stats.peak_freq, peak)
    meme.stats.wild_freq_30d = series.slice(-30).reduce((a, b) => a + b, 0) / 30
    if (meme.state === 'active' && peak > 0 && cur < peak * (1 - cfg.fade_drop)) {
      meme.state = 'fading'
      audit.record(db, meme.id, 'state_change', 'system',
        { from: 'active', to: 'fading', peak: round2(peak), current: round2(cur), reason: `${cfg.fade_window_days}天窗口频率下降超阈值` })
      changes.push({ id: meme.id, name: meme.name, from: 'active', to: 'fading' })
    } else if (meme.state === 'fading' && peak > 0 && cur < peak * cfg.tombstone_ratio) {
      meme.state = 'tombstone'
      audit.record(db, meme.id, 'state_change', 'system',
        { from: 'fading', to: 'tombstone', peak: round2(peak), current: round2(cur), reason: '持续衰减至近零' })
      changes.push({ id: meme.id, name: meme.name, from: 'fading', to: 'tombstone' })
    }
    saveMeme(db, meme)
  }
  return changes
}

const round2 = (x: number) => Math.round(x * 100) / 100

export function promote(db: DatabaseSync, meme: Meme, source: audit.AuditSource, reason = ''): Meme {
  if (meme.state !== 'observing') throw new Error(`${meme.id} 状态为 ${meme.state}，不可升格`)
  meme.state = 'active'
  audit.record(db, meme.id, 'state_change', source, { from: 'observing', to: 'active', reason: reason || '人工升格' })
  saveMeme(db, meme)
  return meme
}

/** 判死：加速降级——主观通道，独立于统计衰减。 */
export function kill(db: DatabaseSync, meme: Meme, source: audit.AuditSource, reason = ''): Meme {
  const old = meme.state
  if (meme.state === 'active') meme.state = 'fading'
  audit.record(db, meme.id, 'state_change', source, { from: old, to: meme.state, reason: reason || '主观判死' })
  saveMeme(db, meme)
  return meme
}

/** 复活：fading/tombstone → active，先给最小卡待确认。 */
export function revive(db: DatabaseSync, meme: Meme, source: audit.AuditSource, reason = ''): Meme {
  if (meme.state !== 'fading' && meme.state !== 'tombstone') {
    throw new Error(`${meme.id} 状态为 ${meme.state}，无需复活`)
  }
  const old = meme.state
  meme.state = 'active'
  meme.revived_pending = 1
  audit.record(db, meme.id, 'state_change', source, { from: old, to: 'active', reason: reason || '复活（最小卡待确认）' })
  saveMeme(db, meme)
  return meme
}
