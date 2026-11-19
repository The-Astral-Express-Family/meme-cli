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
  '可先用 meme_add 收录裸文本（observing 入库），或 meme_note 记录疑点。',
  nearby.slice(0, 3),
)

export const candidateNotFound = (cid: string): MemeError => new MemeError(
  'CANDIDATE_NOT_FOUND',
  `未找到候选：${cid}`,
  '用 meme_surf 翻看候选，或 meme_search 核对是否已有同形词条。',
)

export const llmNoCredential = (hint = ''): MemeError => new MemeError(
  'MEME_LLM_NO_CREDENTIAL',
  `归纳器缺少模型凭证：环境变量 DEEPSEEK_API_KEY 未设置${hint ? `（${hint}）` : ''}`,
  '设置 DEEPSEEK_API_KEY 后重试；read path（lookup/search/show）不需要凭证。'
  + '更推荐 meme_add 的 entry 路径：操作员亲写词条，零外部 LLM 调用。',
)

export const llmCallFailed = (detail: string): MemeError => new MemeError(
  'MEME_LLM_CALL_FAILED',
  `归纳器调用失败：${detail}`,
  '稍后重试 meme_add；候选证据已保留在队列中，不会丢失。也可用 meme_note 先记一笔。',
)

export const budgetExceeded = (queued: number): MemeError => new MemeError(
  'MEME_BUDGET_EXCEEDED',
  `归纳日预算已用尽，本次触发已进入排队（当前排队 ${queued} 条）。`,
  '等待下一轮 surf 自动处理排队候选，或调大配置 induction.dailyCallBudget。',
)

export const dbForeign = (path: string): MemeError => new MemeError(
  'MEME_DB_FOREIGN',
  `数据库文件不是 meme 库或版本过新：${path}`,
  '检查 dbPath 配置是否指向了 meme 创建的库文件。',
)
