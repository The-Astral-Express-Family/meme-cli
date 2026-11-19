/** FTS5 检索（BM25）：查询文本转义为惰性短语，OR 连接求召回。 */
import type { DatabaseSync } from 'node:sqlite'
import type { Row } from '../db.ts'
import { keepToken } from '../detect/ngram.ts'
import { FUNC_WORDS } from '../detect/skel.ts'
import { segment } from '../tokenize.ts'

export function buildMatchQuery(query: string): string {
  let terms = segment(query).filter((t) => keepToken(t) && !FUNC_WORDS.has(t))
  if (!terms.length) terms = [query.trim()]
  // 每个词转义为一个 FTS5 短语（内部双引号翻倍），OR 连接
  const phrases = terms.filter((t) => t.trim()).map((t) => `"${t.replace(/"/g, '""')}"`)
  return phrases.join(' OR ')
}

/** 返回 [(meme_id, 分数)]；bm25() 越小越好，此处归一为越大越好。 */
export function searchFts(db: DatabaseSync, query: string, top = 8): Array<[string, number]> {
  const mq = buildMatchQuery(query)
  if (!mq) return []
  const rows = db.prepare(
    'SELECT meme_id, bm25(memes_fts) AS rank FROM memes_fts '
    + 'WHERE memes_fts MATCH ? ORDER BY rank LIMIT ?',
  ).all(mq, top * 2) as Row[]
  return rows.slice(0, top).map((r) => [r.meme_id as string, -(r.rank as number)])
}
