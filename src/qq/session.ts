/**
 * QQ 会话管理（精简版）：scope+peer 一个 agent 会话，key→sessionId 映射持久化
 * 在 meme 库 kv_meta（qq_session_map），重启后 resume 恢复。复用宿主
 * agents.create/resume；不做 model 路由、preset 切换、fork 与空闲回收
 * （单群部署会话数个位数，宿主默认路由即可）。同 key 单飞（singleflight），
 * 避免同 peer 并发消息开出两个会话。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DatabaseSync } from 'node:sqlite'
import { kvGet, kvSet } from '../db.ts'

export interface ReplyTarget {
  scope: 'group' | 'c2c'
  targetId: string
  msgId?: string
}

export interface SessionRecord {
  sessionKey: string
  sessionId: string
  agent: Agent
  replyTarget: ReplyTarget
  lastActivity: number
}

const PREFS_KEY = 'qq_session_map'

export class QQSessions {
  private records = new Map<string, SessionRecord>()
  private inflight = new Map<string, Promise<SessionRecord>>()
  /** 处置句柄：能 dispose 则保留（create 返回的），resume 场景宿主自管。 */
  private disposers = new Map<string, () => Promise<void>>()

  constructor(
    private readonly ctx: Context,
    private readonly db: DatabaseSync,
    private readonly cwd: string,
    private readonly log: (line: string) => void = (l) => console.error(`[qq-session] ${l}`),
  ) {}

  private key(scope: 'group' | 'c2c', peerId: string): string {
    return `qqbot:${scope}:${peerId}`
  }

  private prefs(): Record<string, string> {
    try {
      return JSON.parse(kvGet(this.db, PREFS_KEY, '{}') || '{}') as Record<string, string>
    } catch {
      return {}
    }
  }

  private persist(key: string, sessionId: string): void {
    const prefs = this.prefs()
    if (prefs[key] === sessionId) return
    prefs[key] = sessionId
    kvSet(this.db, PREFS_KEY, JSON.stringify(prefs))
  }

  /** 按 sessionId 找会话（回复路由用）。 */
  bySessionId(sessionId: string): SessionRecord | undefined {
    for (const r of this.records.values()) {
      if (r.sessionId === sessionId) return r
    }
    return undefined
  }

  async getOrCreate(scope: 'group' | 'c2c', peerId: string, replyTarget: ReplyTarget): Promise<SessionRecord> {
    const key = this.key(scope, peerId)
    const live = this.records.get(key)
    if (live) {
      live.lastActivity = Date.now()
      return live
    }
    const pending = this.inflight.get(key)
    if (pending) return pending
    const opening = this.open(key, replyTarget).finally(() => this.inflight.delete(key))
    this.inflight.set(key, opening)
    return opening
  }

  private async open(key: string, replyTarget: ReplyTarget): Promise<SessionRecord> {
    const saved = this.prefs()[key]
    const sessionId = saved ? SessionId(saved) : undefined
    const agents = this.ctx.agents
    if (sessionId) {
      const found = agents.get(sessionId)
      if (found) {
        this.log(`复用进程内会话：key=${key}`)
        return this.attach(key, String(sessionId), found, replyTarget)
      }
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId })
        this.log(`resume 会话：key=${key}`)
        return this.attach(key, String(sessionId), handle.agent, replyTarget, handle.dispose)
      } catch (e) {
        // resume 失败（会话已不在/被占用）：落回新建，不阻塞消息
        this.log(`resume 失败改新建：key=${key}（${e instanceof Error ? e.message : e}）`)
      }
    }
    const minted = SessionId(`session-${randomUUID()}`)
    const handle = await agents.create({ sessionId: minted, meta: { cwd: this.cwd } })
    this.persist(key, String(minted))
    this.log(`新建会话：key=${key} id=${String(minted)}`)
    return this.attach(key, String(minted), handle.agent, replyTarget, handle.dispose)
  }

  private attach(key: string, sessionId: string, agent: Agent, replyTarget: ReplyTarget, dispose?: () => Promise<void>): SessionRecord {
    if (dispose) this.disposers.set(key, dispose)
    const record: SessionRecord = { sessionKey: key, sessionId, agent, replyTarget, lastActivity: Date.now() }
    this.records.set(key, record)
    return record
  }

  /** 投递用户消息进 agent 回合（fire-and-forget；回合收敛由宿主驱动）。 */
  send(record: SessionRecord, text: string): void {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    record.agent.followup(message)
  }

  async dispose(): Promise<void> {
    this.records.clear()
    const handles = [...this.disposers.values()]
    this.disposers.clear()
    await Promise.allSettled(handles.map((d) => d()))
  }
}
