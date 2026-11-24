/**
 * 群聊采集缓冲：bot 收到的每条群消息先进内存队列，攒批直写原始湖。
 * 同进程直写（不经 CLI spawn）：WAL + busy_timeout 下与 surf CLI 进程并发安全。
 * 采集是纯旁路——flush 失败只记日志丢弃，绝不向群聊会话抛错。
 */
import type { DatabaseSync } from 'node:sqlite'
import { ingestGroupMessages, type IngestGroupMessage } from '../lake.ts'

export class CollectBuffer {
  private queue: IngestGroupMessage[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushing = false

  constructor(
    private readonly db: DatabaseSync,
    private readonly flushSize = 200,
    private readonly flushMs = 30_000,
    private readonly log: (line: string) => void = (l) => console.error(`[qq-collect] ${l}`),
  ) {}

  push(m: IngestGroupMessage): void {
    if (!m.msg_id || !m.group || !m.content.trim()) return
    this.queue.push(m)
    if (this.queue.length >= this.flushSize) {
      void this.flush()
      return
    }
    if (this.timer === null) {
      const t = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.flushMs)
      t.unref?.()
      this.timer = t
    }
  }

  /** 攒批直写；flush 进行中到达的消息并入下一批。 */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, this.queue.length)
    try {
      const res = ingestGroupMessages(this.db, batch)
      if (res.inserted > 0) this.log(`群聊入池 ${res.inserted} 条（重复跳过 ${res.duplicates}）`)
    } catch (e) {
      this.log(`flush 失败丢弃 ${batch.length} 条：${e instanceof Error ? e.message : e}`)
    } finally {
      this.flushing = false
    }
    if (this.queue.length >= this.flushSize) void this.flush()
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}
