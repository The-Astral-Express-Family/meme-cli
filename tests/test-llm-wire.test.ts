/** Wire LLM 客户端：SSE 解析、凭证缺失、可重试错误分类（不打真网）。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WireLlm } from '../src/induct/llm.ts'
import { resolveConfig } from '../src/config.ts'

const sse = (events: Array<Record<string, unknown>>): Uint8Array => {
  const out = events.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n`)
  return new TextEncoder().encode(out.join('\n'))
}

const mockFetch = (status: number, body?: Uint8Array, capture?: { headers?: Record<string, string>; body?: unknown }) =>
  vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (capture) {
      capture.headers = init?.headers as Record<string, string>
      capture.body = init?.body ? JSON.parse(init.body as string) : undefined
    }
    return new Response(body ?? new Uint8Array(), { status })
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('WireLlm', () => {
  it('SSE 文本聚合 + usage 累计', async () => {
    const body = sse([
      { type: 'message_start', message: { usage: { input_tokens: 25 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '，世界' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ])
    vi.stubGlobal('fetch', mockFetch(200, body))
    vi.stubEnv('DEEPSEEK_API_KEY', 'k-test')
    const llm = new WireLlm(resolveConfig().induction)
    const res = await llm.complete('sys', 'user', { retries: 0 })
    expect(res.text).toBe('你好，世界')
    expect(res.usage).toEqual({ input_tokens: 25, output_tokens: 7 })
    expect(res.stop_reason).toBe('end_turn')
  })

  it('请求体形状匹配 DSH 适配器约定', async () => {
    const cap: { headers?: Record<string, string>; body?: unknown } = {}
    vi.stubGlobal('fetch', mockFetch(200, sse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]), cap))
    vi.stubEnv('DEEPSEEK_API_KEY', 'k-shape')
    const llm = new WireLlm(resolveConfig().induction)
    await llm.complete('sys', 'user', { retries: 0 })
    expect(cap.headers!['x-api-key']).toBe('k-shape')
    expect(cap.headers!['anthropic-version']).toBe('2023-06-01')
    const body = cap.body as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('user')
  })

  it('缺凭证 → 类型化错误', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const llm = new WireLlm(resolveConfig().induction)
    await expect(llm.complete('s', 'u', { retries: 0 })).rejects.toMatchObject({ code: 'MEME_LLM_NO_CREDENTIAL' })
  })

  it('401 不重试，直接报 MEME_LLM_AUTH', async () => {
    vi.stubGlobal('fetch', mockFetch(401))
    vi.stubEnv('DEEPSEEK_API_KEY', 'k-bad')
    const llm = new WireLlm(resolveConfig().induction)
    await expect(llm.complete('s', 'u', { retries: 2 })).rejects.toMatchObject({ code: 'MEME_LLM_AUTH' })
  })

  it('5xx 有界退避重试后耗尽报 MEME_LLM_CALL_FAILED', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'k-5xx')
    const llm = new WireLlm(resolveConfig().induction)
    await expect(llm.complete('s', 'u', { retries: 1 })).rejects.toMatchObject({ code: 'MEME_LLM_CALL_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 次原始 + 1 次重试
  })
})
