#!/usr/bin/env node
/**
 * meme CLI：唯一操作面。agent 经 harness 注入的 $DSH_MEME_NODE/$DSH_MEME_BIN
 * 由 bash/pwsh 调用；人类可直接跑（npm i -g dsh-meme 后 `meme`）。
 *
 * 约定：stdout = 单行 JSON（结构化结果，agent 消费）；stderr = 人读文本与进度；
 * 业务失败 exit 1 且 stdout 仍有 {"error":{"code","message","suggestion",...}}；
 * 用法错误 exit 2。login 是交互命令，保持人读输出。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { MemeError } from './errors.ts'
import { runLogin } from './login.ts'
import { COMMANDS } from './cli/commands.ts'
import { cmdUsage, parse, topUsage, UsageError } from './cli/parser.ts'
import { openRuntime } from './cli/runtime.ts'
import { VERSION } from './version.ts'

const LOGIN_USAGE = `meme login —— 弹出浏览器扫码登录 B站（登录态写 ~/.meme/credentials.json）

选项：
  --port <N>               本地回调页端口（默认随机）
  --credentials <PATH>     登录态文件路径（默认 ~/.meme/credentials.json）
  --timeout <SECONDS>      等待扫码超时（默认 180）
  --no-browser             不自动弹浏览器（手动访问打印出的地址）
  -h, --help               本帮助`

async function runLoginCommand(args: string[]): Promise<number> {
  let port: number | undefined
  let credentials = join(homedir(), '.meme', 'credentials.json')
  let timeoutMs = 180_000
  let openBrowser = true
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = () => args[++i]
    if (a === '--port') port = Number(next())
    else if (a === '--credentials') credentials = String(next())
    else if (a === '--timeout') timeoutMs = Number(next()) * 1000
    else if (a === '--no-browser') openBrowser = false
    else if (a === '-h' || a === '--help') { console.log(LOGIN_USAGE); return 0 }
    else { console.error(`未知参数：${a}\n`); console.log(LOGIN_USAGE); return 2 }
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

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  const cmd = args[0] ?? ''
  if (cmd === 'login') return runLoginCommand(args.slice(1))
  if (cmd === '' || cmd === '-h' || cmd === '--help') { console.log(topUsage(Object.values(COMMANDS), VERSION)); return 0 }
  if (cmd === '-v' || cmd === '--version') { console.log(`meme ${VERSION}`); return 0 }
  const spec = COMMANDS[cmd]
  if (!spec) {
    console.error(`未知子命令：${cmd}\n`)
    console.log(topUsage(Object.values(COMMANDS), VERSION))
    return 2
  }
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args.slice(1), spec)
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`meme ${cmd}: ${e.message}\n`)
      console.log(cmdUsage(spec, VERSION))
      return 2
    }
    throw e
  }
  if (parsed.flags.help === true) { console.log(cmdUsage(spec, VERSION)); return 0 }

  const rt = openRuntime(loadConfig())
  try {
    const { payload, human } = await spec.run(parsed, rt)
    if (human) console.error(human)
    console.log(JSON.stringify(payload))
    return 0
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`meme ${cmd}: ${e.message}\n`)
      console.log(cmdUsage(spec, VERSION))
      return 2
    }
    if (e instanceof MemeError) {
      console.log(JSON.stringify({ error: e.toDict() }))
      return 1
    }
    console.error(`meme: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return 1
  } finally {
    rt.close()
  }
}

main(process.argv).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`meme: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exit(1)
  },
)
