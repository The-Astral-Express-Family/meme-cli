/**
 * surf 轮次编排：获取（增量）→ 证据更新（零 LLM）→ 关联预计算 → 四区呈现。
 * 一切发生在被调用时——不存在独立于调用的整理任务。
 * 获取失败 → 降级模式，靠原始湖存量继续运转。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { kvGet, kvSet } from '../db.ts'
import * as candidates from '../candidates.ts'
import * as entries from '../entries.ts'
import * as lifecycle from '../lifecycle.ts'
import * as notes from '../notes.ts'
import type { ResolvedConfig } from '../config.ts'
import { resolveSessdata } from '../config.ts'
import { updateSignals } from '../detect/signals.ts'
import { candidateNotFound } from '../errors.ts'
import type { LlmClient } from '../induct/llm.ts'
import { runAdd } from '../induct/inductor.ts'
import * as budget from '../induct/budget.ts'
import { loadMatchers, scanTexts } from '../match/pipeline.ts'
import { nowIso, todayIso } from '../models.ts'
import { runFetch, type FetchResult } from '../fetch/sampler.ts'
import * as present from './present.ts'

/** allow：豁免词写入 kv generic_allow（黑名单误杀的可逆逃生口）。 */
export function handleAllow(db: DatabaseSync, words: string[]): string[] {
  const cur = JSON.parse(kvGet(db, 'generic_allow', '[]') || '[]') as string[]
  for (const w of words) if (!cur.includes(w)) cur.push(w)
  kvSet(db, 'generic_allow', JSON.stringify(cur))
  return words
}

/** reject + ban：批量跳过候选；ban 时把词头沉淀为持久停用词。不存在的 cid 抛错（由工具层转稳定错误码）。 */
export function handleReject(db: DatabaseSync, cids: string[], ban: boolean): { done: string[]; banned: string[] } {
  const done: string[] = []
  const banned: string[] = []
  for (const cid of cids) {
    if (!candidates.reject(db, cid, 'operator')) continue // 已出队：幂等跳过
    done.push(cid)
    if (!ban) continue
    const cand = candidates.get(db, cid)
    if (!cand?.head) continue
    banned.push(cand.head)
    const words = JSON.parse(kvGet(db, 'generic_auto', '[]') || '[]') as string[]
    if (!words.includes(cand.head)) {
      words.push(cand.head)
      kvSet(db, 'generic_auto', JSON.stringify(words))
    }
  }
  return { done, banned }
}

/** 处理上一轮预算耗尽排队的归纳。预算耗尽时剩余行必须全部重新排队——不丢行。 */
async function processQueue(db: DatabaseSync, cfg: ResolvedConfig, llm: LlmClient | null): Promise<Record<string, unknown>[]> {
  const done: Record<string, unknown>[] = []
  const rows = budget.dequeueAll(db)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!budget.canSpend(db, cfg.induction.daily_call_budget)) {
      for (const rest of rows.slice(i)) budget.enqueue(db, rest.cid as string, rest.ctx as string | null) // 全部重新排队
      break
    }
    try {
      const cid = String(row.cid).startsWith('c_') ? String(row.cid) : undefined
      const text = cid ? undefined : String(row.ctx || String(row.cid).replace(/^text:/, ''))
      if (!llm) throw new Error('无归纳客户端')
      const res = await runAdd(db, cfg, { cid, text, ctx: (row.ctx as string) ?? undefined, llm })
      done.push({ ...resJson(res) })
    } catch (e) {
      // 单条失败不阻塞 surf，但不得丢行：裸文本行的唯一载体就是这行
      console.error(`meme: surf: 排队归纳 ${row.cid} 失败（${e}），重新排队`)
      budget.enqueue(db, row.cid as string, row.ctx as string)
    }
  }
  return done
}

const resJson = (res: Awaited<ReturnType<typeof runAdd>>) => ({
  id: res.meme.id, name: res.meme.name, model: res.model,
  backtest: res.backtest ? { hit_rate: res.backtest.hit_rate, fp_rate: res.backtest.fp_rate, passed: res.backtest.passed } : null,
})

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
    const series = entries.dailySeries(db, m.id, cfg.lifecycle.fade_window_days)
    if (!series.some((x) => x > 0)) continue
    const peak = lifecycle.peakOf(series)
    const cur = series.slice(-14).reduce((a, b) => a + b, 0) / 14
    if (peak > 0) {
      const drop = Math.max(0, 1 - cur / peak)
      lines.push(`${m.id} ${m.name}   野外频率 ${cfg.lifecycle.fade_window_days}天 -${Math.round(drop * 100)}%`)
    }
  }
  return lines.slice(0, 10)
}

/** --json 全量输出保险丝：候选队列治理靠过期+操作员，不该有兆级转储。 */
const FULL_DUMP_CAP = 1000

function buildZones(db: DatabaseSync, cfg: ResolvedConfig, page: number, roundSize: number, full = false): Record<string, any> {
  const relatedNames = new Map(entries.allMemes(db).map((m) => [m.id, m.name] as const))
  let hot: string[] = []
  try {
    hot = JSON.parse(kvGet(db, 'surf_hotwords', '[]') || '[]')
  } catch { /* 坏数据忽略 */ }
  const cands = candidates.allActive(db)
    .filter((c) => c.state === 'pending' || c.state === 'triggered')
    .sort((a, b) => {
      const ka = present.orderKey(a)
      const kb = present.orderKey(b)
      return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : 1)
    })
  let pageItems: typeof cands
  let hasMore: boolean
  if (full) {
    // 机器输出不分页（agent 工效）：一次给全量候选，人类渲染才需要翻页
    pageItems = cands.slice(0, FULL_DUMP_CAP)
    hasMore = false
  } else {
    const start = page * roundSize
    pageItems = cands.slice(start, start + roundSize)
    hasMore = start + roundSize < cands.length
  }
  const triggered = cands.filter((c) => c.state === 'triggered')
  const pending = cands.filter((c) => c.state === 'pending')
  const queued = (db.prepare('SELECT COUNT(*) AS c FROM induction_queue').get() as Row).c as number
  const backlogN = triggered.length + queued
  const backlogLine = backlogN >= cfg.lifecycle.backlog_alert
    ? `积压候选 ${backlogN} 条未处理（triggered ${triggered.length}、排队 ${queued}、pending ${pending.length}）`
    : `待处理：triggered ${triggered.length}｜排队 ${queued}｜pending ${pending.length}`
  return {
    counts: { new: cands.length, dynamics: 0, fading: 0, backlog: backlogN },
    hot_keywords: hot,
    new_candidates: pageItems.map((c) => present.candLine(c, relatedNames)),
    new_candidates_raw: pageItems.map((c) => present.candDict(c)),
    dynamics: [] as string[],
    fading: [] as string[],
    backlog_line: backlogLine,
    backlog: { triggered: triggered.length, pending: pending.length, queued, alert: backlogN >= cfg.lifecycle.backlog_alert },
    page,
    has_more: hasMore,
  }
}

export interface SurfOpts {
  more?: boolean
  focus?: string
  roundSize?: number
  noFetch?: boolean
  probe?: string[]
  full?: boolean
  llm?: LlmClient | null
  signal?: AbortSignal
  /** 测试注入的假 fetcher。 */
  fetch?: (db: DatabaseSync, cfg: ResolvedConfig['fetch'], roundId: number, sessdata: string, probe: string[], signal?: AbortSignal) => Promise<FetchResult>
}

export async function runSurf(db: DatabaseSync, cfg: ResolvedConfig, opts: SurfOpts = {}): Promise<{ payload: Record<string, unknown>; human: string }> {
  const roundSize = opts.roundSize ?? cfg.retrieval.round_size
  // focus：深入单个候选（不获取、不更新证据）
  if (opts.focus) {
    const cand = candidates.get(db, opts.focus)
    if (!cand) throw candidateNotFound(opts.focus)
    const vids = (db.prepare(
      'SELECT v.aid AS aid, v.title AS title, v.up_name AS up_name FROM cand_video cv '
      + 'JOIN lake_videos v ON v.aid=cv.aid WHERE cv.cid=? ORDER BY cv.ts DESC LIMIT 5',
    ).all(cand.cid) as Row[]).map((r) => ({
      aid: r.aid as number, title: r.title as string, up_name: (r.up_name as string | null) ?? undefined,
    }))
    const related = cand.related.map((r) => {
      const m = entries.get(db, r.id)
      return { id: r.id, type: r.type, score: r.score, name: m ? m.name : '?' }
    })
    return {
      payload: {
        round: Number(kvGet(db, 'surf_round', '0') || 0),
        candidate: present.candDict(cand),
        videos: vids,
        related,
      },
      human: present.renderFocus(cand, vids, related),
    }
  }

  if (opts.more) {
    const roundId = Number(kvGet(db, 'surf_round', '0') || 0)
    const page = Number(kvGet(db, 'surf_page', '0') || 0) + 1
    kvSet(db, 'surf_page', String(page))
    const zones = buildZones(db, cfg, page, roundSize)
    return {
      payload: zones,
      human: present.renderZones(zones, present.pageFooter(page, zones.has_more, roundSize)),
    }
  }

  // ---- 新一轮 ----
  const queuedDone = await processQueue(db, cfg, opts.llm ?? null)
  const run = db.prepare('INSERT INTO surf_runs(started_at, fetched) VALUES(?, 0)').run(nowIso())
  const roundId = Number(run.lastInsertRowid)

  let fetchNote: string | null = null
  let fres: FetchResult | null = null
  if (opts.noFetch) {
    fetchNote = '本轮 no_fetch（存量模式）'
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
  const trans = lifecycle.transitionCandidates(db, cfg.lifecycle, roundId)
  notes.dedupe(db)

  kvSet(db, 'surf_round', String(roundId))
  kvSet(db, 'surf_page', '0')
  kvSet(db, 'surf_hotwords', JSON.stringify(fres ? fres.hot_keywords : []))

  const zones = buildZones(db, cfg, 0, roundSize, opts.full)
  zones.round = roundId
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
  zones.queued_inductions_done = queuedDone
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

export { resolveSessdata }
