/** meme login：本地服务 + 标准扫码轮询协议（mock bilibili 侧，不打真网）。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLogin } from '../src/login.ts'

afterEach(() => vi.unstubAllGlobals())

/** 模拟扫码页客户端：取二维码 → 轮询直到成功。 */
async function driveScanPage(url: string, maxPolls = 20): Promise<void> {
  const qr = await (await fetch(`${url}api/qr`)).json() as { ok: boolean; key: string }
  if (!qr.ok) throw new Error('qr failed')
  for (let i = 0; i < maxPolls; i++) {
    const d = await (await fetch(`${url}api/poll?key=${encodeURIComponent(qr.key)}`)).json() as { code: number }
    if (d.code === 0) return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('poll never succeeded')
}

describe('meme login', () => {
  it('扫码 → poll 成功 → 凭证落盘（Set-Cookie + crossDomain 双路）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meme-login-'))
    const credFile = join(dir, 'credentials.json')
    const realFetch = globalThis.fetch
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('127.0.0.1')) return realFetch(url, init) // 本地扫码页客户端直连
      if (u.includes('qrcode/generate')) {
        return new Response(JSON.stringify({ code: 0, data: { url: 'https://passport.bilibili.com/h5-app/scan?key=abc', qrcode_key: 'KEY1' } }), { status: 200 })
      }
      if (u.includes('qrcode/poll')) {
        pollCount += 1
        if (pollCount < 2) {
          return new Response(JSON.stringify({ code: 86101, message: '未扫码' }), { status: 200 })
        }
        return new Response(JSON.stringify({
          code: 0, data: { url: 'https://passport.bilibili.com/crossDomain?DedeUserID=42&SESSDATA=sess-xyz&bili_jct=jct-1' },
        }), {
          status: 200,
          headers: { 'set-cookie': 'SESSDATA=sess-xyz; Path=/; HttpOnly, bili_jct=jct-1; Path=/, DedeUserID=42; Path=/' },
        })
      }
      if (u.includes('finger/spi')) {
        return new Response(JSON.stringify({ code: 0, data: { b_3: 'buvid3-xxx', b_4: 'b4' } }), { status: 200 })
      }
      if (u.includes('/nav')) {
        expect((init?.headers as Record<string, string>).Cookie).toContain('SESSDATA=sess-xyz')
        return new Response(JSON.stringify({ code: 0, data: { isLogin: true, uname: '测试用户', mid: 42 } }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    }))

    const out = await runLogin({
      credentialsFile: credFile, timeoutMs: 15_000, openBrowser: false,
      onReady: (url) => void driveScanPage(url),
    })
    expect(out.ok).toBe(true)
    expect(out.uname).toBe('测试用户')
    expect(out.mid).toBe(42)
    const creds = JSON.parse(readFileSync(credFile, 'utf8')) as Record<string, unknown>
    expect(creds.sessdata).toBe('sess-xyz')
    expect(creds.bili_jct).toBe('jct-1')
    expect(creds.dede_user_id).toBe('42')
    expect(creds.buvid3).toBe('buvid3-xxx')
    expect(creds.uname).toBe('测试用户')
    expect(pollCount).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('超时未登录 → ok=false 带 error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meme-login-'))
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('qrcode/generate')) {
        return new Response(JSON.stringify({ code: 0, data: { url: 'https://x/scan', qrcode_key: 'K' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 86101, message: '未扫码' }), { status: 200 })
    }))
    const out = await runLogin({
      credentialsFile: join(dir, 'c.json'), timeoutMs: 1_200, openBrowser: false,
    })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('超时')
    rmSync(dir, { recursive: true, force: true })
  }, 10_000)
})
