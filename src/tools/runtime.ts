/**
 * 工具运行时：插件生命周期内共享的库连接与归纳客户端。
 * MemeError 在此转模型可读文本（错误码 + 建议），再由注册表统一标 isError。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { connect } from '../db.ts'
import { resolveConfig, type Config, type ResolvedConfig } from '../config.ts'
import { MemeError } from '../errors.ts'
import { hybridSearch } from '../retrieve/fuse.ts'
import type { LlmClient } from '../induct/llm.ts'
import { WireLlm } from '../induct/llm.ts'
import { HarnessLlm } from './harness-llm.ts'

export interface Runtime {
  readonly cfg: ResolvedConfig
  /** 库连接（首次使用时打开，插件卸载时关闭）。 */
  db(): DatabaseSync
  /** 归纳客户端：宿主 llm 服务优先，回落 wire 直连。 */
  llm(): LlmClient
}

export function createRuntime(ctx: Context, config: Config): Runtime {
  const cfg = resolveConfig(config)
  let db: DatabaseSync | null = null
  const dbOf = () => (db ??= connect(cfg.dbPath))
  ctx.effect(() => () => {
    db?.close()
    db = null
  })
  const llm = (): LlmClient => {
    const harness = ctx.get('llm')
    return harness ? new HarnessLlm(ctx, cfg) : new WireLlm(cfg.induction)
  }
  return { cfg, db: dbOf, llm }
}

/** MemeError → 模型可读错误（错误码 + 摘要 + 近似 + 建议）。 */
export function toToolError(e: unknown): Error {
  if (e instanceof MemeError) {
    const err = new Error(e.render())
    err.name = e.code
    return err
  }
  return e instanceof Error ? e : new Error(String(e))
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

/** 开放对象输出：声明主要字段（canonical value 即 JSON 载荷），额外键放行。 */
export function openOut<P extends Record<string, { type: 'string' | 'boolean' | 'integer' | 'json'; description?: string }>>(
  properties: P,
) {
  return { schema: { type: 'object' as const, properties, additionalProperties: true as const } }
}
