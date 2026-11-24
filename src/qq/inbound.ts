/**
 * @bot 消息 → agent 消息体的组装。五层形状剪自 dsh-qqbot 的 MIT 实现
 * （tencent-connect/dsh-qqbot src/transport/inbound.ts），一期只保留文本/
 * 历史/引用/发送者标签，富媒体只留类型标签。
 */

export interface HistoryEntry {
  senderId: string
  senderName?: string
  content: string
}

export interface AssembleInput {
  content: string
  senderId: string
  senderName?: string
  scope: 'group' | 'c2c'
  wasMentioned: boolean
  history?: HistoryEntry[]
  quoteText?: string
}

/** 无昵称时用 openid 前 8 位作匿名标识（与 dsh-qqbot 同规）。 */
function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * 组装 agent 实际看到的完整消息体：
 * `[引用块]` + `[昵称 (openid)] 内容 (@you)` + 尾部拼群历史缓冲。
 * 空文本返回 null（不进 agent）。
 */
export function assembleAgentBody(input: AssembleInput): string | null {
  const text = input.content.trim()
  if (!text) return null

  const quotePart = input.quoteText
    ? `[Quoted message begins]\n${input.quoteText}\n[Quoted message ends]\n[Current message]\n`
    : ''

  const body = input.scope === 'group'
    ? `${quotePart}[${input.senderName ?? shortId(input.senderId)} (${input.senderId})] ${text}${input.wasMentioned ? ' (@you)' : ''}`
    : `${quotePart}${text}`

  if (!input.history?.length) return body
  const lines = input.history.map((h) => `[${h.senderName ?? shortId(h.senderId)} (${h.senderId})] ${h.content}`)
  return ['[Chat history begins]', ...lines, '', '[Chat history ends]', '[Current message]', body].join('\n')
}
