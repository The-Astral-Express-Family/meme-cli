/**
 * 生命周期：候选与词条双状态机。一切转移发生在被调用时。
 * 遗忘 = 降级 + 压缩，不是删除；ID 永不回收。
 */
import type { DatabaseSync } from 'node:sqlite'
import * as audit from './audit.ts'
import { allMemes, save as saveMeme } from './entries.ts'
import { allActive as allActiveCands, save as saveCand } from './candidates.ts'
import { bumpRound } from './ledger.ts'
import { memeFeatures, memeScore, lifetimeCount } from './detect/evidence.ts'
import { semanticFlags } from './detect/semantics.ts'
import type { LifecycleConfig, ResolvedConfig } from './config.ts'
import type { Candidate, Meme } from './models.ts'
import { nowIso } from './models.ts'
import type { Row } from './db.ts'
import { MemeError } from './errors.ts'

// ---------- 候选状态机 ----------

const volumeLineFor = (channel: Candidate['channel'], cfg: LifecycleConfig): number =>
  channel === 'phrase' ? cfg.trigger_videos : channel === 'image' ? cfg.trigger_images : cfg.trigger_videos_alt

/**
 * 触发归纳 v4（2026-11-22 操作员决策：撤掉"形成时间"时间窗机制，机制从简）：
 * 体量门（便宜）→ 特征分门（纯 CPU）→ 语义否决（嵌入按次计费，只对特征分
 * 已达标的候选计算）。
 * 全部条件都是证据的累计量，**不含任何时间窗**——一条规则对所有轮次成立，
 * 不存在"错过窗口就永久进不来"的单次判定：
 * - 体量门：存活 ≥ trigger_rounds 轮、**绝对出现次数**达线（词类 phrase ≥
 *   trigger_videos【默认 10，2026-11-22 真实湖敏感度实测校准，操作员确认
 *   5 偏低；累计轮数不限】；结构通道 copy/skeleton ≥ trigger_videos_alt
 *   【默认 15——整句复读类（事件句/应用名）的纯特征分同样拉满，特征分
 *   挡不住它们，量阈值是唯一防线故更高】）。
 *   次数而非跨视频数（操作员 2026-11-22 判定）：同一视频下的反复复读同样是
 *   复读指征，跨视频数会漏掉单视频评论区的梗浪；次数 ≥ 跨视频数恒成立，次数
 *   线是严格放宽。图梗无日聚合计数，保留跨视频线。跨 up 门整体取消（操作员
 *   2026-11-22 追加决策：单视频/单群复读浪一并放行，噪音由特征分门与封禁承担）。
 * - 语义否决：phrase/copy 泛回应；skeleton 弱模板/全虚词核心/泛回应。
 * - 特征分门：memeScore ≥ trigger_meme_score（用例高度重复才放行，句句不同的
 *   泛用词/专名挡在此处）。
 * burst（Kleinberg 用量突增等级）只作排序特征，不参与任何触发判断。
 * 泛夸标记只进排序罚分、不否决（嵌入边距薄，神系真梗被泛夸云覆盖）。
 */
export async function candidateShouldTrigger(
  db: DatabaseSync, cand: Candidate, cfg: LifecycleConfig, resCfg: ResolvedConfig,
): Promise<boolean> {
  if (cand.surfs_seen < cfg.trigger_rounds) return false
  const validUsages = cand.evidence_usages.filter((u) => u.text && u.text.trim())
  if (validUsages.length < (cand.channel === 'skeleton' ? 3 : 2)) return false
  if (cand.kind_guess === 'interaction') {
    const parentQ = db.prepare('SELECT 1 AS x FROM lake_comments WHERE rpid=?')
    if (!validUsages.some((u) => u.parent > 0 && parentQ.get(u.parent))) return false
  }
  const volumeLine = volumeLineFor(cand.channel, cfg)
  // 体量线按绝对出现次数（日聚合账本终身总和）；图梗无账本，退回跨视频数
  const volume = cand.channel === 'image' ? cand.distinct_videos : lifetimeCount(db, cand.head, cand.channel)
  if (volume < volumeLine) return false
  // 图梗的证据是 pHash 跨视频簇，不是文本复读；跨视频线达标即过门，无语义否决。
  if (cand.channel === 'image') return true
  // 质量门用纯特征分（复读/坍缩/独立成评）——广度 dv 与边界熵是排序特征，
  // 进门会放行 dv 高句句不同的泛用词（旧行为校准过）；
  // 排序（present.orderKey / replay）才用带 dv/熵/keyness 的 scoreCandidate。
  // 便宜的特征分放在嵌入标记之前：语义否决只对特征分已达标的候选计算
  // （嵌入按次计费，数千醒着候选里绝大多数过不了特征分门）；图梗通道
  // 没有语义否决，完全不算标记。
  const feats = memeFeatures(validUsages, cand.head)
  if (memeScore(feats) < cfg.trigger_meme_score) return false
  const flags = await semanticFlags(db, resCfg, cand)
  if (flags.response_generic) return false
  if (cand.channel === 'skeleton' && (flags.weak_template || flags.all_function_core)) return false
  return true
}

/** 存活窗口：末次证据距今 ≤ surf_survive_rounds 轮（或从无轮次记录）为醒着。 */
export function isAwake(cand: Candidate, currentRound: number, surviveRounds: number): boolean {
  return cand.last_round === 0 || currentRound - cand.last_round < surviveRounds
}

/**
 * 每轮对醒着的 pending/triggered 重算同一触发条件：
 * pending 达标 → triggered；triggered 不再达标 → pending。
 * triggered 不是永久待裁决队列，阈值附近的抖动先直接呈现，由回放观察。
 */
export async function transitionCandidates(
  db: DatabaseSync, resCfg: ResolvedConfig, currentRound: number,
): Promise<{ triggered: string[]; demoted: string[] }> {
  const cfg = resCfg.lifecycle
  const summary = { triggered: [] as string[], demoted: [] as string[] }
  for (const cand of allActiveCands(db)) {
    if (!isAwake(cand, currentRound, cfg.surf_survive_rounds)) continue
    const qualifies = await candidateShouldTrigger(db, cand, cfg, resCfg)
    const next: Candidate['state'] = qualifies ? 'triggered' : 'pending'
    if (cand.state === next) continue
    cand.state = next
    cand.updated_at = nowIso()
    saveCand(db, cand)
    ;(qualifies ? summary.triggered : summary.demoted).push(cand.cid)
  }
  return summary
}

const dayCut = (days: number): string => {
  const d = new Date(Date.now() - days * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 候选收割（部署生命周期，每轮 surf 末尾执行）：
 * - 低价值早清：休眠（末次证据超 surf_survive_rounds 轮）且从未达本通道体量线
 *   （绝对出现次数；图梗按跨视频数）的 pending 候选直接删除——存活窗口里连
 *   体量线都没碰到，不值得占位到 28 天；
 * - 28 天死亡：末次证据超过 candidate_death_days 的候选删除。pending/triggered 同样
 *   适用（操作员 2026-11-22 决策：队列只保留新鲜工作；词若仍在传播会重新触发
 *   重新暴露）；inducted 候选豁免（与词条绑定，作为交叉引用长期保留）。
 * 候选是可从原始湖重建的派生态，删除不影响历史重审；词头重现会重新立户积累。
 */
export function reapCandidates(db: DatabaseSync, cfg: LifecycleConfig, currentRound: number): { low_value: number; dead: number } {
  const res = { low_value: 0, dead: 0 }
  const rows = db.prepare(
    "SELECT cid, head, channel, state, distinct_videos, last_round, last_seen FROM candidates WHERE state IN ('pending','triggered')",
  ).all() as Row[]
  const deathCut = dayCut(cfg.candidate_death_days)
  const delC = db.prepare('DELETE FROM candidates WHERE cid=?')
  const delV = db.prepare('DELETE FROM cand_video WHERE cid=?')
  for (const r of rows) {
    const volumeLine = volumeLineFor(r.channel as Candidate['channel'], cfg)
    const asleep = r.last_round > 0 && currentRound - (r.last_round as number) >= cfg.surf_survive_rounds
    const volume = r.channel === 'image' ? (r.distinct_videos as number) : lifetimeCount(db, r.head as string, r.channel as string)
    if (asleep && r.state === 'pending' && volume < volumeLine) {
      delC.run(r.cid)
      delV.run(r.cid)
      res.low_value += 1
      continue
    }
    if ((r.last_seen as string) < deathCut) {
      delC.run(r.cid)
      delV.run(r.cid)
      res.dead += 1
    }
  }
  return res
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
  // 走轮次台账：surf 半轮恢复重跑同轮不会把 meme_hit_daily 记两次
  bumpRound(db, roundId, 'meme_hit_daily', meme.id, day, hits)
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

/** 7 窗滑窗峰值（序列按观测日对齐，窗 = 连续 7 个观测日）。 */
export function peakOf(series: number[]): number {
  let peak = 0
  for (let i = 0; i < Math.max(series.length - 6, 1); i++) {
    const win = series.slice(i, i + 7)
    peak = Math.max(peak, win.reduce((a, b) => a + b, 0) / 7)
  }
  return peak
}

/**
 * 观测日对齐的野外命中序列：只在真实采集过的日子（surf_runs.fetched=1 的日）
 * 上取样，空档日不再补零。surf 不是每天跑，旧实现把日历空档记 0，14 天均值
 * 被空档压低造成假衰减（v0.12 修复）。days = 日历回看窗（fade_window_days），
 * 序列长度 = 窗内观测日数。
 */
export function hitSeries(db: DatabaseSync, memeId: string, days: number): number[] {
  const start = new Date(Date.now() - (days - 1) * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const cut = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())}`
  const observed = db.prepare(
    "SELECT DISTINCT substr(started_at,1,10) AS day FROM surf_runs "
    + 'WHERE fetched=1 AND substr(started_at,1,10)>=? ORDER BY day',
  ).all(cut) as Row[]
  const hits = new Map<string, number>()
  for (const r of db.prepare('SELECT day, cnt FROM meme_hit_daily WHERE meme_id=? AND day>=?').all(memeId, cut) as Row[]) {
    hits.set(r.day as string, r.cnt as number)
  }
  return observed.map((r) => hits.get(r.day as string) ?? 0)
}

/** surf 顺手执行的衰减复查：active→fading→tombstone。返回变化列表。 */
export function checkFade(db: DatabaseSync, cfg: LifecycleConfig): Array<{ id: string; name: string; from: string; to: string }> {
  const changes: Array<{ id: string; name: string; from: string; to: string }> = []
  for (const meme of allMemes(db, ['active', 'fading'])) {
    const series = hitSeries(db, meme.id, cfg.fade_window_days)
    if (!series.some((x) => x > 0)) continue
    // 峰值 = 任意 7 个观测日的滑窗均值最大值；当前 = 近 14 个观测日均值
    const peak = peakOf(series)
    const recent = series.slice(-14)
    const cur = recent.reduce((a, b) => a + b, 0) / recent.length
    const tail30 = series.slice(-30)
    meme.stats.peak_freq = Math.max(meme.stats.peak_freq, peak)
    meme.stats.wild_freq_30d = tail30.reduce((a, b) => a + b, 0) / Math.max(tail30.length, 1)
    if (meme.state === 'active' && peak > 0 && cur < peak * (1 - cfg.fade_drop)) {
      meme.state = 'fading'
      audit.record(db, meme.id, 'state_change', 'system',
        { from: 'active', to: 'fading', peak: round2(peak), current: round2(cur), reason: `观测日均值较峰值下降超 ${(cfg.fade_drop * 100).toFixed(0)}%` })
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
  if (meme.state !== 'observing') {
    throw new MemeError('MEME_STATE_INVALID', `${meme.id} 状态为 ${meme.state}，不可升格`, '只有 observing 词条能升格为 active；用 meme show <id> --level full 确认当前状态。')
  }
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
    throw new MemeError('MEME_STATE_INVALID', `${meme.id} 状态为 ${meme.state}，无需复活`, '只有 fading/tombstone 词条需要复活；active 词条已是完整卡。')
  }
  const old = meme.state
  meme.state = 'active'
  meme.revived_pending = 1
  audit.record(db, meme.id, 'state_change', source, { from: old, to: 'active', reason: reason || '复活（最小卡待确认）' })
  saveMeme(db, meme)
  return meme
}
