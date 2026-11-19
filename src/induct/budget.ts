/** 归纳日预算：kv_meta 计数，超限触发候选排队等下一轮 surf。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { kvGet, kvSet } from '../db.ts'
import { nowIso } from '../models.ts'

const today = (): string => nowIso().slice(0, 10)

/** (今日调用数, 今日 token 数)。跨天自动清零。 */
export function usedToday(db: DatabaseSync): [number, number] {
  const day = today()
  if (kvGet(db, 'budget_day') !== day) {
    kvSet(db, 'budget_day', day)
    kvSet(db, 'budget_calls', '0')
    kvSet(db, 'budget_tokens', '0')
    return [0, 0]
  }
  return [Number(kvGet(db, 'budget_calls', '0') || 0), Number(kvGet(db, 'budget_tokens', '0') || 0)]
}

export function canSpend(db: DatabaseSync, dailyCalls: number): boolean {
  const [calls] = usedToday(db)
  return calls < dailyCalls
}

export function spend(db: DatabaseSync, tokens: number): void {
  const [calls, tok] = usedToday(db)
  kvSet(db, 'budget_calls', String(calls + 1))
  kvSet(db, 'budget_tokens', String(tok + tokens))
}

/** 预算耗尽 → 排队（候选 id 或裸文本上下文）。返回当前排队数。 */
export function enqueue(db: DatabaseSync, cid: string | null, ctx: string | null): number {
  const key = cid || `text:${(ctx || '').slice(0, 40)}`
  db.prepare('INSERT OR IGNORE INTO induction_queue(cid, ctx, queued_at) VALUES(?,?,?)')
    .run(key, ctx, nowIso())
  return (db.prepare('SELECT COUNT(*) AS c FROM induction_queue').get() as Row).c as number
}

export function dequeueAll(db: DatabaseSync): Row[] {
  const rows = db.prepare('SELECT * FROM induction_queue ORDER BY queued_at').all() as Row[]
  db.exec('DELETE FROM induction_queue')
  return rows
}
