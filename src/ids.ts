/** ID 分配：c_NNNN / m_NNNN 单调递增，一经分配永不回收、永不复用。 */
import type { DatabaseSync } from 'node:sqlite'
import { kvGet, kvSet } from './db.ts'

export function nextId(db: DatabaseSync, kind: 'c' | 'm'): string {
  const cur = Number(kvGet(db, `seq_${kind}`, '0') || '0') + 1
  kvSet(db, `seq_${kind}`, String(cur))
  return `${kind}_${String(cur).padStart(4, '0')}`
}
