import { readFileSync } from 'node:fs'

const ROOT = 'D:/Code/meme-cli'
const jl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const queries = jl(`${ROOT}/benchmarks/curator-v1/queries.jsonl`)
const labels = jl(`${ROOT}/benchmarks/candidate-judgment-v4/labels.jsonl`)
const seeds = jl(`${ROOT}/benchmarks/curator-v1/seed/candidates.jsonl`)

const goldFamilies = [...new Set(labels.map((r) => r.family_id).filter(Boolean))]
const famOfCid = new Map()
for (const r of labels) if (r.family_id) famOfCid.set(r.source_cid, r.family_id)
const noiseCids = [...new Set(labels.filter((r) => r.candidate_verdict === 'not-meme').map((r) => r.source_cid))]
const seedCids = new Set(seeds.map((s) => s.cid))

const out = []
const p = (s) => out.push(s)

p(`queries=${queries.length} unique_ids=${new Set(queries.map((q) => q.query_id)).size}`)
p(`gold families=${goldFamilies.length} noise_cids=${noiseCids.length} seeds=${seeds.length}`)
p(`channels=${JSON.stringify(Object.fromEntries([...new Set(queries.map((q) => q.channel))].map((c) => [c, queries.filter((q) => q.channel === c).length])))}`)
const tagCount = {}
for (const q of queries) for (const t of q.tags) tagCount[t] = (tagCount[t] ?? 0) + 1
p(`tags=${JSON.stringify(tagCount)}`)

const famStat = []
for (const f of goldFamilies) {
  const qs = queries.filter((q) => q.expect.family === f)
  const pos = qs.filter((q) => q.expect.hit).length
  const neg = qs.filter((q) => !q.expect.hit).length
  const hard = qs.filter((q) => !q.expect.hit && q.tags.includes('hard')).length
  famStat.push({ f, total: qs.length, pos, neg, hard })
}
p('\n--- per family (total pos neg hard) ---')
for (const s of famStat) p(`${s.f}\t${s.total}\t${s.pos}\t${s.neg}\t${s.hard}`)
const badFam = famStat.filter((s) => s.total < 5 || s.pos < 2 || s.neg < 3 || s.hard < 2)
p(`families below requirement: ${badFam.map((s) => `${s.f}(${s.total}/${s.pos}/${s.neg}/${s.hard})`).join(', ') || 'none'}`)
const famInQueries = [...new Set(queries.map((q) => q.expect.family).filter(Boolean))]
p(`families in queries=${famInQueries.length}; missing=${goldFamilies.filter((f) => !famInQueries.includes(f)).join(',') || 'none'}; unknown=${famInQueries.filter((f) => !goldFamilies.includes(f)).join(',') || 'none'}`)

const noiseQ = new Map()
for (const q of queries.filter((q) => !q.expect.hit && q.from_candidate)) noiseQ.set(q.from_candidate, (noiseQ.get(q.from_candidate) ?? 0) + 1)
const badNoise = noiseCids.filter((c) => (noiseQ.get(c) ?? 0) < 2)
p(`\nnoise cids with >=2 neg: ${noiseCids.length - badNoise.length}/${noiseCids.length}; below: ${badNoise.map((c) => `${c}(${noiseQ.get(c) ?? 0})`).join(',') || 'none'}`)
p(`negative queries total=${queries.filter((q) => !q.expect.hit).length}; with from_candidate=${queries.filter((q) => !q.expect.hit && q.from_candidate).length}; family-attached=${queries.filter((q) => !q.expect.hit && q.expect.family).length}`)

const fc = [...new Set(queries.map((q) => q.from_candidate).filter(Boolean))]
p(`from_candidate distinct=${fc.length}; not in seed=${fc.filter((c) => !seedCids.has(c)).join(',') || 'none'}`)
const posMismatch = queries.filter((q) => q.expect.hit && q.from_candidate && famOfCid.get(q.from_candidate) !== q.expect.family)
p(`positive from_candidate family mismatch=${posMismatch.length} ${posMismatch.slice(0, 5).map((q) => q.query_id).join(',')}`)

const textCount = new Map()
for (const q of queries) textCount.set(q.text, (textCount.get(q.text) ?? 0) + 1)
p(`duplicate texts=${[...textCount.values()].filter((n) => n > 1).length} groups; max=${Math.max(...textCount.values())}`)

const allowed = new Set(['cid', 'head', 'channel', 'kind_guess', 'state', 'videos', 'ups', 'evidence_usages'])
const badSeed = seeds.filter((s) => Object.keys(s).some((k) => !allowed.has(k)))
p(`\nseeds with extra keys=${badSeed.length}; duplicate cids=${seeds.length - seedCids.size}`)
const FORB = ['candidate_verdict', 'resolved_verdict', 'family_id', 'canonical_head', 'accepted_canonical_forms', 'rationale']
const leak = seeds.filter((s) => FORB.some((k) => JSON.stringify(s).includes(k)))
p(`seeds with forbidden keys=${leak.length}`)
p(`distinct label cids=${new Set(labels.map((r) => r.source_cid)).size} vs seeds=${seeds.length}`)

console.log(out.join('\n'))
