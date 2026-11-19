/** 审计日志：归纳与一切 edit 强制记录，错误词条可回溯、可撤销。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { nowIso } from './models.ts'

export type AuditSource = 'surf' | 'lookup' | 'note' | 'add' | 'edit' | 'system'

export function record(
  db: DatabaseSync, memeId: string, action: string, source: AuditSource, payload: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO audit_log(meme_id, action, source, payload, ts) VALUES(?,?,?,?,?)')
    .run(memeId, action, source, JSON.stringify(payload), nowIso())
}

export interface AuditEntry {
  seq: number
  action: string
  source: string
  payload: unknown
  ts: string
}

export function forMeme(db: DatabaseSync, memeId: string): AuditEntry[] {
  const rows = db.prepare('SELECT * FROM audit_log WHERE meme_id=? ORDER BY seq').all(memeId) as Row[]
  return rows.map((r) => ({
    seq: r.seq as number,
    action: r.action as string,
    source: r.source as string,
    payload: JSON.parse(r.payload as string),
    ts: r.ts as string,
  }))
}
