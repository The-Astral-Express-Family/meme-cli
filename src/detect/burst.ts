/** 爆发检测：近期窗口日均频次 vs 基线窗口的 z-score。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'

const isoDaysAgo = (today: Date, days: number): string => {
  const d = new Date(today.getTime() - days * 86400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 返回 (z, 有效基线天数)。
 *
 * 冷启动修复（库龄 <14 天时旧实现恒返回 None，6 轮 surf 触发 0 候选）：
 * - 基线 0 天（首轮新物）：z=null，由触发层的"新物跨视频"信号兜底；
 * - 基线 ≥1 天：按实际活跃天数（而非日历天数）做均值——surf 非每日进行，
 *   日历均值会把基线稀释成接近 0，z 虚高。std 加 1 平滑：短基线的方差噪音不放大成信号。
 */
export function zScore(
  db: DatabaseSync,
  table: 'phrase_daily' | 'skel_daily',
  key: string,
  today: Date = new Date(),
  recentDays = 7,
  baselineDays = 90,
): [number | null, number] {
  const keyCol = table === 'phrase_daily' ? 'phrase' : 'skel'
  const todayIso = isoDaysAgo(today, 0)
  const recentStart = isoDaysAgo(today, recentDays - 1)
  const baseEnd = isoDaysAgo(today, recentDays)
  const baseStart = isoDaysAgo(today, recentDays + baselineDays)

  const q = db.prepare(
    `SELECT COALESCE(SUM(cnt),0) AS s, COUNT(DISTINCT day) AS d FROM ${table} `
    + `WHERE ${keyCol}=? AND day>=? AND day<=?`,
  )
  const recent = q.get(key, recentStart, todayIso) as Row
  const base = q.get(key, baseStart, baseEnd) as Row
  const recentSum = recent.s as number
  const recentActive = recent.d as number
  const baseActive = base.d as number
  if (baseActive === 0) return [null, 0]

  // 基线日频方差（窗口收窄到实际存在的日历区间，缺日补零）
  const rows = db.prepare(
    `SELECT day, cnt FROM ${table} WHERE ${keyCol}=? AND day>=? AND day<=? ORDER BY day`,
  ).all(key, baseStart, baseEnd) as Row[]
  const byDay = new Map(rows.map((r) => [r.day as string, r.cnt as number]))
  const filled: number[] = []
  for (let d = new Date(`${baseStart}T00:00:00`); ; d = new Date(d.getTime() + 86400_000)) {
    const iso = isoDaysAgo(d, 0)
    filled.push(byDay.get(iso) ?? 0)
    if (iso === baseEnd) break
  }
  if (!filled.length) return [null, 0]
  const mean = filled.reduce((a, b) => a + b, 0) / filled.length
  const variance = filled.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(filled.length - 1, 1)
  const std = Math.sqrt(variance)
  const recentRate = recentSum / Math.max(recentActive, 1)
  const z = (recentRate - mean) / (std + 1.0)
  return [z, baseActive]
}
