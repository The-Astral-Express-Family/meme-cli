#!/usr/bin/env node
/**
 * meme CLI：用户侧交互入口（agent 侧入口是 harness 工具）。
 *
 * 目前唯一子命令：`meme login` —— 弹出浏览器扫码登录 B站，登录态写入
 * credentials 文件，解锁 surf 的搜索探测（probe）与完整评论区。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runLogin } from './login.ts'
import { VERSION } from './version.ts'

const USAGE = `meme ${VERSION} —— B站梗百科（deepseek-harness 插件的工具即 agent 入口）

用法：
  meme login [选项]        弹出浏览器扫码登录 B站（写 ~/.meme/credentials.json）

选项：
  --port <N>               本地回调页端口（默认随机）
  --credentials <PATH>     登录态文件路径（默认 ~/.meme/credentials.json）
  --timeout <SECONDS>      等待扫码超时（默认 180）
  --no-browser             不自动弹浏览器（手动访问打印出的地址）
  -h, --help               本帮助
  -v, --version            版本`

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  if (args[0] !== 'login') {
    console.log(USAGE)
    return args[0] === '-h' || args[0] === '--help' || args[0] === '-v' || args[0] === '--version' ? 0 : 2
  }
  let port: number | undefined
  let credentials = join(homedir(), '.meme', 'credentials.json')
  let timeoutMs = 180_000
  let openBrowser = true
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    const next = () => args[++i]
    if (a === '--port') port = Number(next())
    else if (a === '--credentials') credentials = String(next())
    else if (a === '--timeout') timeoutMs = Number(next()) * 1000
    else if (a === '--no-browser') openBrowser = false
    else if (a === '-h' || a === '--help') { console.log(USAGE); return 0 }
    else { console.error(`未知参数：${a}\n`); console.log(USAGE); return 2 }
  }
  const out = await runLogin({ credentialsFile: credentials, port, timeoutMs, openBrowser })
  if (out.ok) {
    console.log(`meme login: 登录成功 —— ${out.uname ?? '未知用户'}${out.mid ? ` (uid ${out.mid})` : ''}`)
    console.log(`meme login: 登录态已写入 ${credentials}（surf 的 probe 通道现已解锁）`)
    return 0
  }
  console.error(`meme login: ${out.error ?? '登录失败'}`)
  return 1
}

main(process.argv).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`meme: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  },
)
