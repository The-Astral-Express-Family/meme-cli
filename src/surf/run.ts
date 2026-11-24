/**
 * surf 轮次编排：获取（增量）→ 证据更新（零 LLM）→ 关联预计算 → 四区呈现。
 * 一切发生在被调用时——不存在独立于调用的整理任务。
 * 获取失败 → 降级模式，靠原始湖存量继续运转。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { kvGet, kvSet, tx } from '../db.ts'
import * as candidates from '../candidates.ts'
import * as entries from '../entries.ts'
import * as lifecycle from '../lifecycle.ts'
import * as notes from '../notes.ts'
import type { ResolvedConfig } from '../config.ts'
import { resolveSessdata } from '../config.ts'
import { updateSignals } from '../detect/signals.ts'
import { candidateNotFound, MemeError } from '../errors.ts'
import { normalizeHead } from '../detect/evidence.ts'
import { loadMatchers, scanTexts } from '../match/pipeline.ts'
import { nowIso, todayIso } from '../models.ts'
import { claimPendingIngest, reapLake } from '../lake.ts'
import { runFetch, type FetchResult } from '../fetch/sampler.ts'
import * as present from './present.ts'

const stringList = (db: DatabaseSync, key: string): string[] => {
  try {
    const value = JSON.parse(kvGet(db, key, '[]') || '[]')
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/** allow：精确解除封禁，并保留对内置/配置停用词的可逆豁免。 */
export function handleAllow(db: DatabaseSync, words: string[]): string[] {
  const allowed = [...new Set(words.map(normalizeHead).filter(Boolean))]
  if (!allowed.length) throw new MemeError('MEME_HEAD_INVALID', 'allow 至少需要一个非空词头', '传入要解除封禁的精确词头。')
  tx(db, () => {
    const bans = stringList(db, 'generic_auto').map(normalizeHead).filter((w) => !allowed.includes(w))
    const exemptions = [...new Set([...stringList(db, 'generic_allow').map(normalizeHead), ...allowed])]
    kvSet(db, 'generic_auto', JSON.stringify(bans))
    kvSet(db, 'generic_allow', JSON.stringify(exemptions))
    for (const row of db.prepare("SELECT cid, head FROM candidates WHERE state='rejected' AND reject_reason='banned'").all() as Row[]) {
      if (allowed.includes(normalizeHead(row.head as string))) {
        db.prepare("UPDATE candidates SET state='pending', rejected_at=NULL, reject_reason=NULL, updated_at=? WHERE cid=?")
          .run(nowIso(), row.cid)
      }
    }
  })
  return allowed
}

/** ban：精确归一化词头，跨 phrase/copy/skeleton/image 生效；不做子串或语义家族封禁。 */
export function handleBan(db: DatabaseSync, words: string[]): string[] {
  const banned = [...new Set(words.map(normalizeHead).filter(Boolean))]
  if (!banned.length) throw new MemeError('MEME_HEAD_INVALID', 'ban 至少需要一个非空词头', '传入要封禁的精确词头。')
  tx(db, () => {
    const bans = [...new Set([...stringList(db, 'generic_auto').map(normalizeHead), ...banned])]
    const exemptions = stringList(db, 'generic_allow').map(normalizeHead).filter((w) => !banned.includes(w))
    kvSet(db, 'generic_auto', JSON.stringify(bans))
    kvSet(db, 'generic_allow', JSON.stringify(exemptions))
    const ts = nowIso()
    for (const cand of candidates.allActive(db)) {
      if (!banned.includes(normalizeHead(cand.head))) continue
      db.prepare("UPDATE candidates SET state='rejected', rejected_at=?, reject_reason='banned', updated_at=? WHERE cid=?")
        .run(ts, ts, cand.cid)
    }
  })
  return banned
}

/** 已有词条野外频率复查：命中计数、变体提示、爆发上升、存活/复活转移。 */
function wildRecheck(db: DatabaseSync, cfg: ResolvedConfig, roundId: number): Array<Record<string, string>> {
  const day = todayIso()
  const matchers = loadMatchers(db)
  const rows = db.prepare('SELECT rpid, message, parent FROM lake_comments WHERE round_id=?').all(roundId) as Row[]
  const dynamics: Array<Record<string, string>> = []
  if (!rows.length || !matchers.length) return dynamics
  // 楼中楼父子文本 → 交互梗（tier 3）的会话上下文；无父评论的行 ctx 为 null
  const msgByRpid = new Map(rows.map((r) => [r.rpid as number, r.message as string]))
  const items: Array<[string, string[] | null]> = rows.map((r) => {
    let ctx: string[] | null = null
    if (r.parent) {
      const p = msgByRpid.get(r.parent as number)
      if (p) ctx = [p, r.message as string]
    }
    return [r.message as string, ctx]
  })
  const [counts, excerpts] = scanTexts(matchers, items)
  for (const [mid, hits] of counts) {
    const m = entries.get(db, mid)
    if (!m) continue
    const oldState = m.state
    lifecycle.noteWildMatch(db, m, roundId, day, hits, cfg.lifecycle.promote_rounds)
    // 变体提示：命中摘录不在已知词表内 → 骨架漂移信号
    const known = [m.name, ...m.aliases]
    for (const ex of [...(excerpts.get(mid) ?? [])].slice(0, 3)) {
      if (ex.length >= 2 && !known.some((k) => k && (k.includes(ex) || ex.includes(k)))) {
        dynamics.push({
          id: mid, name: m.name,
          change: `新形态"${ex.slice(0, 16)}"出现（${hits} 次命中）`,
          action: '可 edit variant 收编',
        })
        break
      }
    }
    // 爆发上升：本轮命中 ≥ 2× 前 14 天日均
    const prevRow = db.prepare(
      'SELECT COALESCE(SUM(cnt),0) AS c FROM meme_hit_daily WHERE meme_id=? AND day<? AND day>=?',
    ).get(mid, day, todayIso(new Date(Date.now() - 14 * 86400_000))) as Row
    const base = (prevRow.c as number) / 14
    if (hits >= 5 && base > 0 && hits >= 2 * base) {
      dynamics.push({
        id: mid, name: m.name,
        change: `爆发上升 ${base.toFixed(1)}/日→本轮 ${hits}`,
        action: oldState === 'observing' ? '可 edit promote 升格' : '持续观察',
      })
    }
    if (oldState === 'observing' && m.state === 'active') {
      dynamics.push({ id: mid, name: m.name, change: '连续野外存活，自动升格 active', action: '' })
    }
    if ((oldState === 'fading' || oldState === 'tombstone') && m.state === 'active') {
      dynamics.push({ id: mid, name: m.name, change: '野外重现复活（最小卡待确认）', action: 'show 确认' })
    }
  }
  return dynamics
}

function fadingZone(db: DatabaseSync, cfg: ResolvedConfig, changes: Array<{ id: string; name: string; from: string; to: string }>): string[] {
  const lines = changes.map((ch) => `${ch.id} ${ch.name}   ${ch.from} → ${ch.to}`)
  for (const m of entries.allMemes(db, ['fading'])) {
    const series = lifecycle.hitSeries(db, m.id, cfg.lifecycle.fade_window_days)
    if (!series.some((x) => x > 0)) continue
    const peak = lifecycle.peakOf(series)
    const recent = series.slice(-14)
    const cur = recent.reduce((a, b) => a + b, 0) / recent.length
    if (peak > 0) {
      const drop = Math.max(0, 1 - cur / peak)
      lines.push(`${m.id} ${m.name}   野外频率 ${cfg.lifecycle.fade_window_days}天窗 -${Math.round(drop * 100)}%（观测日口径）`)
    }
  }
  return lines.slice(0, 10)
}

/** --json 全量输出保险丝；当前过门条目不是永久待裁决队列。 */
const FULL_DUMP_CAP = 1000

/** 候选统一排序（score v2 → dv → id）。 */
function rankedCandidates(db: DatabaseSync, cands: import('../models.ts').Candidate[]): import('../models.ts').Candidate[] {
  return [...cands].sort((a, b) => {
    const ka = present.orderKey(db, a)
    const kb = present.orderKey(db, b)
    return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : 1)
  })
}

/** 当前窗口内已过触发门的条目；check 不落状态，故对 pending 也现场重算。 */
async function currentQualified(
  db: DatabaseSync, cfg: ResolvedConfig, currentRound: number, recompute: boolean,
): Promise<import('../models.ts').Candidate[]> {
  const awake = candidates.allActive(db)
    .filter((c) => lifecycle.isAwake(c, currentRound, cfg.lifecycle.surf_survive_rounds))
  const qualified: import('../models.ts').Candidate[] = []
  for (const c of awake) {
    if (recompute ? await lifecycle.candidateShouldTrigger(db, c, cfg.lifecycle, cfg) : c.state === 'triggered') qualified.push(c)
  }
  return rankedCandidates(db, qualified)
}

function buildZones(
  db: DatabaseSync, cands: import('../models.ts').Candidate[],
  page: number, roundSize: number, full = false,
  flagMap: Map<string, import('../detect/evidence.ts').ScoreFlags> | null = null,
  currentRound = 0,
): Record<string, any> {
  const relatedNames = new Map(entries.allMemes(db).map((m) => [m.id, m.name] as const))
  let hot: string[] = []
  try { hot = JSON.parse(kvGet(db, 'surf_hotwords', '[]') || '[]') } catch { /* 坏数据忽略 */ }
  let pageItems: typeof cands
  let hasMore: boolean
  if (full) {
    pageItems = cands.slice(0, FULL_DUMP_CAP)
    hasMore = false
  } else {
    const start = page * roundSize
    pageItems = cands.slice(start, start + roundSize)
    hasMore = start + roundSize < cands.length
  }
  return {
    counts: { new: cands.length, dynamics: 0, fading: 0, backlog: 0 },
    hot_keywords: hot,
    new_candidates: pageItems.map((c) => present.candLine(db, c, relatedNames, flagMap?.get(c.cid) ?? null, true)),
    new_candidates_raw: pageItems.map((c) => present.candDict(db, c, flagMap?.get(c.cid) ?? null, true)),
    dynamics: [] as string[],
    fading: [] as string[],
    backlog_line: `当前窗口过门 ${cands.length} 条；★只表示待人工判断`,
    backlog: { triggered: cands.length, pending: 0, alert: false },
    round: currentRound,
    page,
    has_more: hasMore,
  }
}

async function focusView(
  db: DatabaseSync, cfg: ResolvedConfig, cand: import('../models.ts').Candidate, currentRound: number,
): Promise<{ payload: Record<string, unknown>; human: string }> {
  const vids = (db.prepare(
    'SELECT v.aid AS aid, v.title AS title, v.up_name AS up_name FROM cand_video cv '
    + 'JOIN lake_videos v ON v.aid=cv.aid WHERE cv.cid=? ORDER BY cv.ts DESC LIMIT 5',
  ).all(cand.cid) as Row[]).map((r) => ({
    aid: r.aid as number, title: r.title as string, up_name: (r.up_name as string | null) ?? undefined,
  }))
  const parentTexts = new Map<number, string>()
  for (const parent of new Set(cand.evidence_usages.map((u) => u.parent).filter((p) => p > 0))) {
    const row = db.prepare('SELECT message FROM lake_comments WHERE rpid=?').get(parent) as Row | undefined
    if (row) parentTexts.set(parent, row.message as string)
  }
  const related = cand.related.map((r) => {
    const m = entries.get(db, r.id)
    return { id: r.id, type: r.type, score: r.score, name: m ? m.name : '?' }
  })
  const flags = await present.enrichFlags(db, cfg, [cand])
  return {
    payload: {
      round: currentRound,
      read_only: true,
      candidate: {
        ...present.candDict(db, cand, flags.get(cand.cid) ?? null),
        evidence_usages: cand.evidence_usages.map((u) => ({
          ...u, parent_text: u.parent > 0 ? parentTexts.get(u.parent) ?? null : null,
        })),
      },
      videos: vids,
      related,
    },
    human: present.renderFocus(cand, vids, related, parentTexts),
  }
}

/** 只读检查：不写 surf_round、不认领 QQ、不收割、不写 kv，也不落触发状态。 */
export async function runCheck(
  db: DatabaseSync, cfg: ResolvedConfig,
  opts: { focus?: string; page?: number; roundSize?: number } = {},
): Promise<{ payload: Record<string, unknown>; human: string }> {
  const roundSize = opts.roundSize ?? cfg.retrieval.round_size
  const page = opts.page ?? 0
  if (!Number.isInteger(roundSize) || roundSize <= 0) {
    throw new MemeError('MEME_PAGE_INVALID', '--round-size 必须是正整数', '传入大于 0 的整数。')
  }
  if (!Number.isInteger(page) || page < 0) {
    throw new MemeError('MEME_PAGE_INVALID', '--page 必须是非负整数', '传入大于等于 0 的整数。')
  }
  const currentRound = Number(kvGet(db, 'surf_round', '0') || 0)
  if (opts.focus) {
    const cand = candidates.get(db, opts.focus)
    if (!cand || !lifecycle.isAwake(cand, currentRound, cfg.lifecycle.surf_survive_rounds)) throw candidateNotFound(opts.focus)
    return focusView(db, cfg, cand, currentRound)
  }
  const qualified = await currentQualified(db, cfg, currentRound, true)
  const pageItems = qualified.slice(page * roundSize, page * roundSize + roundSize)
  const flagMap = await present.enrichFlags(db, cfg, pageItems)
  const zones = buildZones(db, qualified, page, roundSize, false, flagMap, currentRound)
  zones.read_only = true
  return {
    payload: zones,
    human: '只读检查（未推进轮次）：\n' + present.renderZones(zones, present.pageFooter(page, zones.has_more, roundSize)),
  }
}

export interface SurfOpts {
  roundSize?: number
  noFetch?: boolean
  probe?: string[]
  full?: boolean
  signal?: AbortSignal
  /** 测试注入的假 fetcher。 */
  fetch?: (db: DatabaseSync, cfg: ResolvedConfig['fetch'], roundId: number, sessdata: string, probe: string[], signal?: AbortSignal) => Promise<FetchResult>
}

export async function runSurf(db: DatabaseSync, cfg: ResolvedConfig, opts: SurfOpts = {}): Promise<{ payload: Record<string, unknown>; human: string }> {
  const roundSize = opts.roundSize ?? cfg.retrieval.round_size
  // ---- 新一轮 ----
  const run = db.prepare('INSERT INTO surf_runs(started_at, fetched) VALUES(?, 0)').run(nowIso())
  const roundId = Number(run.lastInsertRowid)
  // 群聊消息认领：bot 桥接写入的 round_id=0 行并入本轮，与 B站采集同批计算
  const claimed = claimPendingIngest(db, roundId)

  let fetchNote: string | null = null
  let fres: FetchResult | null = null
  if (opts.noFetch) {
    fetchNote = '本轮不联网获取（--no-fetch），仍执行证据更新、状态重算与收割'
  } else {
    const doFetch = opts.fetch ?? runFetch
    fres = await doFetch(db, cfg.fetch, roundId, resolveSessdata(cfg), opts.probe ?? [], opts.signal)
    db.prepare(
      'UPDATE surf_runs SET fetched=1, new_videos=?, new_comments=?, degraded=?, note=? WHERE round_id=?',
    ).run(fres.new_videos, fres.new_comments, fres.degraded ? 1 : 0, fres.reason, roundId)
    if (fres.degraded) fetchNote = fres.reason
  }

  const sig = await updateSignals(db, cfg, roundId)
  const dynamics = wildRecheck(db, cfg, roundId)
  const fadeChanges = lifecycle.checkFade(db, cfg.lifecycle)
  const trans = await lifecycle.transitionCandidates(db, cfg, roundId)
  const reap = lifecycle.reapCandidates(db, cfg.lifecycle, roundId)
  const lakeReaped = reapLake(db, roundId, cfg.lifecycle.surf_retention_rounds)
  notes.dedupe(db)

  kvSet(db, 'surf_round', String(roundId))
  kvSet(db, 'surf_hotwords', JSON.stringify(fres ? fres.hot_keywords : []))

  const qualified = await currentQualified(db, cfg, roundId, false)
  const pageItems = qualified.slice(0, opts.full ? FULL_DUMP_CAP : roundSize)
  const flagMap = await present.enrichFlags(db, cfg, pageItems.slice(0, 40))
  const zones = buildZones(db, qualified, 0, roundSize, opts.full, flagMap, roundId)
  zones.round = roundId
  zones.claimed = claimed
  zones.fetch = {
    new_videos: fres ? fres.new_videos : 0,
    new_comments: fres ? fres.new_comments : 0,
    degraded: Boolean(fetchNote),
    note: fetchNote,
    probed: fres ? fres.probed : [],
  }
  zones.degraded = fetchNote
  zones.signals = { ...sig }
  zones.candidate_transitions = trans
  zones.reap = { ...reap, lake_comments: lakeReaped }
  zones.counts.reap = reap.low_value + reap.dead
  zones.dynamics_raw = dynamics
  zones.dynamics = dynamics
    .slice(0, 10)
    .map((d) => `${d.id} ${d.name}  ${d.change}${d.action ? `   → ${d.action}` : ''}`)
  zones.fading = fadingZone(db, cfg, fadeChanges)
  zones.counts.fading = zones.fading.length
  return {
    payload: zones,
    human: present.renderZones(zones, present.pageFooter(0, zones.has_more, roundSize)),
  }
}
