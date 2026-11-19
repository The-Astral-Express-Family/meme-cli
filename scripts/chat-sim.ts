/**
 * 群聊场景模拟：量化 read path 在"理解梗"与"接话找梗"两个方向的效果。
 *
 * 理解向 = lookup（别人发了含梗的话，agent 要识别）
 * 接话向 = search（情境描述，agent 要想起恰当的梗）——检索方向与 lookup 相反，
 *          是"根据别人的话想到一个梗"的路径（BM25+向量 RRF）。
 *
 * 用法：npx tsx scripts/chat-sim.ts [--db <path>]
 */
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { connect } from '../src/db.ts'
import { resolveConfig } from '../src/config.ts'
import { lookup } from '../src/match/pipeline.ts'
import { getEmbedder } from '../src/match/vector.ts'
import { hybridSearch } from '../src/retrieve/fuse.ts'

/** (话语, 期望命中的词条名, 方向) direction: understand=lookup / recall=search */
const CASES: Array<[string, string[], 'understand' | 'recall']> = [
  // ---- 理解向：字面与真实变体 ----
  ['这波啊，这波是赢麻了', ['赢麻了'], 'understand'],
  ['真的难绷，他真敢说', ['难绷'], 'understand'],
  ['绷不住了兄弟们', ['难绷'], 'understand'], // 别名改写
  ['警钟长鸣', ['警钟长鸣'], 'understand'],
  ['急了急了，破防了属于是', ['急了急了'], 'understand'],
  ['回答我！look in my eyes! tell me why!', ['回答我'], 'understand'],
  ['显卡又降价了，等等党狂喜', ['等等党'], 'understand'],
  ['评论区全是大肥鱼', ['大肥鱼'], 'understand'],
  ['2026年11月前来考古', ['前来考古'], 'understand'],
  ['我才是最晚的人', ['最晚之人'], 'understand'], // 变体改写（词条名"最晚之人"）
  // ---- 理解向：含梗词的非梗用法（应 miss/低置信，负例） ----
  ['为什么不回答我？', [], 'understand'],
  ['今天中午吃什么', [], 'understand'],
  // ---- 接话向：情境 → 想起梗（search） ----
  ['股价又跌了，我心态崩了', ['赢麻了', '难绷'], 'recall'],
  ['这视频也太离谱了', ['难绷'], 'recall'],
  ['他又在群里炫耀战绩了', ['赢麻了'], 'recall'],
  ['去老视频底下盖楼打卡', ['前来考古', '最晚之人'], 'recall'],
  ['你倒是给我个解释啊', ['回答我'], 'recall'],
  ['看完这新闻我人麻了', ['赢麻了'], 'recall'],
  ['都别吵了，楼里盖成这样了', ['你说得对'], 'recall'],
]

const args = process.argv.slice(2)
const dbArg = args[args.indexOf('--db') + 1] ?? join(process.env.USERPROFILE ?? '~', '.meme', 'memes.db')

const cfg = resolveConfig()
const db = connect(dbArg)
const emb = getEmbedder(cfg.retrieval.embed_model)

const nVec = (db.prepare('SELECT COUNT(*) AS c FROM meme_vectors').get() as { c: number }).c
const nMemes = (db.prepare('SELECT COUNT(*) AS c FROM memes').get() as { c: number }).c
const t0 = performance.now()
await emb.embed(['预热'])
console.log(`库内词条 ${nMemes}，向量锚点 ${nVec} 条，embed 预热 ${((performance.now() - t0)).toFixed(0)}ms\n`)

let luOk = 0
let luMissExpected = 0
let rcOk = 0
let rcFail = 0
const lat: number[] = []

for (const [text, expected, mode] of CASES) {
  const start = performance.now()
  if (mode === 'understand') {
    const hits = await lookup(db, text, null, cfg.retrieval.vector_threshold, emb)
    const ms = performance.now() - start
    lat.push(ms)
    let got = hits.slice(0, 3).map((h) => h.name)
    let flag: string
    if (expected.length) {
      const hitOk = got.some((g) => expected.includes(g))
      luOk += hitOk ? 1 : 0
      flag = hitOk ? '✓' : '✗漏'
      if (!got.length) got = ['(miss)']
    } else {
      const hitOk = !hits.length || hits.every((h) => h.tier === 4)
      luMissExpected += hitOk ? 1 : 0
      flag = hitOk ? '✓正确miss' : '✗误报'
    }
    console.log(`${flag} lookup ${ms.toFixed(1).padStart(6)}ms  「${text.slice(0, 22)}」→ ${got.join(',')}`)
  } else {
    const rs = await hybridSearch(db, text, cfg.retrieval, { top: 3, embedder: emb })
    const ms = performance.now() - start
    lat.push(ms)
    const got = rs.slice(0, 3).map((r) => r.meme.name)
    const hitOk = got.some((g) => expected.includes(g))
    rcOk += hitOk ? 1 : 0
    rcFail += hitOk ? 0 : 1
    console.log(`${hitOk ? '✓' : '✗'} recall ${ms.toFixed(1).padStart(6)}ms  「${text.slice(0, 22)}」→ ${got.join(',') || '(empty)'}`)
  }
}

const nU = CASES.filter((c) => c[2] === 'understand').length
const nUPos = CASES.filter((c) => c[2] === 'understand' && c[1].length).length
const nR = CASES.filter((c) => c[2] === 'recall').length
console.log(`\n理解向：命中 ${luOk}/${nUPos}，负例正确miss ${luMissExpected}/${nU - nUPos}`)
console.log(`接话向：recall@3 命中 ${rcOk}/${nR}`)
console.log(`延迟：平均 ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)}ms  最大 ${Math.max(...lat).toFixed(0)}ms（含首次）`)
db.close()
