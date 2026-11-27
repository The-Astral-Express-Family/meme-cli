/** curator 满分库构建（验收基线，见设计 §6）：
 *
 *   npx tsx scripts/curator-perfect.ts --run <id>
 *
 * 按 v4 金标为 29 个家族各写一个 entry（lex terms=非槽金标形式；槽位 head 另配骨架），
 * 逐家族经 run 的 wrapper 真实执行 `add --entry-file --cid ...`，产出与答题 run 同形的
 * transcript。满分库允许看金标与查询——它是判定上限，不是被测对象。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { QUERIES_FILE, RUNS_DIR, loadGold, readJsonl } from './curator-lib.ts'

process.env.MEME_EMBED_OFF = '1'

interface Query {
  query_id: string
  channel: string
  text: string
  ctx: string[] | null
  expect: { hit: boolean; family: string | null }
  from_candidate: string | null
  tags: string[]
}

/** 槽位 head 的骨架 token（family → tokens）。未列出的槽位家族只用 lex（宽骨架会吞别家负例）。
 * x_be_like 不设骨架：normalizeSpanned 会把 ≥3 字母拉丁词归一成 <ent>，"be like" 字面量无处着落（死模式）。 */
const SKELETONS: Record<string, string[]> = {
  'x_zuoren': ['<ent>', '你做人真的可以'],
  'tianbusheng_x': ['天不生', '<ent>', '万古如长夜'],
  'x-da-xue-xi': ['<ent>', '大学习'],
  'yi-yan-su-x': ['已严肃', '<ent>'],
  'xian-guo-x-zai-tan-wei-lai': ['先过', '<ent>', '再谈未来'],
}

/** 同文异境对：trigger 落 ctx、response 落 text 的交互 pattern（family → pattern）。 */
const INTERACTIONS: Record<string, { trigger_terms: string[]; response_terms: string[] }> = {
  'laigushi': { trigger_terms: ['来股市'], response_terms: ['开户'] },
  'x_zuoren': { trigger_terms: ['你做人真的可以'], response_terms: ['敢放'] },
  'hao-ting': { trigger_terms: ['豪庭'], response_terms: ['好听'] },
}

/** 逐家族约束（对齐 constraint-dependent 负例）。 */
const CONSTRAINTS: Record<string, { forbid_inner?: boolean; forbid_context?: string[] }> = {
  '325-event': { forbid_inner: true, forbid_context: ['块钱'] },
}

/** hao-ting 需要第二条词条（好听只进交互，不进 lex），family → 额外词条 name。 */
const EXTRA_ENTRIES: Record<string, { name: string; interaction: { trigger_terms: string[]; response_terms: string[] } }> = {
  'hao-ting': { name: '好听', interaction: { trigger_terms: ['豪庭'], response_terms: ['好听'] } },
}

interface EntryDef {
  fileBase: string
  entry: Record<string, unknown>
  cids: string[]
  holdouts: string[]
}

function buildEntries(gold: ReturnType<typeof loadGold>, queries: Query[]): EntryDef[] {
  const defs: EntryDef[] = []
  for (const family of gold.families) {
    const forms = gold.familyForms.get(family) ?? []
    const label = gold.rows.find((r) => r.family_id === family && r.candidate_verdict !== 'not-meme')
      ?? gold.rows.find((r) => r.family_id === family)!
    const name = label.canonical_head ?? forms[0]
    // 别名排除：词条名自身、被 EXTRA_ENTRIES 单独建词条的形式（防 MEME_DUPLICATE）、
    // 以及跨家族共享形式（c_70855 的「每日325大学习」同属 x-da-xue-xi 与 325-event，
    // 留在 aliases 会干扰归属收窄，把词条判成 cross-family）
    const extraNames = Object.values(EXTRA_ENTRIES).map((e) => e.name)
    const sharedForms = new Set<string>()
    for (const [f, fs] of gold.familyForms) {
      if (f === family) continue
      for (const form of fs) if (forms.includes(form)) sharedForms.add(form)
    }
    const aliases = forms.filter((f) => f !== name && !extraNames.includes(f) && !sharedForms.has(f))
    const nonSlot = forms.filter((f) => !f.includes('<') && !extraNames.includes(f))
    const cids = gold.familyCids.get(family) ?? []
    const holdouts = queries.filter((q) => q.expect.hit && q.expect.family === family).slice(0, 3).map((q) => q.text)
    const examples = queries.filter((q) => q.expect.hit && q.expect.family === family).slice(0, 2).map((q) => q.text)
    const baseCard = { gist: `${family} 家族：${name}`, usage: [], taboo: null, register: null, aggression: null }
    const patterns: Array<Record<string, unknown>> = []
    if (nonSlot.length) patterns.push({ kind: 'lex', terms: nonSlot })
    const skel = SKELETONS[family]
    if (skel) patterns.push({ kind: 'skeleton', tokens: skel })
    const inter = INTERACTIONS[family]
    if (inter) {
      // 交互 holdout 用“上句：trigger 本句：response”格式（backtest splitDialogue 解析）
      const trig = inter.trigger_terms[0]
      const respText = queries.find((q) => q.expect.hit && q.expect.family === family && (q.ctx ?? []).some((l) => l.includes(trig)))
      if (respText) {
        const trigLine = (respText.ctx ?? []).find((l) => l.includes(trig))!
        holdouts.push(`上句：${trigLine} 本句：${respText.text}`)
      }
      patterns.push({ kind: 'interaction', trigger_terms: inter.trigger_terms, response_terms: inter.response_terms })
    }
    const constraints = CONSTRAINTS[family] ?? {}
    defs.push({
      fileBase: family,
      cids,
      holdouts,
      entry: {
        name,
        aliases,
        class: inter ? 'interaction' : name.includes('<') ? 'formula' : 'word',
        birth_circa: null,
        card: baseCard,
        examples: examples.length ? examples : [name],
        matcher: { patterns, constraints },
        lineage_parent: null,
        lineage_mutation: null,
        notes: 'curator 满分库（金标构建）',
      },
    })
    // hao-ting：好听只走交互词条（lex 收好听会让音乐负例 FP）
    const extra = EXTRA_ENTRIES[family]
    if (extra) {
      const respText = queries.find((q) => q.expect.hit && q.expect.family === family && q.text.includes(extra.interaction.response_terms[0])
        && (q.ctx ?? []).some((l) => l.includes(extra.interaction.trigger_terms[0])))
      const extraHoldouts: string[] = []
      if (respText) {
        const trigLine = (respText.ctx ?? []).find((l) => l.includes(extra.interaction.trigger_terms[0]))!
        extraHoldouts.push(`上句：${trigLine} 本句：${respText.text}`)
      }
      defs.push({
        fileBase: `${family}--extra`,
        cids,
        holdouts: extraHoldouts,
        entry: {
          name: extra.name,
          aliases: [],
          class: 'interaction',
          birth_circa: null,
          card: { ...baseCard, gist: `${family} 家族（语境形）：${extra.name}` },
          examples: [extra.name],
          matcher: { patterns: [{ kind: 'interaction', ...extra.interaction }], constraints: {} },
          lineage_parent: null,
          lineage_mutation: null,
          notes: 'curator 满分库（金标构建，语境形）',
        },
      })
    }
  }
  return defs
}

function main(): number {
  const argv = process.argv.slice(2)
  const runId = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : ''
  if (!runId) {
    console.error('用法: npx tsx scripts/curator-perfect.ts --run <id>')
    return 2
  }
  const dir = `${RUNS_DIR}/${runId}`
  const wrapper = resolve(`${dir}/wrapper/meme.mjs`)
  if (!existsSync(wrapper)) throw new Error(`${wrapper} 不存在（先 init）`)
  const gold = loadGold()
  const queries = readJsonl<Query>(QUERIES_FILE)

  const entryDir = join(dir, 'entries')
  mkdirSync(entryDir, { recursive: true })
  let ok = 0
  const failures: string[] = []
  for (const def of buildEntries(gold, queries)) {
    const file = join(entryDir, `${def.fileBase}.json`)
    writeFileSync(file, JSON.stringify(def.entry, null, 2), 'utf8')
    const args = [wrapper, 'add', '--entry-file', file, ...def.cids.flatMap((c) => ['--cid', c])]
    for (const h of def.holdouts) args.push('--holdout-text', h)
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    let payload: Record<string, unknown> = {}
    try { payload = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') } catch { /* ignore */ }
    if (r.status === 0 && payload.id) {
      ok++
      console.log(`${def.fileBase}: ${payload.id} ${payload.name} matcher=${payload.matcher} backtest.passed=${(payload.backtest as { passed?: boolean })?.passed}`)
    } else {
      failures.push(def.fileBase)
      console.error(`${def.fileBase}: FAIL exit=${r.status} ${r.stdout.trim().slice(0, 300)} ${r.stderr.trim().slice(0, 200)}`)
    }
  }
  console.log(`\n满分库构建：${ok} 条词条收录成功${failures.length ? `；失败：${failures.join(',')}` : ''}`)
  return failures.length ? 1 : 0
}

process.exitCode = main()
