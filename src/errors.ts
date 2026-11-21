/**
 * 类型化错误：稳定 SCREAMING_SNAKE 错误码 + 下一步行动引导。
 * 报错本身在教 agent 下一步做什么；工具层把 MemeError 抛出即 isError。
 */

export interface NearbyRef {
  id: string
  name: string
  score: number
}

export class MemeError extends Error {
  readonly code: string
  readonly suggestion?: string
  readonly nearby: NearbyRef[]

  constructor(code: string, message: string, suggestion?: string, nearby: NearbyRef[] = []) {
    super(message)
    this.name = 'MemeError'
    this.code = code
    this.suggestion = suggestion
    this.nearby = nearby
  }

  /** 模型可读的完整文本：错误码 + 摘要 + 近似词条 + 建议。 */
  render(): string {
    const lines = [`meme: ${this.code}: ${this.message}`]
    for (const nb of this.nearby.slice(0, 3)) {
      lines.push(`  ~ ${nb.id} ${nb.name}（相似度 ${nb.score}）`)
    }
    if (this.suggestion) lines.push(`  建议：${this.suggestion}`)
    return lines.join('\n')
  }

  toDict(): { code: string; message: string; suggestion?: string; nearby?: NearbyRef[] } {
    const d: Record<string, unknown> = { code: this.code, message: this.message }
    if (this.suggestion) d.suggestion = this.suggestion
    if (this.nearby.length) d.nearby = this.nearby.slice(0, 3)
    return d as { code: string; message: string; suggestion?: string; nearby?: NearbyRef[] }
  }
}

export const notFound = (query: string, nearby: NearbyRef[]): MemeError => new MemeError(
  'MEME_NOT_FOUND',
  `未找到词条：${query}`,
  '确认是梗后写 entry 文件再 meme add --entry-file 收录（observing 入库），或 meme note 记录疑点。',
  nearby.slice(0, 3),
)

export const candidateNotFound = (cid: string): MemeError => new MemeError(
  'CANDIDATE_NOT_FOUND',
  `未找到候选：${cid}`,
  '用 meme surf 翻看候选，或 meme search 核对是否已有同形词条。',
)

export const dbForeign = (path: string): MemeError => new MemeError(
  'MEME_DB_FOREIGN',
  `数据库文件不是本版本创建的梗库：${path}`,
  'schema 无迁移路径：删除该文件重建，或把 db_path 指向新库。',
)
