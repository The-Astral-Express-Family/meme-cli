/**
 * Harness LLM 适配器：把归纳器的 complete() 契约落到宿主的 llm 服务上。
 * 好处：吃 harness 已配置的 provider/凭证，无需单独的 DEEPSEEK_API_KEY。
 * 一次调用 = 单次 provider 尝试（与 LlmRuntime 契约一致，不在此层重试）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LLMResult, LlmClient } from '../induct/llm.ts'
import type { ResolvedConfig } from '../config.ts'

interface MinimalStreamChunk {
  type: string
  text?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  reason?: string
}

export class HarnessLlm implements LlmClient {
  private provider: string | null = null

  constructor(
    private readonly ctx: Context,
    private readonly cfg: ResolvedConfig,
  ) {}

  private async resolveProvider(): Promise<string> {
    if (this.provider) return this.provider
    if (this.cfg.llmProvider) {
      this.provider = this.cfg.llmProvider
      return this.provider
    }
    const providers = this.ctx.llm.listProviders()
    if (!providers.length) throw new Error('harness 未注册任何 llm provider')
    this.provider = providers[0]!.id
    return this.provider
  }

  async complete(system: string, user: string, opts: {
    model?: string
    effort?: string
    maxTokens?: number
    signal?: AbortSignal
  } = {}): Promise<LLMResult> {
    const provider = await this.resolveProvider()
    const model = opts.model ?? this.cfg.induction.model
    const effort = (opts.effort ?? this.cfg.induction.reasoning_effort)
    const chunks: string[] = []
    const usage: { input_tokens?: number; output_tokens?: number } = {}
    let stopReason: string | null = null
    const stream = this.ctx.llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: opts.maxTokens ?? this.cfg.induction.max_tokens,
      ...(effort !== 'off' ? { reasoningEffort: effort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      // reasoningEffort 是品牌化的字符串 id；配置值按约定直通
    } as Parameters<typeof this.ctx.llm.stream>[0]) as AsyncIterable<MinimalStreamChunk>
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && chunk.text) chunks.push(chunk.text)
      else if (chunk.type === 'usage' && chunk.usage) {
        usage.input_tokens = chunk.usage.inputTokens
        usage.output_tokens = chunk.usage.outputTokens
      } else if (chunk.type === 'finish') stopReason = chunk.reason ?? null
    }
    if (!chunks.length) throw new Error(`空文本响应（stop_reason=${stopReason}）：max_tokens 可能被思考耗尽`)
    return { text: chunks.join(''), model, usage, stop_reason: stopReason }
  }
}
