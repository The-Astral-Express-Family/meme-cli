/**
 * QQ 群聊 bot（内置桥接）：官方 SDK 直连（@tencent-connect/qqbot-nodejs，
 * 可选依赖），一条中间件链同时服务两个职责——
 * ①采集：每条群消息（含未 @bot）清洗后镜像进梗池（CollectBuffer → 原始湖
 *   round_id=0，下一轮 surf 认领一并计算）；
 * ②桥接：@bot 消息进 dsh agent 会话（followup），回复经 session/event 路由
 *   回 QQ（非流式文本分块）。
 * 凭据：config.json qq 段（app_id/app_secret），环境变量 QQBOT_APPID/QQBOT_SECRET
 * 可覆盖。一期不做：流式回复、斜杠命令、配对码、富媒体交互。
 */
import type { Context } from '@deepseek-ai/cordis'
import { connect } from '../db.ts'
import type { QQConfig } from '../config.ts'
import { CollectBuffer } from './collect.ts'
import { assembleAgentBody } from './inbound.ts'
import { QQSessions, type ReplyTarget } from './session.ts'

/** QQ 单条文本消息上限（与 dsh-qqbot 同值）。 */
const CHUNK_LIMIT = 4500

export interface QQBotHandle {
  stop: () => Promise<void>
}

/** QQ 事件时间戳 → 毫秒（解析失败用当前时刻，群聊采集对时刻精度不敏感）。 */
function tsMs(timestamp: string | undefined): number {
  if (timestamp) {
    const t = Date.parse(timestamp)
    if (Number.isFinite(t)) return t
    const n = Number(timestamp)
    if (Number.isFinite(n) && n > 0) return n
  }
  return Date.now()
}

/** 采集镜像的轻清洗：@标记与表情标签只产生噪音 token，剥离（与 SDK sanitizer 同规）。 */
function stripNoise(content: string, appId: string): string {
  return content
    .replaceAll(`<@!${appId}>`, '')
    .replaceAll(`<@${appId}>`, '')
    .replace(/<face,id=\d+\/?>/g, '')
    .replace(/<faceType=\d+,faceId="[^"]*",ext="[^"]*">/g, '')
    .trim()
}

/** 逐词贪心分块（在换行处优先断开）。 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 启动 bot（常驻）；返回 stop 句柄。永不向调用方抛入站消息错误（全兜日志）。 */
export async function startQQBot(args: { ctx: Context; cfg: QQConfig; dbPath: string }): Promise<QQBotHandle> {
  const { ctx, cfg, dbPath } = args
  const log: (line: string) => void = (l) => console.error(`[qq-bot] ${l}`)

  const appId = process.env.QQBOT_APPID?.trim() || cfg.app_id
  const appSecret = process.env.QQBOT_SECRET?.trim() || cfg.app_secret
  if (!appId || !appSecret) {
    throw new Error('QQ 凭据缺失：config.json qq 段（app_id/app_secret）或环境变量 QQBOT_APPID/QQBOT_SECRET')
  }

  // SDK 是可选依赖：配了 qq 段但没装包 → 明确报错指路（core CLI 不依赖它）
  const sdk = await import('@tencent-connect/qqbot-nodejs').catch(() => null)
  if (!sdk) {
    throw new Error('QQ SDK 未安装：npm i（optionalDependencies 默认安装 @tencent-connect/qqbot-nodejs）')
  }

  const db = connect(dbPath)
  const buffer = new CollectBuffer(db, 200, 30_000, log)
  const sessions = new QQSessions(ctx, db, process.cwd(), log)

  const bot = new sdk.QQBot({
    appId,
    appSecret,
    logger: {
      info: (m: string) => console.error(`[qq-gw] ${m}`),
      warn: (m: string) => console.error(`[qq-gw] WARN ${m}`),
      error: (m: string) => console.error(`[qq-gw] ERROR ${m}`),
      debug: (m: string) => { if (process.env.MEME_QQ_DEBUG === '1') console.error(`[qq-gw] DEBUG ${m}`) },
    },
  })

  // ── 中间件链（洋葱模型，顺序对齐 dsh-qqbot）──
  // 1. 回声 + 去重
  bot.use(sdk.messageFilter())
  // 2. 群历史缓冲（@ 门之前，未 @ 消息也计入上下文）
  bot.use(sdk.historyBuffer({
    limit: 10,
    recordOnSkip: true,
    groupKey: (c) => (c.message.kind === 'group' ? c.message.groupOpenid : undefined),
  }))
  // 3. 采集镜像：挂在 @ 门之前——未 @bot 的群消息同样进梗池（这是采梗的主粮）。
  //    白名单（group_allow）在此承担访问控制：名单外的群不镜像。
  bot.use(async (mctx, next) => {
    try {
      const m = mctx.message
      if (m.kind === 'group') {
        const gid = m.groupOpenid ?? ''
        if (gid && (!cfg.group_allow.length || cfg.group_allow.includes(gid))) {
          buffer.push({
            msg_id: m.messageId,
            group: gid,
            group_name: gid,
            sender: m.senderId,
            sender_name: m.senderName,
            content: stripNoise(m.content, appId),
            ts_ms: tsMs(m.timestamp),
          })
        }
      }
    } catch (e) {
      log(`镜像失败（忽略）：${e instanceof Error ? e.message : e}`)
    }
    await next()
  })
  // 4. 群聊 @bot 门控（require_mention=false 时所有群消息都进 agent）
  bot.use(sdk.mentionGate({ requireMentionInGroup: cfg.require_mention }))
  // 5. 内容清洗（agent 看到的文本：去 @marker/表情标签/多余空白）
  bot.use(sdk.contentSanitizer())
  // 6. 上下文组装（history + quote + sender → state）
  bot.use(sdk.envelopeFormatter({ historyLimit: 10, includeQuote: true, includeSender: true }))

  // ── 终端处理：过完门的消息进 agent 会话 ──
  bot.on('message', async (mctx) => {
    try {
      const m = mctx.message
      const scope = m.kind === 'group' ? 'group' : 'c2c'
      const peerId = scope === 'group' ? (m.groupOpenid ?? m.senderId) : m.senderId
      const state = mctx.state as {
        mention?: { wasMentioned?: boolean }
        history?: Array<{ senderId: string; senderName?: string; content: string }>
        quote?: { text?: string; entry?: { content?: string } }
      }
      const body = assembleAgentBody({
        content: m.content,
        senderId: m.senderId,
        senderName: m.senderName,
        scope,
        wasMentioned: state.mention?.wasMentioned ?? false,
        history: state.history,
        quoteText: state.quote?.text ?? state.quote?.entry?.content,
      })
      if (!body) return
      const replyTarget: ReplyTarget = { scope, targetId: peerId, msgId: m.messageId }
      const record = await sessions.getOrCreate(scope, peerId, replyTarget)
      sessions.send(record, body)
    } catch (e) {
      log(`入站处理失败：${e instanceof Error ? e.message : e}`)
    }
  })

  bot.on('error', (err: Error) => log(`网关错误：${err.message}`))

  // ── 回复路由：agent 会话的 assistant/message → QQ 文本分块 ──
  ctx.on('session/event', ((session: { id: string }, event: { type: string; data: Record<string, unknown> }) => {
    if (event.type !== 'assistant/message') return
    const record = sessions.bySessionId(String(session.id))
    if (!record) return
    const blocks = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    if (!text.trim()) return
    for (const chunk of chunkText(text, CHUNK_LIMIT)) {
      void bot.sendText(record.replyTarget, chunk).catch((e: unknown) => {
        log(`回复发送失败：${e instanceof Error ? e.message : e}`)
      })
    }
  }) as never, { global: true } as never)

  // start() 在连接关闭/重试耗尽时才 resolve/reject；fire-and-forget，全兜日志
  void bot.start().catch((e: unknown) => {
    log(`网关退出：${e instanceof Error ? e.message : e}`)
  })
  log(`已启动：appId=${appId} require_mention=${cfg.require_mention} 白名单群=${cfg.group_allow.length || '全部'}`)

  return {
    stop: async () => {
      try {
        bot.stop()
      } catch { /* 已停 */ }
      await buffer.dispose()
      await sessions.dispose()
    },
  }
}
