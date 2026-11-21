/**
 * B站扫码登录：本地起一个一次性 HTTP 服务 + 弹出系统浏览器扫码页。
 *
 * 流程为 bilibili-API-collect 的标准 web QR 登录：
 *   generate → 渲染二维码（qrcode 包）→ 轮询 poll（86101 未扫/86090 待确认/
 *   86038 过期/0 成功）→ 三通道取凭证（poll Set-Cookie / crossDomain URL 参数 /
 *   crossDomain 端点 Set-Cookie），抓不到 SESSDATA 即报错不落盘 →
 *   nav 验证登录身份 → 写 credentials 文件（surf 的 probe 通道与完整评论区用它）。
 */
import { createServer, type Server } from 'node:http'
import { exec } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import QRCode from 'qrcode'
import { nowIso } from './models.ts'

const PASSPORT = 'https://passport.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

interface LoginOutcome {
  ok: boolean
  uname?: string
  mid?: number
  error?: string
}

export interface LoginOptions {
  credentialsFile: string
  port?: number
  timeoutMs?: number
  /** 测试注入：不弹浏览器。 */
  openBrowser?: boolean
  /** 服务就绪回调（测试驱动轮询用；地址同时打印到控制台）。 */
  onReady?: (url: string) => void
}

export async function runLogin(opts: LoginOptions): Promise<LoginOutcome> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  let settled = false
  let outcome: LoginOutcome = { ok: false }

  const server = await startServer(opts.credentialsFile, opts.port, (o) => {
    if (settled) return
    settled = true
    outcome = o
  })
  const url = `http://127.0.0.1:${server.port}/`
  console.log(`meme login: 浏览器未自动打开时，请手动访问 ${url}`)
  opts.onReady?.(url)
  if (opts.openBrowser !== false) openInBrowser(url)

  const deadline = Date.now() + timeoutMs
  while (!settled && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
  }
  await closeServer(server.server)
  if (!settled) outcome = { ok: false, error: `超时（${Math.round(timeoutMs / 1000)}s）未完成登录` }
  return outcome
}

// ---------- 本地一次性服务 ----------

interface Started {
  server: Server
  port: number
}

function startServer(credentialsFile: string, port: number | undefined, finish: (o: LoginOutcome) => void): Promise<Started> {
  return new Promise((resolve) => {
    let key: string | null = null
    let qrPng = ''
    let qrFetchedAt = 0
    let saved = false

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname === '/' ) {
        sendHtml(res, PAGE)
      } else if (u.pathname === '/api/qr') {
        void (async () => {
          try {
            // 二维码 180s 有效：距上次获取 >150s 则换新
            if (!key || Date.now() - qrFetchedAt > 150_000) {
              const gen = await getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`)
              key = gen.data.qrcode_key
              qrPng = await QRCode.toDataURL(gen.data.url, { width: 260, margin: 1 })
              qrFetchedAt = Date.now()
            }
            sendJson(res, 200, { ok: true, qr: qrPng, key })
          } catch (e) {
            sendJson(res, 502, { ok: false, error: String(e) })
          }
        })()
      } else if (u.pathname === '/api/poll') {
        void (async () => {
          if (!key) return sendJson(res, 400, { code: -1, message: '二维码未生成' })
          try {
            const r = await fetch(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, {
              headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
            })
            const cookies = cookieJar(r.headers.getSetCookie?.() ?? [])
            const body = await r.json() as {
              code: number; message: string
              data?: { url?: string; refresh_token?: string; code?: number; message?: string }
            }
            // 扫码状态在 data.code（86101 未扫/86090 已扫未确认/86038 过期/0 成功）；
            // 顶层 code 对所有状态恒为 0——拿顶层判断会把首轮轮询误判成登录成功
            const state = body?.data?.code ?? body?.code ?? -1
            if (body.code === 0 && state === 0) {
              const crossCookies = await harvestCrossDomain(body.data?.url ?? '')
              const merged = mergeCookies(fromCrossDomain(body.data?.url ?? ''), cookies, crossCookies)
              const creds = await finalizeCredentials(merged, body.data?.refresh_token)
              if (!creds.sessdata) {
                // 硬守卫：抓不到登录 Cookie 就不落盘、不假报成功——匿名 surf 会静默退化
                const diag = `poll Set-Cookie=[${Object.keys(cookies).join(', ') || '无'}]`
                  + ` crossDomain参数=${body.data?.url ? '有' : '无'}`
                  + ` crossDomain Set-Cookie=[${Object.keys(crossCookies).join(', ') || '无'}]`
                console.error(`meme login: SESSDATA 未捕获（${diag}）——请重新扫码重试`)
                finish({ ok: false, error: '登录确认成功但未捕获到 SESSDATA（见服务端日志），凭证未保存' })
                sendJson(res, 200, { code: -1, message: '登录握手未捕获到凭证，请重新扫码重试' })
                return
              }
              if (!saved) {
                saved = true
                saveCredentials(credentialsFile, creds)
              }
              finish({ ok: true, uname: creds.uname, mid: creds.mid })
              sendJson(res, 200, { code: 0, message: '登录成功', uname: creds.uname, mid: creds.mid })
              return
            }
            sendJson(res, 200, { code: state, message: pollMessage(state) })
          } catch (e) {
            sendJson(res, 502, { code: -1, message: String(e) })
          }
        })()
      } else {
        sendJson(res, 404, { ok: false })
      }
    })
    server.listen(port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 })
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  // close() 只等连接结束；keep-alive 连接由 unref 兜底
  server.closeAllConnections?.()
}

// ---------- bilibili 侧 ----------

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' } })
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`)
  return r.json()
}

/** Set-Cookie 行 → 键值表。 */
function cookieJar(setCookies: string[]): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const c of setCookies) {
    const [pair] = c.split(';')
    const eq = pair.indexOf('=') // 空 SESSDATA 不覆盖已有值
    if (eq > 0) {
      const k = pair.slice(0, eq).trim()
      const v = pair.slice(eq + 1).trim()
      if (v || !(k in jar)) jar[k] = v
    }
  }
  return jar
}

/** 多通道凭证合并：空值永不覆盖，非空后者胜（同一次登录各通道值一致）。 */
function mergeCookies(...sources: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) if (v) out[k] = v
  }
  return out
}

/** crossDomain 回跳端点的 Set-Cookie 兜底：2026-08 改版后 data.url 是纯票据链接，
 * 真登录 Cookie 只在带浏览器 UA 跟随时由其响应下发。逐跳收集（≤3 跳）。 */
async function harvestCrossDomain(url: string): Promise<Record<string, string>> {
  const jar: Record<string, string> = {}
  if (!url) return jar
  let current = url
  try {
    for (let hop = 0; hop < 3 && current; hop++) {
      const r = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Referer: 'https://passport.bilibili.com/' },
      })
      jarEntries(jar, r.headers.getSetCookie?.() ?? [])
      const loc = r.headers.get('location')
      if (r.status >= 300 && r.status < 400 && loc) {
        current = new URL(loc, current).toString()
      } else break
    }
  } catch { /* 兜底通道失败不致命 */ }
  return jar
}

function jarEntries(jar: Record<string, string>, setCookies: string[]): void {
  for (const c of setCookies) {
    const [pair] = c.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) {
      const k = pair.slice(0, eq).trim()
      const v = pair.slice(eq + 1).trim()
      if (v || !(k in jar)) jar[k] = v
    }
  }
}

/** crossDomain 回跳 URL 的查询参数兜底（部分客户端 Set-Cookie 不可见）。 */
function fromCrossDomain(url: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const [k, v] of new URL(url).searchParams) {
      if (['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserIDck', 'sid'].includes(k)) out[k] = v
    }
  } catch { /* 非法 URL 忽略 */ }
  return out
}

/** 登录成功后的收尾：补 buvid、验证身份（nav），组装凭证。 */
async function finalizeCredentials(cookies: Record<string, string>, refreshToken?: string): Promise<{
  sessdata: string; bili_jct?: string; dede_user_id?: string; buvid3?: string
  refresh_token?: string; mid?: number; uname?: string; saved_at: string
}> {
  // buvid 补齐（风控接口需要；登录 Cookie 本身不含）
  try {
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi')
    if (spi?.data?.b_3 && !cookies.buvid3) cookies.buvid3 = spi.data.b_3
  } catch { /* 非致命 */ }
  let uname: string | undefined
  let mid: number | undefined
  if (cookies.SESSDATA) {
    try {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: jarHeader(cookies) },
      }).then((r) => r.json() as Promise<any>)
      if (nav?.data?.isLogin) {
        uname = nav.data.uname
        mid = nav.data.mid
      }
    } catch { /* 非致命 */ }
  }
  return {
    sessdata: cookies.SESSDATA ?? '',
    bili_jct: cookies.bili_jct,
    dede_user_id: cookies.DedeUserID,
    buvid3: cookies.buvid3,
    refresh_token: refreshToken,
    mid,
    uname,
    saved_at: nowIso(),
  }
}

const jarHeader = (jar: Record<string, string>) =>
  Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ')

function pollMessage(code: number): string {
  if (code === 86101) return '等待扫码'
  if (code === 86090) return '已扫码，请在手机上确认'
  if (code === 86038) return '二维码已过期，正在刷新'
  return `code=${code}`
}

function saveCredentials(file: string, creds: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600) // Windows 上 chmod 尽力而为
  } catch { /* 平台不支持忽略 */ }
}

// ---------- 弹出浏览器 ----------

function openInBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) console.error(`meme login: 无法自动打开浏览器（${err.message}），请手动访问上面的地址`)
  })
}

// ---------- 响应辅助 ----------

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendHtml(res: import('node:http').ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

/** 扫码页：展示二维码与状态，成功后 3s 自动关页。 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meme login · B站扫码登录</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0f1117; color: #e7e9ee; font: 15px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { width: min(92vw, 380px); padding: 28px; border-radius: 16px; background: #171a23;
          box-shadow: 0 8px 40px rgba(0,0,0,.45); text-align: center; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { margin: 0 0 18px; color: #8b93a7; font-size: 13px; }
  #qr { width: 260px; height: 260px; margin: 0 auto; border-radius: 12px; background: #fff;
        display: grid; place-items: center; }
  #qr img { width: 100%; height: 100%; }
  #status { margin-top: 16px; font-size: 14px; color: #aeb6c8; min-height: 22px; }
  .ok { color: #4ade80 !important; font-weight: 600; }
  .err { color: #f87171 !important; }
</style>
</head>
<body>
<div class="card">
  <h1>B站扫码登录</h1>
  <p class="sub">用 B站 App 扫码 —— 登录态仅写入本机 ~/.meme/credentials.json</p>
  <div id="qr">加载二维码…</div>
  <div id="status">正在获取二维码</div>
</div>
<script>
const qr = document.getElementById('qr'), status = document.getElementById('status');
let key = null, done = false;
async function refreshQr() {
  status.textContent = '正在获取二维码'; status.className = '';
  try {
    const r = await fetch('/api/qr'); const d = await r.json();
    if (!d.ok) throw new Error(d.error || '获取失败');
    key = d.key;
    qr.innerHTML = '<img src="' + d.qr + '">';
    status.textContent = '等待扫码';
  } catch (e) { status.textContent = '二维码获取失败：' + e.message; status.className = 'err'; }
}
refreshQr();
const timer = setInterval(async () => {
  if (done || !key) return;
  try {
    const r = await fetch('/api/poll?key=' + encodeURIComponent(key)); const d = await r.json();
    if (d.code === 0) {
      done = true; clearInterval(timer);
      status.textContent = '登录成功：' + (d.uname || '') + (d.mid ? ' (uid ' + d.mid + ')' : '');
      status.className = 'ok';
      setTimeout(() => window.close(), 3000);
    } else if (d.code === 86038) {
      await refreshQr();
    } else {
      status.textContent = d.message || '等待中';
    }
  } catch (e) { status.textContent = '网络错误，重试中'; }
}, 2000);
</script>
</body>
</html>`
