/** note 工具：低信任笔记增删改查。永不进入 matcher 与 card。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as entries from '../entries.ts'
import { notFound } from '../errors.ts'
import * as notes from '../notes.ts'
import type { Json } from '../models.ts'
import { nearby, openOut, toToolError, type Runtime } from './runtime.ts'

const text = (v: unknown): string => {
  const d = v as Record<string, unknown>
  return typeof d.human === 'string' ? d.human : JSON.stringify(d, null, 1)
}

export function registerNoteTool(ctx: Context, rt: Runtime): void {
  ctx.tools.register(defineTool({
    name: 'meme_note',
    description: '笔记增删改查：低信任私有附着物，永不进入 matcher 与 card。'
      + '词条未建时可挂 head（悬挂笔记，词条建立后仍可查）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'list', 'show', 'edit', 'rm'] },
      ref: { type: 'string', description: '词条 id/名（add/list 用；add 也可不给 ref 只给 head）' },
      head: { type: 'string', description: '悬挂笔记的词头（词条尚不存在时用）' },
      content: { type: 'string', description: '笔记内容（add/edit 用）' },
      note_id: { type: 'integer', description: '笔记 id（show/edit/rm 用）' },
    },
    output: { ...openOut({ action: { type: 'string' }, notes: { type: 'json' }, human: { type: 'string' } }), render: (_a, v) => [{ type: 'text', text: text(v) }] },
    timeoutMs: 60_000,
    async execute(args): Promise<Record<string, Json>> {
      try {
        const db = rt.db()
        if (args.action === 'add') {
          if (!args.content) {
            throw toToolError(new Error('note add 需要 ref（词条）与 content，或 head 与 content。'))
          }
          let memeId: string | null = null
          if (args.ref) {
            const m = entries.resolve(db, args.ref)
            if (!m) throw notFound(args.ref, await nearby(rt, args.ref))
            memeId = m.id
          }
          const nid = notes.add(db, args.content, memeId, args.head ?? null)
          return {
            action: 'add', note_id: nid, meme_id: memeId, head: args.head ?? null,
            content: args.content,
            human: `已记 #${nid}${memeId ? `（${memeId}）` : ''}`,
          }
        }
        if (args.action === 'list') {
          let memeId: string | null = null
          if (args.ref) {
            const m = entries.resolve(db, args.ref)
            if (!m) throw notFound(args.ref, await nearby(rt, args.ref))
            memeId = m.id
          }
          const items = notes.listNotes(db, memeId)
          return {
            action: 'list', notes: items,
            human: items.map((n) => `#${n.id} [${n.meme_id ?? n.head ?? '-'}] ${n.content}`).join('\n') || '（无笔记）',
          }
        }
        const noteId = args.note_id
        if (noteId === undefined) throw toToolError(new Error('show/edit/rm 需要 note_id。'))
        if (args.action === 'show') {
          const n = notes.get(db, noteId)
          if (!n) throw toToolError(new Error(`笔记 #${noteId} 不存在`))
          return { action: 'show', note: n, human: `#${n.id} [${n.meme_id ?? n.head ?? '-'}]\n${n.content}` }
        }
        if (args.action === 'edit') {
          if (!notes.update(db, noteId, args.content ?? '')) {
            throw toToolError(new Error(`笔记 #${noteId} 不存在`))
          }
          return { action: 'edit', note_id: noteId, human: `已改 #${noteId}` }
        }
        if (!notes.remove(db, noteId)) throw toToolError(new Error(`笔记 #${noteId} 不存在`))
        return { action: 'rm', note_id: noteId, human: `已删 #${noteId}` }
      } catch (e) {
        throw toToolError(e)
      }
    },
  }))
}
