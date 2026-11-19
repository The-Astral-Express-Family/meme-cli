/**
 * CLI 运行时：一次进程调用的库连接与归纳客户端（无 cordis 依赖）。
 * 生命周期 = 单次命令：main 里 try/finally close。
 */
import type { DatabaseSync } from 'node:sqlite'
import { connect } from '../db.ts'
import type { ResolvedConfig } from '../config.ts'
import { hybridSearch } from '../retrieve/fuse.ts'
import { hasLlmCredential, WireLlm, type LlmClient } from '../induct/llm.ts'

export interface Runtime {
  readonly cfg: ResolvedConfig
  /** 库连接（首次使用时打开，进程结束时 close）。 */
  db(): DatabaseSync
  /** 归纳客户端（懒构造；凭证缺失在调用时报 MEME_LLM_NO_CREDENTIAL）。 */
  llm(): LlmClient
  /** 凭证就位才给客户端，否则 null——surf 用它让排队归纳静默重新排队。 */
  llmOrNull(): LlmClient | null
  close(): void
}

export function openRuntime(cfg: ResolvedConfig): Runtime {
  let db: DatabaseSync | null = null
  let llm: WireLlm | null = null
  return {
    cfg,
    db: () => (db ??= connect(cfg.dbPath)),
    llm: () => (llm ??= new WireLlm(cfg.induction)),
    llmOrNull: () => (hasLlmCredential(cfg.induction) ? (llm ??= new WireLlm(cfg.induction)) : null),
    close: () => {
      db?.close()
      db = null
    },
  }
}

/** 近似词条建议（not-found 报错附带；尽力而为）。 */
export async function nearby(rt: Runtime, ref: string): Promise<Array<{ id: string; name: string; score: number }>> {
  try {
    const rs = await hybridSearch(rt.db(), ref, rt.cfg.retrieval, { top: 3, includeArchived: true })
    return rs.map((r) => ({ id: r.meme.id, name: r.meme.name, score: r.score }))
  } catch {
    return []
  }
}
