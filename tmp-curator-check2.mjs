import { readFileSync } from 'node:fs'
const ROOT = 'D:/Code/meme-cli'
const jl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

const queries = jl(`${ROOT}/benchmarks/curator-v1/queries.jsonl`)
const labels = jl(`${ROOT}/benchmarks/candidate-judgment-v4/labels.jsonl`)
const seeds = jl(`${ROOT}/benchmarks/curator-v1/seed/candidates.jsonl`)
const cases = jl(`${ROOT}/benchmarks/candidate-judgment-v4/cases.jsonl`)

const out = []
const p = (s) => out.push(s)

const st = {}
for (const s of seeds) st[s.state] = (st[s.state] ?? 0) + 1
p(`seed states: ${JSON.stringify(st)}`)
p(`cases 071/072: ${JSON.stringify(cases.filter((c) => c.case_id.endsWith('071') || c.case_id.endsWith('072')).map((c) => ({ id: c.case_id, cid: c.source_cid, head: c.head, kind: c.kind_guess, channel: c.channel, state: c.state })))}`)

const forms = new Map()
for (const r of labels) {
  if (!r.family_id) continue
  const set = forms.get(r.family_id) ?? new Set()
  for (const f of [r.canonical_head, ...r.accepted_canonical_forms]) if (f) set.add(f)
  forms.set(r.family_id, set)
}
const allForms = []
for (const [fam, set] of forms) for (const f of set) allForms.push({ fam, f })
const norm = (s) => s.toLowerCase().replace(/\s+/g, '')
const hit = (text, form) => {
  const n = form.trim().toLowerCase().replace(/\s+/g, '')
  if (!n) return false
  if (/^[a-z0-9]{1,4}$/.test(n)) return new RegExp(`(?<![a-z0-9])${n}(?![a-z0-9])`, 'i').test(text)
  return norm(text).includes(n)
}

let contaminated = 0
const bad = []
for (const q of queries.filter((q) => !q.expect.hit)) {
  const target = q.expect.family
  const hits = allForms.filter((x) => x.fam !== target && !x.f.includes('<') && hit(q.text, x.f))
  if (hits.length) { contaminated++; bad.push(`${q.query_id}[${target ?? 'noise'}] ← ${hits.map((h) => h.fam + ':' + h.f).join(',')} | ${q.text}`) }
}
p(`\nnegatives containing other-family forms: ${contaminated}`)
for (const b of bad.slice(0, 25)) p('  ' + b)

let posMissing = 0
const posBad = []
for (const q of queries.filter((q) => q.expect.hit)) {
  const fam = q.expect.family
  const fs = [...(forms.get(fam) ?? [])]
  const ok = fs.some((f) => {
    const m = f.match(/^(.*)<[^>]+>(.*)$/)
    if (m) {
      const pre = norm(m[1]), suf = norm(m[2])
      const hay = norm(q.text)
      return (!pre || hay.includes(pre)) && (!suf || hay.includes(suf))
    }
    return hit(q.text, f)
  })
  if (!ok) { posMissing++; posBad.push(`${q.query_id}(${fam}) ${q.text}`) }
}
p(`\npositives not containing any target family form: ${posMissing}`)
for (const b of posBad.slice(0, 20)) p('  ' + b)

console.log(out.join('\n'))
