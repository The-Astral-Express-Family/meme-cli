/**
 * 爆发检测（v0.11）：Kleinberg 爆发自动机（KDD 2002）替换旧 z-score。
 *
 * 旧实现的痛点：z-score 需要手选对照窗口，冷启动恒 None，且无法区分
 * "持续高热"与"真正的爆发起点"。Kleinberg 把日粒度事件流建模为多状态
 * 自动机：状态 i 的期望事件率 = 基线率 × 2^(γ·i)，状态跃迁有代价，对
 * "日计数序列"做 Viterbi 求最优状态序列——burst 等级 = 最近所处状态层。
 *
 * 输出 [level, 有效天数]：level=null 表示序列太短（冷启动，触发层的
 * "新物跨视频"信号兜底）；level≥1 表示处于爆发态（等级越高越强）。
 * level 写入 candidates.z_score 列复用（呈现层标注 b=等级）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'

const LEVELS = 3 // 状态数（0=基线 1=爆发 2=强爆发）
const GAMMA = 1.0 // 每层速率倍增 2^γ
const MIN_DAYS = 3 // 少于此天数不给等级（冷启动）
const TRANSITION_SCALE = 3.0 // 跃迁代价系数（约 = log 序列长度的量级）

/** 日计数序列（day → cnt，缺日补零由调用方保证或在此补齐）。 */
function dailySeries(db: DatabaseSync, table: 'phrase_daily' | 'skel_daily', key: string): number[] {
  const col = table === 'phrase_daily' ? 'phrase' : 'skel'
  const rows = db.prepare(`SELECT day, cnt FROM ${table} WHERE ${col}=? ORDER BY day`).all(key) as Row[]
  if (!rows.length) return []
  // 补齐日历缺口（surf 非每日进行，缺口日计数为 0）
  const byDay = new Map(rows.map((r) => [r.day as string, r.cnt as number]))
  const series: number[] = []
  let cur = new Date(`${rows[0].day as string}T00:00:00`)
  const end = new Date(`${rows[rows.length - 1].day as string}T00:00:00`)
  for (;;) {
    const p = (n: number) => String(n).padStart(2, '0')
    const iso = `${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())}`
    series.push(byDay.get(iso) ?? 0)
    if (iso === rows[rows.length - 1].day) break
    cur = new Date(cur.getTime() + 86400_000)
    if (series.length > 400) break // 防御序列异常
  }
  return series
}

/**
 * Kleinberg 爆发等级。返回 [level, 有效天数]。
 * 基线率 = 全序列均值（对持续高热的词，均值高 → 难再升层；对新词，
 * 均值低 → 单日突增即升层——爆发语义正确）。
 */
export function burstLevel(
  db: DatabaseSync,
  table: 'phrase_daily' | 'skel_daily',
  key: string,
): [number | null, number] {
  const series = dailySeries(db, table, key)
  const activeDays = series.filter((x) => x > 0).length
  if (series.length < MIN_DAYS || activeDays === 0) return [null, activeDays]
  const total = series.reduce((a, b) => a + b, 0)
  const baseRate = Math.max(total / series.length, 0.2) // 平滑：全零近序列的比率不塌到 0
  const rates = Array.from({ length: LEVELS }, (_, i) => baseRate * Math.pow(2, GAMMA * i))
  // Viterbi：emission = Poisson 负对数（去常数项 λ - x·lnλ）；transition = |i-j|·scale
  const negInf = -1e18
  const cost: number[][] = series.map(() => Array.from({ length: LEVELS }, () => 0))
  for (let t = 0; t < series.length; t++) {
    const x = series[t]
    for (let s = 0; s < LEVELS; s++) {
      const lam = rates[s]
      cost[t][s] = lam - x * Math.log(lam)
    }
  }
  const dp: number[][] = series.map(() => Array.from({ length: LEVELS }, () => negInf))
  const back: number[][] = series.map(() => Array.from({ length: LEVELS }, () => 0))
  for (let s = 0; s < LEVELS; s++) dp[0][s] = cost[0][s]
  for (let t = 1; t < series.length; t++) {
    for (let s = 0; s < LEVELS; s++) {
      let best = negInf
      let arg = 0
      for (let p = 0; p < LEVELS; p++) {
        const c = dp[t - 1][p] + (p === s ? 0 : TRANSITION_SCALE) + cost[t][s]
        if (c > best) {
          best = c
          arg = p
        }
      }
      dp[t][s] = best
      back[t][s] = arg
    }
  }
  // 最优末状态
  let end = 0
  for (let s = 1; s < LEVELS; s++) if (dp[series.length - 1][s] > dp[series.length - 1][end]) end = s
  return [end, activeDays]
}
