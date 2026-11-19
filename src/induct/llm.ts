/**
 * Wire LLM 客户端：按 deepseek-harness 官方适配器的 Messages 协议直连。
 *
 * 端点：{induction.base_url | $DEEPSEEK_BASE_URL | 官方 anthropic 端点}/v1/messages
 * 凭证：x-api-key: {induction.api_key | $DEEPSEEK_API_KEY}。
 * 配置文件字段优先——agent shell 会被 harness 剥离密钥类环境变量，
 * agent 驱动的归纳必须走 ~/.meme/config.json；环境变量只对人类终端有效。
 */
import { DEFAULT_BASE_URL, ENV_API_KEY, ENV_BASE_URL, type InductionConfig } from '../config.ts'
import { llmCallFailed, llmNoCredential, MemeError } from '../errors.ts'
import { VERSION } from '../version.ts'

const ANTHROPIC_VERSION = '2023-06-01'

export interface LLMResult {
  text: string
  model: string
  usage: { input_tokens?: number; output_tokens?: number }
  stop_reason: string | null
}

export interface LlmClient {
  complete(system: string, user: string, opts?: {
    model?: string
    effort?: string
    maxTokens?: number
    retries?: number
    signal?: AbortSignal
  }): Promise<LLMResult>
}

/** 可重试的临时故障（限流/过载/5xx/传输层错误）。 */
class Retryable extends Error {}

/** 归纳凭证是否就位（配置字段或环境变量任一）。 */
export function hasLlmCredential(cfg: InductionConfig): boolean {
  return Boolean(cfg.api_key || process.env[ENV_API_KEY])
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })

export class WireLlm implements LlmClient {
  private readonly base: string
  private readonly cfg: InductionConfig

  constructor(cfg: InductionConfig) {
    this.cfg = cfg
    this.base = (cfg.base_url || process.env[ENV_BASE_URL] || DEFAULT_BASE_URL)
      .replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
  }

  private headers(): Record<string, string> {
    const key = this.cfg.api_key || process.env[ENV_API_KEY]
    if (!key) throw llmNoCredential()
    return {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'user-agent': `meme/${VERSION} (dsh-wire)`,
    }
  }

  async complete(system: string, user: string, opts: {
    model?: string; effort?: string; maxTokens?: number; retries?: number; signal?: AbortSignal
  } = {}): Promise<LLMResult> {
    const model = opts.model ?? this.cfg.model
    const effort = opts.effort ?? this.cfg.reasoning_effort
    const retries = opts.retries ?? 2
    const body: Record<string, unknown> = {
      model,
      stream: true,
      max_tokens: opts.maxTokens ?? this.cfg.max_tokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    }
    if (system) body.system = system
    if (effort === 'off') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
      body.output_config = { effort }
    }

    let lastErr: unknown = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.streamOnce(body, model, opts.signal)
      } catch (e) {
        if (e instanceof MemeError) throw e
        if (e instanceof Retryable || e instanceof TypeError /* fetch 网络层 */) {
          lastErr = e
          if (attempt >= retries) break // 末次失败不再白等退避
          const wait = Math.min(2 ** attempt * 1.5, 12)
          console.error(`meme: llm: ${e}（${Math.round(wait)}s 后重试 ${attempt + 1}/${retries}）`)
          await sleep(wait * 1000, opts.signal)
          continue
        }
        throw e
      }
    }
    throw llmCallFailed(`重试耗尽：${lastErr}`)
  }

  private async streamOnce(body: Record<string, unknown>, model: string, signal?: AbortSignal): Promise<LLMResult> {
    const chunks: string[] = []
    const usage: { input_tokens?: number; output_tokens?: number } = {}
    let stopReason: string | null = null
    const headers = this.headers() // 凭证错误（MemeError）在 fetch 之外抛出，不被传输层重试吞噬
    let resp: Response
    try {
      resp = await fetch(`${this.base}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      throw new Retryable(String(e)) // 连接层传输错误：可重试
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new MemeError('MEME_LLM_AUTH', `模型凭证被拒绝（HTTP ${resp.status}）`, '检查 DEEPSEEK_API_KEY 是否有效。')
    }
    if (resp.status === 429) throw new Retryable('RATE_LIMIT')
    if (resp.status >= 500) throw new Retryable(`HTTP ${resp.status}`)
    if (resp.status !== 200) {
      const detail = (await resp.text()).slice(0, 300)
      throw llmCallFailed(`HTTP ${resp.status}: ${detail}`)
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        let ev: Record<string, any>
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        const et = ev.type
        if (et === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          chunks.push(ev.delta.text ?? '')
        } else if (et === 'message_start') {
          usage.input_tokens = ev.message?.usage?.input_tokens ?? 0
        } else if (et === 'message_delta') {
          usage.output_tokens = ev.usage?.output_tokens ?? 0
          stopReason = ev.delta?.stop_reason ?? null
        } else if (et === 'error') {
          const errType = ev.error?.type ?? 'api_error'
          if (['overloaded_error', 'api_error', 'rate_limit_error'].includes(errType)) {
            throw new Retryable(errType)
          }
          throw llmCallFailed(`${errType}: ${ev.error?.message}`)
        }
      }
    }
    if (!chunks.length) {
      // usage 非空但无文本：多半是思考阶段烧尽 max_tokens——重试无意义，报错引导调参
      throw llmCallFailed(
        `空文本响应（stop_reason=${stopReason}）：max_tokens 可能被思考耗尽，可调大 induction.max_tokens`,
      )
    }
    return { text: chunks.join(''), model, usage, stop_reason: stopReason }
  }
}
