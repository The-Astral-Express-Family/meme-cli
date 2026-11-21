#!/usr/bin/env node
/**
 * meme CLI：唯一操作面。agent 经 harness 注入的 $DSH_MEME_NODE/$DSH_MEME_BIN
 * 由 bash/pwsh 调用；人类可直接跑（npm i -g dsh-meme 后 `meme`）。
 *
 * 约定：stdout = 单行 JSON（结构化结果，agent 消费）；stderr = 人读文本与进度；
 * 业务失败 exit 1 且 stdout 仍有 {"error":{"code","message","suggestion",...}}；
 * 用法错误 exit 2（auth login 为交互命令，进度在 stderr、结果 JSON 在 stdout）。
 */
import { loadConfig } from './config.ts'
import { MemeError } from './errors.ts'
import { COMMANDS } from './cli/commands.ts'
import { cmdUsage, parse, topUsage, UsageError } from './cli/parser.ts'
import { openRuntime } from './cli/runtime.ts'
import { VERSION } from './version.ts'

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  const cmd = args[0] ?? ''
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

// 退出用 exitCode + 自然排空，不得 process.exit 强杀：
// fetch 的 undici keep-alive socket 在强制退出时会触发 libuv 断言崩溃（Windows exit 127），
// 空闲 socket 已 unref，自然退出干净且立即。
main(process.argv).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.error(`meme: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exitCode = 1
  },
)
