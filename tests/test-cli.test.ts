/** CLI 层：参数解析、entry 三通道、命令执行体契约（payload/human 分离）、shim 与 config。 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, name as shimName } from '../src/index.ts'
import { loadConfig, resolveConfig, configTemplate, configFile } from '../src/config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import type { Meme } from '../src/models.ts'
import { save as saveMeme } from '../src/entries.ts'
import * as candidates from '../src/candidates.ts'
import { COMMANDS, type CmdOut } from '../src/cli/commands.ts'
import { parse, UsageError } from '../src/cli/parser.ts'
import { openRuntime, type Runtime } from '../src/cli/runtime.ts'
import { makeCfg } from './helpers.ts'
import { makeMeme, matcher, pattern } from './test-matchers.test.ts'

let rt: Runtime
beforeEach(() => {
  rt = openRuntime(makeCfg().cfg)
})
afterEach(() => {
  rt.close()
})

// ---- parser ----

describe('parser', () => {
  it('positional + 多次 flag + 布尔 flag', () => {
    const p = parse(['你好', '--ctx', '上一行', '--ctx', '上上行', '--bare'], COMMANDS.lookup)
    expect(p._).toEqual(['你好'])
    expect(p.flags.ctx).toEqual(['上一行', '上上行'])
    expect(p.flags.bare).toBe(true)
  })

  it('number flag 强转；非法数字报 UsageError', () => {
    expect(parse(['q', '--top', '5'], COMMANDS.search).flags.top).toBe(5)
    expect(() => parse(['q', '--top', 'abc'], COMMANDS.search)).toThrow(UsageError)
  })

  it('未知 flag 报 UsageError（strict）', () => {
    expect(() => parse(['q', '--nope'], COMMANDS.search)).toThrow(UsageError)
  })

  it('--help 在任何命令上都合法', () => {
    expect(parse(['--help'], COMMANDS.show).flags.help).toBe(true)
    expect(parse([], COMMANDS.surf).flags.help).toBeUndefined()
  })
})

// ---- entry 三通道 ----

describe('entry 三通道', () => {
  it('entry-json 与 entry-file 互斥', async () => {
    await expect(COMMANDS.add.run({ _: [], flags: { 'entry-json': '{}', 'entry-file': 'x' } }, rt))
      .rejects.toBeInstanceOf(UsageError)
  })

  it('entry-json 坏 JSON → MEME_ENTRY_INVALID', async () => {
    await expect(COMMANDS.add.run({ _: [], flags: { 'entry-json': '{bad' } }, rt))
      .rejects.toMatchObject({ code: 'MEME_ENTRY_INVALID' })
  })

  it('entry-file 不存在 → MEME_ENTRY_INVALID（文件不可读）', async () => {
    await expect(COMMANDS.add.run({ _: [], flags: { 'entry-file': join(tmpdir(), 'meme-no-such-entry.json') } }, rt))
      .rejects.toMatchObject({ code: 'MEME_ENTRY_INVALID' })
  })

  it('无 entry → UsageError（归纳由操作员亲写；cid/text 只做证据关联不触发归纳）', async () => {
    await expect(COMMANDS.add.run({ _: [], flags: {} }, rt)).rejects.toBeInstanceOf(UsageError)
    await expect(COMMANDS.add.run({ _: [], flags: { cid: 'c_0001' } }, rt)).rejects.toBeInstanceOf(UsageError)
  })
})

// ---- read path 命令 ----

const softFoot = (id = 'm_0001'): Meme => makeMeme({
  id, name: '我软脚了', aliases: ['软脚了'], class: 'word',
  card: { gist: '关键局操作变形的自嘲', usage: ['决胜局我软脚了'], taboo: '别用于真实伤病', register: '电竞圈', aggression: '低' },
  matcher: matcher([pattern({ kind: 'lex', terms: ['我软脚了', '软脚了'] })]),
})

describe('read path 命令', () => {
  it('lookup 命中：payload 带卡，human 带 gist', async () => {
    saveMeme(rt.db(), softFoot())
    const out: CmdOut = await COMMANDS.lookup.run({ _: ['决胜局我软脚了'], flags: {} }, rt)
    expect(out.payload.result).toBe('hit')
    const hits = out.payload.hits as Array<Record<string, unknown>>
    expect(hits[0].meme_id).toBe('m_0001')
    expect((hits[0].card as Record<string, unknown>).gist).toBe('关键局操作变形的自嘲')
    expect(out.human).toContain('关键局操作变形的自嘲')
  })

  it('lookup miss：合法答案 + nearby + CLI 建议', async () => {
    saveMeme(rt.db(), softFoot())
    const out: CmdOut = await COMMANDS.lookup.run({ _: ['完全无关的句子'], flags: {} }, rt)
    expect(out.payload.result).toBe('miss')
    expect(out.payload.nearby).not.toBeNull()
    expect(out.payload.suggestion).toContain('meme add --entry-file')
    expect(out.human).toContain('未知')
  })

  it('search：BM25 命中与空结果', async () => {
    saveMeme(rt.db(), softFoot())
    const out = await COMMANDS.search.run({ _: ['软脚'], flags: {} }, rt)
    expect(out.payload.result).toBe('ok')
    expect((out.payload.results as Array<Record<string, unknown>>)[0].id).toBe('m_0001')
    const empty = await COMMANDS.search.run({ _: ['毫不相干的查询词'], flags: {} }, rt)
    expect(empty.payload.result).toBe('empty')
    expect(empty.payload.suggestion).toContain('meme surf')
  })

  it('show：card 默认级 / brief / 全 level 校验', async () => {
    saveMeme(rt.db(), softFoot())
    const card = await COMMANDS.show.run({ _: ['我软脚了'], flags: {} }, rt)
    expect(card.payload.level).toBe('card')
    const brief = await COMMANDS.show.run({ _: ['m_0001'], flags: { level: 'brief' } }, rt)
    expect(brief.payload.level).toBe('brief')
    expect(brief.human.length).toBeGreaterThan(0)
    await expect(COMMANDS.show.run({ _: ['我软脚了'], flags: { level: 'huge' } }, rt))
      .rejects.toBeInstanceOf(UsageError)
  })

  it('show not-found：MEME_NOT_FOUND 附 nearby', async () => {
    saveMeme(rt.db(), softFoot())
    await expect(COMMANDS.show.run({ _: ['m_9999'], flags: {} }, rt))
      .rejects.toMatchObject({ code: 'MEME_NOT_FOUND', nearby: expect.anything() })
  })
})

// ---- write path 命令 ----

const entry = (overrides: Record<string, unknown> = {}) => ({
  name: '青铜巨像',
  aliases: ['青铜像'],
  class: 'word' as const,
  birth_circa: '2026',
  card: { gist: '测试用词梗', usage: ['青铜巨像，名场面'], taboo: null, register: null, aggression: '低' },
  examples: ['青铜巨像，第1个名场面', '真青铜巨像'],
  matcher: { patterns: [{ kind: 'lex', terms: ['青铜巨像', '青铜像'] }], constraints: {} },
  notes: '操作员测试词条',
  ...overrides,
})

function seedCandidateWithEvidence(db: Runtime['db']): string {
  const usages = Array.from({ length: 6 }, (_, i) => ({
    text: `青铜巨像名场面第${i}弹`, aid: 7000 + (i % 2), rpid: 8000 + i,
    root: 0, parent: 0, mid: 0, ctime: 0, chain: false,
  }))
  candidates.upsertFromSignal(db(), {
    head: '青铜巨像', channel: 'phrase', kind_guess: 'word',
    usages, video_pairs: [{ aid: 7000, up_mid: 0 }, { aid: 7001, up_mid: 0 }],
    day: '2026-11-09', round_id: 1,
  })
  return candidates.byHead(db(), '青铜巨像')!.cid
}

describe('write path 命令', () => {
  it('add entry-file 路径：闸门全保留，payload 带结构化结果与 backtest', async () => {
    const cid = seedCandidateWithEvidence(rt.db)
    const dir = mkdtempSync(join(tmpdir(), 'meme-entry-'))
    const file = join(dir, 'entry.json')
    writeFileSync(file, JSON.stringify(entry()), 'utf8')
    try {
      const out = await COMMANDS.add.run({ _: [], flags: { cid, 'entry-file': file } }, rt)
      expect(out.payload.id).toMatch(/^m_/)
      expect(out.payload.matcher).toBe('compiled')
      expect(out.payload.backtest).not.toBeNull()
      expect(out.human).toContain('已入库')
      // platform 由 pipeline 标注：surf 候选（cid）→ bilibili
      const row = rt.db().prepare('SELECT platform FROM memes WHERE id=?').get(out.payload.id as string) as { platform: string }
      expect(JSON.parse(row.platform)).toEqual(['bilibili'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('platform 由 pipeline 标注：无 cid → 留空；entry 里的 platform 键被忽略', async () => {
    // 无 cid（群聊裸文本路径）：没有来源证据就不猜
    const bare2 = entry({
      name: '线上嘴替', aliases: ['嘴替'],
      card: { gist: '代为输出心声的人', usage: ['这就是我的线上嘴替'], taboo: null, register: null, aggression: '低' },
      examples: ['这个博主真是线上嘴替', '嘴替了属于是'],
      matcher: { patterns: [{ kind: 'lex', terms: ['线上嘴替', '嘴替'] }], constraints: {} },
    })
    const out2 = await COMMANDS.add.run({ _: [], flags: { 'entry-json': JSON.stringify(bare2) } }, rt)
    const row2 = rt.db().prepare('SELECT platform FROM memes WHERE id=?').get(out2.payload.id as string) as { platform: string }
    expect(JSON.parse(row2.platform)).toEqual([])
  })

  it('add 重名 → MEME_DUPLICATE 引导 iterate', async () => {
    const cid = seedCandidateWithEvidence(rt.db)
    await COMMANDS.add.run({ _: [], flags: { cid, 'entry-json': JSON.stringify(entry()) } }, rt)
    await expect(COMMANDS.add.run({ _: [], flags: { 'entry-json': JSON.stringify(entry()) } }, rt))
      .rejects.toMatchObject({ code: 'MEME_DUPLICATE' })
  })

  it('iterate entry 路径：id/state 保持，释义更新', async () => {
    const cid = seedCandidateWithEvidence(rt.db)
    const added = await COMMANDS.add.run({ _: [], flags: { cid, 'entry-json': JSON.stringify(entry()) } }, rt)
    const id = added.payload.id as string
    const revised = { ...entry(), card: { ...entry().card, gist: '修订后的释义' } }
    const out = await COMMANDS.iterate.run({ _: [id], flags: { 'entry-json': JSON.stringify(revised) } }, rt)
    expect(out.payload.id).toBe(id)
    expect(out.payload.action).toBe('iterate')
    expect(out.human).toContain('已修订')
  })

  it('edit：变体收编进 lex terms + drift 追加 + 无动作 UsageError', async () => {
    saveMeme(rt.db(), softFoot())
    const out = await COMMANDS.edit.run(
      { _: ['m_0001'], flags: { variant: ['软脚了啊', '软脚了'], drift: '2026: 语义扩大到日常失误' } },
      rt,
    )
    expect(out.payload.actions).toContain('变体收编：软脚了啊、软脚了')
    const row = rt.db().prepare('SELECT matcher FROM memes WHERE id=?').get('m_0001') as { matcher: string | null }
    expect(row.matcher).toContain('软脚了啊')
    await expect(COMMANDS.edit.run({ _: ['m_0001'], flags: {} }, rt)).rejects.toBeInstanceOf(UsageError)
  })

  it('note 全动作：add(head) → list → show → edit → rm', async () => {
    const added = await COMMANDS.note.run({ _: ['add'], flags: { head: '软脚', content: '疑似新梗，证据不足' } }, rt)
    const nid = added.payload.note_id as number
    expect(added.payload.head).toBe('软脚')
    const list = await COMMANDS.note.run({ _: ['list'], flags: {} }, rt)
    expect((list.payload.notes as unknown[]).length).toBe(1)
    const shown = await COMMANDS.note.run({ _: ['show'], flags: { 'note-id': nid } }, rt)
    expect((shown.payload.note as Record<string, unknown>).content).toBe('疑似新梗，证据不足')
    await COMMANDS.note.run({ _: ['edit'], flags: { 'note-id': nid, content: '改口：已有两例' } }, rt)
    await COMMANDS.note.run({ _: ['rm'], flags: { 'note-id': nid } }, rt)
    await expect(COMMANDS.note.run({ _: ['rm'], flags: { 'note-id': nid } }, rt))
      .rejects.toMatchObject({ code: 'MEME_NOT_FOUND' })
    await expect(COMMANDS.note.run({ _: ['show'], flags: {} }, rt)).rejects.toBeInstanceOf(UsageError)
  })
})

// ---- config ----

describe('config', () => {
  it('loadConfig 缺文件 → 全默认；显式文件覆盖 db_path', () => {
    const dflt = loadConfig(join(tmpdir(), 'meme-no-config.json'))
    expect(dflt.backtest.min_hit).toBe(0.7)
    const dir = mkdtempSync(join(tmpdir(), 'meme-cfg-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ db_path: 'D:/x/memes.db', backtest: { min_hit: 0.9 } }), 'utf8')
    try {
      const cfg = loadConfig(file)
      expect(cfg.dbPath).toBe('D:/x/memes.db')
      expect(cfg.backtest.min_hit).toBe(0.9)
      expect(cfg.fetch.videos_per_round).toBe(30) // 未写字段回落默认
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('MEME_DB 环境变量优先于文件 db_path', () => {
    vi.stubEnv('MEME_DB', 'E:/env.db')
    const dir = mkdtempSync(join(tmpdir(), 'meme-cfg2-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ db_path: 'D:/x/memes.db' }), 'utf8')
    try {
      expect(loadConfig(file).dbPath).toBe('E:/env.db')
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('config init：写模板到 HOME，二次 init 报已存在', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'meme-home-'))
    vi.stubEnv('USERPROFILE', fakeHome)
    try {
      const out = await COMMANDS.config.run({ _: ['init'], flags: {} }, rt)
      const file = configFile()
      expect(file.startsWith(fakeHome)).toBe(true)
      expect(existsSync(file)).toBe(true)
      const tpl = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      expect((tpl.backtest as Record<string, unknown>).min_hit).toBe(0.7)
      expect(out.payload.written).toBe(file)
      await expect(COMMANDS.config.run({ _: ['init'], flags: {} }, rt))
        .rejects.toMatchObject({ code: 'MEME_CONFIG_EXISTS' })
    } finally {
      vi.unstubAllEnvs()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('configTemplate 是合法 JSON 且字段齐全', () => {
    const tpl = JSON.parse(configTemplate()) as Record<string, unknown>
    expect(Object.keys(tpl)).toEqual(
      expect.arrayContaining(['db_path', 'credentials_file', 'fetch', 'backtest', 'retrieval', 'lifecycle', 'detect']),
    )
    expect((tpl.backtest as Record<string, unknown>).min_hit).toBe(0.7)
    expect(resolveConfig({}).backtest.holdout).toBe(0.3)
  })
})

// ---- shim ----

describe('shim（prompt-only 插件）', () => {
  it('skill 注册（未激活=目录一行）+ shellEnv 注册', () => {
    let captured: BashEnvContributor | null = null
    const skills: Array<{ name: string; description: string; content: string }> = []
    const fakeCtx = {
      skills: { register: (s: { name: string; description: string; content: string }) => { skills.push(s); return () => {} } },
      shellEnv: { register: (c: BashEnvContributor) => { captured = c; return () => {} } },
    } as unknown as Context
    apply(fakeCtx)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('meme')
    // 未激活形态：单行路由描述，在 500 字符目录上限内
    expect(skills[0].description).not.toContain('\n')
    expect(skills[0].description.length).toBeLessThanOrEqual(500)
    expect(skills[0].description).toContain('梗百科')
    expect(skills[0].description).toContain('群聊梗可直接收录')
    // 展开正文：调用样板 + entry schema 全文都在
    expect(skills[0].content).toContain('$DSH_MEME_BIN')
    expect(skills[0].content).toContain('entry JSON schema')
    expect(skills[0].content).toContain('"forbid_inner": true')
    expect(captured).not.toBeNull()
    expect(captured!.name).toBe('dsh-meme')
    expect(Object.keys(captured!.variables)).toEqual(['DSH_MEME_NODE', 'DSH_MEME_BIN'])
    const env = captured!.resolve({} as never)
    expect(env.DSH_MEME_NODE).toBe(process.execPath)
    expect(env.DSH_MEME_BIN).toMatch(/cli\.js$/)
    expect(shimName).toBe('dsh-meme')
  })
})
