/** ID 分配：c_NNNN / m_NNNN 单调递增，一经分配永不回收、永不复用。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'

const stmts = new WeakMap<DatabaseSync, import('node:sqlite').StatementSync>()

/**
 * 单条 upsert+RETURNING 原子分配：bot 进程与 surf CLI 并发调用也不会拿到同一个号
 * （旧实现 kvGet→+1→kvSet 三步非原子，并发会同号碰撞导致词条互相覆盖）。
 */
export function nextId(db: DatabaseSync, kind: 'c' | 'm'): string {
  let stmt = stmts.get(db)
  if (!stmt) {
    stmt = db.prepare(
      "INSERT INTO kv_meta(key,value) VALUES(?,'1') "
      + 'ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(kv_meta.value AS INTEGER)+1 AS TEXT) '
      + 'RETURNING value',
    )
    stmts.set(db, stmt)
  }
  const row = stmt.get(`seq_${kind}`) as Row
  return `${kind}_${String(Number(row.value)).padStart(4, '0')}`
}
