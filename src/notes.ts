/** 笔记：操作员的低信任私有附着物。永不进入 matcher 与 card。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from './db.ts'
import { nowIso } from './models.ts'

// type alias（非 interface）：对象字面量别名获得隐式索引签名，可直接作为 Json 载荷
export type Note = {
  id: number
  meme_id: string | null
  head: string | null
  content: string
  created_at: string
  updated_at: string
}

export function add(db: DatabaseSync, content: string, memeId: string | null = null, head: string | null = null): number {
  const ts = nowIso()
  const res = db.prepare('INSERT INTO notes(meme_id,head,content,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(memeId, head, content, ts, ts)
  return Number(res.lastInsertRowid)
}

export function update(db: DatabaseSync, noteId: number, content: string): boolean {
  const res = db.prepare('UPDATE notes SET content=?, updated_at=? WHERE id=?').run(content, nowIso(), noteId)
  return res.changes > 0
}

export function remove(db: DatabaseSync, noteId: number): boolean {
  return db.prepare('DELETE FROM notes WHERE id=?').run(noteId).changes > 0
}

export function get(db: DatabaseSync, noteId: number): Note | null {
  const r = db.prepare('SELECT * FROM notes WHERE id=?').get(noteId) as Row | undefined
  return r ? (r as unknown as Note) : null
}

export function listNotes(db: DatabaseSync, memeId: string | null = null): Note[] {
  const rows = memeId
    ? db.prepare('SELECT * FROM notes WHERE meme_id=? ORDER BY id').all(memeId)
    : db.prepare('SELECT * FROM notes ORDER BY id').all()
  return rows as unknown as Note[]
}

/** 库卫生：删除完全重复的笔记（surf 顺手执行）。去重键含 head——不同词头、相同内容不是重复。 */
export function dedupe(db: DatabaseSync): number {
  const rows = db.prepare(
    "SELECT id, COALESCE(meme_id,'') || '|' || COALESCE(head,'') || '|' || content AS k FROM notes ORDER BY id",
  ).all() as Row[]
  const seen = new Set<string>()
  let removed = 0
  const del = db.prepare('DELETE FROM notes WHERE id=?')
  for (const r of rows) {
    if (seen.has(r.k as string)) {
      del.run(r.id as number)
      removed++
    } else {
      seen.add(r.k as string)
    }
  }
  return removed
}
