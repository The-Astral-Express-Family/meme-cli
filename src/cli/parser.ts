/**
 * 命令表驱动的参数解析（node:util parseArgs，零依赖）与用法文本。
 * 约定：strict 模式——未知 flag / 缺值都算用法错误（exit 2）；
 * number 类型 flag 由这里统一强转（parseArgs 只有 string/boolean）。
 */
import { parseArgs } from 'node:util'

export type FlagValue = string | number | boolean | string[] | number[]

export interface OptSpec {
  type: 'string' | 'boolean' | 'number'
  /** 可重复（--ctx a --ctx b → 数组）。 */
  multiple?: boolean
  desc?: string
}

export interface CmdSpec {
  name: string
  /** 一句话用途（列表 + 详情共用）。 */
  desc: string
  /** 用法行里的参数展示，如 '<text>' 或 '<action>'。 */
  args: string
  opts: Record<string, OptSpec>
}

export interface Parsed {
  /** positionals（按各命令 spec 的语义消费）。 */
  _: string[]
  flags: Record<string, FlagValue | undefined>
}

export class UsageError extends Error {}

interface RawValues {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>
  positionals: string[]
}

export function parse(argv: string[], spec: CmdSpec): Parsed {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; short?: string }> = {
    help: { type: 'boolean', short: 'h' },
  }
  const numbers = new Set<string>()
  for (const [name, o] of Object.entries(spec.opts)) {
    options[name] = {
      type: o.type === 'boolean' ? 'boolean' : 'string',
      ...(o.multiple ? { multiple: true } : {}),
    }
    if (o.type === 'number') numbers.add(name)
  }
  let raw: RawValues
  try {
    raw = parseArgs({
      args: argv,
      options: options as never,
      strict: true,
      allowPositionals: true,
    }) as unknown as RawValues
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
  const flags: Record<string, FlagValue | undefined> = { help: raw.values.help as FlagValue | undefined }
  for (const [k, v] of Object.entries(raw.values)) {
    if (k === 'help' || v === undefined) continue
    if (numbers.has(k)) {
      const conv = (x: string | boolean) => {
        const num = Number(x)
        if (Number.isNaN(num)) throw new UsageError(`--${k} 需要数字，得到 "${x}"`)
        return num
      }
      flags[k] = Array.isArray(v) ? v.map((x) => conv(x as string)) : conv(v as string)
    } else {
      flags[k] = v as unknown as FlagValue
    }
  }
  return { _: raw.positionals, flags }
}

const optUsage = (name: string, o: OptSpec): string => {
  const kind = o.type === 'boolean' ? '' : o.type === 'number' ? ' <N>' : ' <VAL>'
  return `  --${name}${kind}${o.multiple ? '（可重复）' : ''}`
}

/** 单命令详情帮助（meme <cmd> --help）。 */
export function cmdUsage(spec: CmdSpec, version: string): string {
  const lines = [`meme ${spec.name} —— ${spec.desc}`, '', `用法：meme ${spec.name} ${spec.args} [选项]`, '', '选项：']
  for (const [name, o] of Object.entries(spec.opts)) {
    lines.push(`${optUsage(name, o).padEnd(28)}${o.desc ?? ''}`)
  }
  lines.push(`${'  -h, --help'.padEnd(28)}本帮助`)
  lines.push('', `meme ${version}，配置见 ~/.meme/config.json（meme config init 生成模板）`)
  return lines.join('\n')
}

/** 顶层帮助（无参数/未知命令）。 */
export function topUsage(specs: CmdSpec[], version: string): string {
  const lines = [
    `meme ${version} —— 梗百科 CLI（agent 经 harness 注入的 $DSH_MEME_NODE/$DSH_MEME_BIN 调用）`,
    '',
    '用法：meme <子命令> [参数]（每个子命令 --help 可查详情）',
    '',
    '子命令：',
  ]
  for (const spec of specs) {
    lines.push(`  ${spec.name.padEnd(10)}${spec.desc}`)
  }
  lines.push(
    '  login      弹出浏览器扫码登录 B站（写 ~/.meme/credentials.json）',
    '',
    '约定：stdout = 单行 JSON（结构化结果）；stderr = 人读文本；',
    '      业务失败 exit 1 且 stdout 有 {"error":{"code","message",...}}；用法错误 exit 2。',
    '配置：~/.meme/config.json；登录态：meme login 写 ~/.meme/credentials.json。',
  )
  return lines.join('\n')
}
