/** HTTP 会话：buvid 引导、真实 UA、礼貌延迟（低频批量、激进缓存）。 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 获取失败：code 为 B站 code 或 HTTP 状态。surf 对此降级。 */
export class FetchError extends Error {
  readonly code: number | string
  constructor(code: number | string, msg: string) {
    super(`bilibili fetch error ${code}: ${msg}`)
    this.name = 'FetchError'
    this.code = code
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })

export class BiliSession {
  private readonly cookies = new Map<string, string>()
  private readonly delayMin: number
  private readonly delayMax: number
  private readonly timeoutMs: number
  private readonly signal?: AbortSignal
  private buvidReady = false
  private lastReq = 0

  constructor(delayMin = 0.8, delayMax = 1.5, timeout = 15, sessdata = '', signal?: AbortSignal) {
    this.delayMin = delayMin
    this.delayMax = delayMax
    this.timeoutMs = timeout * 1000
    this.signal = signal
    // 登录态：解锁搜索接口与完整评论区（匿名下精选视频只露冰山一角）
    if (sessdata) this.cookies.set('SESSDATA', sessdata)
  }

  /** 匿名 buvid 引导（部分接口无 cookie 会被风控）。失败不致命。 */
  async bootstrap(): Promise<void> {
    if (this.buvidReady) return
    try {
      const data = await this.getJson('https://api.bilibili.com/x/frontend/finger/spi')
      for (const key of ['b_3', 'b_4']) {
        const v = data?.[key]
        if (typeof v === 'string' && v) this.cookies.set(key, v)
      }
      this.buvidReady = true
    } catch {
      // 引导失败由后续请求自然暴露
    }
  }

  private async polite(): Promise<void> {
    const gap = this.delayMin + Math.random() * (this.delayMax - this.delayMin)
    const wait = this.lastReq + gap * 1000 - performance.now()
    if (wait > 0) await sleep(wait, this.signal)
    this.lastReq = performance.now()
  }

  private cookieHeader(extra?: Record<string, string>): string {
    const all = { ...Object.fromEntries(this.cookies), ...extra }
    return Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async getJson<T = Record<string, any>>(url: string, params?: Record<string, unknown>): Promise<T> {
    await this.bootstrap()
    await this.polite()
    const u = new URL(url)
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    const r = await fetch(u, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
        Cookie: this.cookieHeader(),
      },
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]),
      redirect: 'follow',
    })
    if (r.status !== 200) throw new FetchError(r.status, `HTTP ${r.status} for ${url}`)
    const body = await r.json() as { code?: number; message?: string; data?: T }
    for (const c of r.headers.getSetCookie?.() ?? []) this.absorbCookie(c)
    if (body.code !== 0) throw new FetchError(body.code ?? -1, body.message || 'unknown')
    return (body.data ?? {}) as T
  }

  /** 下载二进制（评论图片 CDN）。图床防盗链依赖 Referer。 */
  async getBytes(url: string): Promise<Uint8Array> {
    await this.polite()
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]),
    })
    if (r.status !== 200) throw new FetchError(r.status, `HTTP ${r.status} for ${url}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  private absorbCookie(setCookie: string): void {
    const [pair] = setCookie.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}
