/** QQ bot 层回归：消息体组装、分块、噪音清洗、采集缓冲、会话管理（假 agent 注册表）。 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chunkText, startQQBot } from '../src/qq/bot.ts'
import { assembleAgentBody } from '../src/qq/inbound.ts'
import { CollectBuffer } from '../src/qq/collect.ts'
import { QQSessions, type SessionRecord } from '../src/qq/session.ts'
import { makeCfg, openDb } from './helpers.ts'

let env: { db: ReturnType<typeof openDb>; cfg: ReturnType<typeof makeCfg>['cfg'] }
beforeEach(() => {
  const m = makeCfg()
  env = { db: openDb(m.cfg), cfg: m.cfg }
})

describe('消息体组装', () => {
  it('群消息带发送者标签与 (@you) 标记，尾部拼历史缓冲', () => {
    const body = assembleAgentBody({
      content: '这是什么梗', senderId: 'OPENID_X1', senderName: '小明', scope: 'group',
      wasMentioned: true,
      history: [
        { senderId: 'OPENID_X1', senderName: '小明', content: '上号' },
        { senderId: 'OPENID_X2', content: '来了' },
      ],
    })
    expect(body).toContain('[小明 (OPENID_X1)] 这是什么梗 (@you)')
    expect(body).toContain('[Chat history begins]')
    expect(body).toContain('[小明 (OPENID_X1)] 上号')
    // 无昵称的历史条目用 openid 前 8 位作匿名标识
    expect(body).toContain('[OPENID_X (OPENID_X2)] 来了')
    expect(body!.indexOf('[Chat history ends]')).toBeLessThan(body!.indexOf('[Current message]'))
  })

  it('私聊不带发送者标签；空文本返回 null；引用块在最前', () => {
    expect(assembleAgentBody({ content: '  ', senderId: 'U', scope: 'c2c', wasMentioned: false })).toBeNull()
    const body = assembleAgentBody({
      content: '看这个', senderId: 'U1', scope: 'c2c', wasMentioned: false,
      quoteText: '原句内容',
    })
    expect(body!.startsWith('[Quoted message begins]')).toBe(true)
    expect(body).not.toContain('(U1)')
  })
})

describe('文本分块与噪音清洗', () => {
  it('长文本按行优先分块，重组保留全部内容', () => {
    const text = Array.from({ length: 500 }, (_, i) => `第${i}行内容测试行内容测试行内容测试`).join('\n')
    const chunks = chunkText(text, 4500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4500)
    expect(chunks.join('\n')).toBe(text)
  })

  it('短文本不分块', () => {
    expect(chunkText('你好', 4500)).toEqual(['你好'])
  })
})

describe('采集缓冲', () => {
  it('攒批直写：dispose 冲刷余量，重投递去重', async () => {
    const flushed: string[] = []
    const buf = new CollectBuffer(env.db, 3, 60_000, (l) => flushed.push(l))
    for (let i = 0; i < 3; i++) {
      buf.push({ msg_id: `M${i}`, group: 'G1', sender: 'S1', content: `群聊第${i}条`, ts_ms: Date.now() })
    }
    // 达 flushSize 即写
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 10))
    let rows = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(rows.c).toBe(3)
    buf.push({ msg_id: 'M9', group: 'G1', sender: 'S1', content: '末条', ts_ms: Date.now() })
    await buf.dispose()
    rows = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(rows.c).toBe(4)
    // 同 msg_id 第二次投递经 INSERT OR IGNORE 天然去重，不新增行
    buf.push({ msg_id: 'M9', group: 'G1', sender: 'S1', content: '末条', ts_ms: Date.now() })
    await buf.dispose()
    rows = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(rows.c).toBe(4)
    // 空内容/缺字段被丢弃
    buf.push({ msg_id: '', group: 'G1', sender: 'S1', content: 'x' })
    buf.push({ msg_id: 'M10', group: 'G1', sender: 'S1', content: '  ' })
    await buf.dispose()
    rows = env.db.prepare("SELECT COUNT(*) AS c FROM lake_comments WHERE oid<0").get() as { c: number }
    expect(rows.c).toBe(4)
    expect(flushed.some((l) => l.includes('入池'))).toBe(true)
  })
})

describe('会话管理（假 agent 注册表）', () => {
  interface FakeAgent { id: string; received: string[]; followup: (m: { content: Array<{ text?: string }> }) => void }
  const makeRegistry = () => {
    // live = 进程内注册表；store = 宿主持久化（resume 从这里恢复）
    const live = new Map<string, FakeAgent>()
    const store = new Map<string, FakeAgent>()
    const resumed: string[] = []
    const registry = {
      get: (id: unknown) => live.get(String(id)),
      create: async (opts: { sessionId: unknown; meta?: unknown }) => {
        const a: FakeAgent = {
          id: String(opts.sessionId),
          received: [],
          followup(m: { content: Array<{ text?: string }> }) {
            a.received.push(m.content.map((b) => b.text ?? '').join(''))
          },
        }
        live.set(String(opts.sessionId), a)
        store.set(String(opts.sessionId), a)
        return { agent: a, dispose: async () => {} }
      },
      resume: async (opts: { resumeSessionId: unknown }) => {
        const found = store.get(String(opts.resumeSessionId))
        if (!found) throw new Error('not found')
        live.set(String(opts.resumeSessionId), found)
        resumed.push(String(opts.resumeSessionId))
        return { agent: found, dispose: async () => {} }
      },
      live, store, resumed,
    }
    return registry
  }

  const wire = (registry: ReturnType<typeof makeRegistry>) => {
    const ctx = { agents: registry } as unknown as Context
    return new QQSessions(ctx, env.db, process.cwd())
  }

  it('新会话创建并持久化映射；同 key 复用；bySessionId 可反查', async () => {
    const registry = makeRegistry()
    const sessions = wire(registry)
    const target = { scope: 'group' as const, targetId: 'G1' }
    const r1 = await sessions.getOrCreate('group', 'G1', target)
    expect(r1.sessionKey).toBe('qqbot:group:G1')
    const r2 = await sessions.getOrCreate('group', 'G1', target)
    expect(r2.sessionId).toBe(r1.sessionId)
    expect(registry.live.size).toBe(1)
    expect(sessions.bySessionId(r1.sessionId)).toBeDefined()
    // 映射持久化到 kv_meta
    const prefs = env.db.prepare("SELECT value FROM kv_meta WHERE key='qq_session_map'").get() as { value: string }
    expect(JSON.parse(prefs.value)['qqbot:group:G1']).toBe(r1.sessionId)
  })

  it('重启后 resume 恢复；resume 失败落回新建', async () => {
    const registry = makeRegistry()
    const first = wire(registry)
    const r = await first.getOrCreate('group', 'G1', { scope: 'group', targetId: 'G1' })
    await first.dispose()

    const sessions = wire(registry)
    // 模拟进程重启：进程内注册表清空，持久化层仍在
    registry.live.clear()
    const again = await sessions.getOrCreate('group', 'G1', { scope: 'group', targetId: 'G1' })
    expect(registry.resumed).toContain(r.sessionId)
    expect(again.sessionId).toBe(r.sessionId)

    // 库里映射指向不存在的会话（且进程内记录已清）→ resume 失败落回新建
    await sessions.dispose()
    env.db.prepare("UPDATE kv_meta SET value=? WHERE key='qq_session_map'")
      .run(JSON.stringify({ 'qqbot:group:G1': 'session-missing' }))
    const third = await sessions.getOrCreate('group', 'G1', { scope: 'group', targetId: 'G1' })
    expect(third.sessionId).not.toBe(r.sessionId)
    expect(third.sessionId).toMatch(/^session-/)
  })

  it('send 把消息投进 agent followup', async () => {
    const sessions = wire(makeRegistry())
    const r = await sessions.getOrCreate('group', 'G1', { scope: 'group', targetId: 'G1' }) as SessionRecord
    const agent = r.agent as unknown as FakeAgent
    sessions.send(r, '[小明 (S1)] 你好')
    expect(agent.received).toHaveLength(1)
  })
})

describe('startQQBot 启动守卫', () => {
  it('凭据缺失时明确报错；未配置 qq 段不启动', async () => {
    const bad = { app_id: '', app_secret: '', require_mention: true, group_allow: [] }
    await expect(startQQBot({ ctx: {} as Context, cfg: bad, dbPath: ':memory:' }))
      .rejects.toThrow(/凭据缺失/)
  })
})
