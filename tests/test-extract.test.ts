/**
 * 统一抽取层（v0.11）单元测试：PMI 凝固度数学性质、冻结抑制与裸边界豁免、
 * 模板锚点共识扩展（含间隙槽）、槽位门控（填充多样性/双侧边缘槽拒绝）、
 * 裸话语复读的 copy 通道路由、操作员确认的 8 个截断案例完整形回归。
 */
import { describe, expect, it } from 'vitest'
import { buildCorpus, extractFixed, extractTemplates, collectUnits } from '../src/detect/extract.ts'
import { llr2x2 } from '../src/detect/evidence.ts'
import type { Unit } from '../src/detect/extract.ts'

const unit = (text: string, aid: number, weight = 1): Unit =>
  ({ text, aid, rpid: 0, root: 0, parent: 0, mid: 0, ctime: 0, chain: false, weight })

describe('LLR 2x2（Dunning）数学性质', () => {
  it('完全独立（比例相同）→ ≈0；完全解释 → 大值', () => {
    // 目标语料与背景语料同比例 → 无显著性
    expect(llr2x2(10, 90, 100, 900)).toBeCloseTo(0, 5)
    // 目标语料独有（基线为 0）→ 显著
    expect(llr2x2(10, 90, 0, 900)).toBeGreaterThan(20)
  })
  it('0 计数安全（0·ln0=0 约定）', () => {
    expect(llr2x2(0, 100, 0, 1000)).toBe(0)
    expect(llr2x2(5, 95, 0, 1000)).toBeGreaterThan(0)
  })
})

describe('固定表达抽取：PMI 与最大单元', () => {
  it('凝固 gram 立户，随机跨 gram 不立户（PMI 闸门）', () => {
    const units = [
      unit('蚌埠住了真的绷不住', 1), unit('今天蚌埠住了好难受', 2),
      unit('蚌埠住了这种事', 3), unit('蚌埠住了家人们', 4),
    ]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set())
    const heads = new Set(fixed.map((f) => f.head))
    expect(heads.has('蚌埠住了'), '高凝固四字表达立户').toBe(true)
  })

  it('冻结子串被抑制：gram 恒被同一后缀续接且无独立成评 → 不立户', () => {
    // 灵笼第 恒被"二"续接，无独立成评 → 灵笼第 不立户；灵笼第二季 立户
    const units = [
      unit('灵笼第二季真好看', 1), unit('等灵笼第二季更新', 2),
      unit('灵笼第二季的制作', 3), unit('灵笼第二季的内容', 4),
    ]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set())
    const heads = new Set(fixed.map((f) => f.head))
    expect(heads.has('灵笼第二季')).toBe(true)
    expect(heads.has('灵笼第'), '切片 gram 应被冻结抑制').toBe(false)
  })

  it('裸边界豁免：有独立成评出现的词头不被冻结抑制（绷 的家族）', () => {
    const units = [
      unit('绷不住了这画面', 1), unit('真的绷不住了', 2), unit('绷不住了家人们', 3),
      unit('绷', 4), unit('绷', 5),
    ]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set())
    const heads = new Set(fixed.map((f) => f.head))
    expect(heads.has('绷'), '独立成评的单字梗豁免冻结抑制').toBe(true)
    expect(heads.has('绷不住了')).toBe(true)
  })

  it('虚词性 gram 计数保险：jieba 全虚词标注的真梗照常立户（上号）', () => {
    const units = [unit('赶紧上号了', 1), unit('兄弟们上号', 2), unit('今晚必须上号', 3), unit('别磨蹭快上号', 4)]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set())
    const heads = new Set(fixed.map((f) => f.head))
    expect(heads.has('上号'), '"上号"[上/f][号/m] 全虚词标注，重复即证据').toBe(true)
  })

  it('跨轮创建补救：轮内 dv=1 但历史出现过的完整表达立户', () => {

    const units = [unit('steam管家可以玩', 1), unit('steam管家可以玩', 1)]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set(), () => 3) // 历史 phrase_daily 有 ≥3 天痕迹
    const heads = new Set(fixed.map((f) => f.head))
    expect(heads.has('steam管家'), '历史补救让散布多轮的低频单元立户').toBe(true)
  })

  it('跨轮创建补救（低频持续）：轮内仅 1 次但历史 ≥2 天 → 立户', () => {
    const units = [unit('我今天抽象发言了', 1)]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set(), () => 2)
    expect(fixed.find((f) => f.head === '抽象'), '历史 ≥2 天 + 轮内 1 次即立户').toBeDefined()
    // 历史 0 天（全新词）不放宽到单次
    const fixed0 = extractFixed(corpus, new Set(), () => 0)
    expect(fixed0.find((f) => f.head === '抽象')).toBeUndefined()
  })

  it('裸话语复读 → copy 通道（免自推剪枝的领地）', () => {
    const units = [unit('刷到极品了', 1), unit('刷到极品了', 2)]
    const corpus = buildCorpus(units)
    const fixed = extractFixed(corpus, new Set())
    const c = fixed.find((f) => f.head === '刷到极品了')
    expect(c, '整句复读立户').toBeDefined()
    expect(c!.channel).toBe('copy')
  })

  it('整句字面复读跨视频立户，封禁表拦截', () => {
    const units = [unit('自己来拿家在这里', 1), unit('自己来拿家在这里', 2)]
    const corpus = buildCorpus(units)
    const generic = new Set(['自己来拿家在这里'])
    const fixed = extractFixed(corpus, generic)
    expect(fixed.find((f) => f.head.includes('自己来拿'))).toBeUndefined()
  })
})

describe('模板抽取：锚点共识扩展与槽位门控', () => {
  it('字级锚点跨词坍缩：赢麻了/亏麻了 → <X>麻了（旧后缀族案例）', () => {
    const units: Unit[] = []
    ;['赢麻了', '亏麻了', '输麻了', '赚麻了'].forEach((w, i) => {
      units.push(unit(`这波直接${w}`, 301 + i))
      units.push(unit(`兄弟们${w}，没眼看了`, 305 + i))
    })
    const corpus = buildCorpus(units)
    const tpls = extractTemplates(corpus)
    const head = tpls.find((t) => t.head === '<X>麻了')
    expect(head, '后缀公式族坍缩为 <X>麻了').toBeDefined()
    expect(head!.dv).toBeGreaterThanOrEqual(4)
  })

  it('间隙扩展：一眼X鉴定为Y → 一眼<ent>鉴定为<X>（双槽真公式）', () => {
    const units = [
      unit('一眼原神鉴定为云玩家', 1), unit('一眼华为鉴定为遥遥领先', 2),
    ]
    const corpus = buildCorpus(units)
    const tpls = extractTemplates(corpus)
    const head = tpls.find((t) => t.head.startsWith('一眼') && t.head.includes('<ent>'))
    expect(head, '间隙槽跨过可变实体').toBeDefined()
    expect(head!.head).toContain('鉴定为')
  })

  it('标点是硬边界：X，启动 的核心不被前句延伸（<X>启动 公式形状）', () => {
    const units = [
      unit('原神，启动！', 1), unit('魔兽，启动', 2), unit('明日方舟，启动', 3),
    ]
    const corpus = buildCorpus(units)
    const tpls = extractTemplates(corpus)
    const head = tpls.find((t) => t.head === '<X>启动')
    expect(head, '逗号防止核心延伸成"方舟启动"，边缘槽捕获 utterance 开头变量').toBeDefined()
  })

  it('填充多样性门控：X分钟 的数量词填充坍缩为一类 → 判假公式', () => {
    const units = [
      unit('等了几分钟', 1), unit('等了四分钟', 2), unit('等了十几分钟', 3), unit('才五分钟', 4),
    ]
    const corpus = buildCorpus(units)
    const tpls = extractTemplates(corpus)
    const head = tpls.find((t) => t.head.replace(/<[^>]+>/g, '') === '分钟' && t.head.includes('<'))
    expect(head, '数量词填充无语义自由度，模板被拒').toBeUndefined()
  })

  it('双侧边缘槽拒绝：<X>词<X> 断言不了任何东西', () => {
    const units = [
      unit('他说这是真的', 1), unit('我说这是假的', 2), unit('大家都说这是造谣', 3), unit('有人说这是真的吗', 4),
    ]
    const corpus = buildCorpus(units)
    const tpls = extractTemplates(corpus)
    const head = tpls.find((t) => t.head === '<X>这是<X>')
    expect(head, '两侧自由槽的语法模板拒绝').toBeUndefined()
  })

  it('跨轮同模板产出同头（共识稳定性）', () => {
    const games = ['原神', '魔兽', '明日方舟']
    const mk = (base: number) => games.map((g, i) => unit(`${g}，启动${i % 2 ? '！' : ''}`, base + i))
    const r1 = extractTemplates(buildCorpus(mk(1)))
    const r2 = extractTemplates(buildCorpus(mk(4)))
    const h1 = r1.find((t) => t.head === '<X>启动')
    const h2 = r2.find((t) => t.head === '<X>启动')
    expect(h1).toBeDefined()
    expect(h2).toBeDefined()
    expect(h1!.head).toBe(h2!.head)
  })
})

describe('操作员确认的截断案例完整形回归（2026-11-22）', () => {
  /** 每个案例：单元序列 + 期望出现的完整形词头/模板。 */
  const CASES: Array<{ name: string; units: Unit[]; expect: string[]; generic?: string[] }> = [
    {
      name: '启动→XX启动', expect: ['<X>启动'],
      units: [unit('原神，启动！', 1), unit('魔兽，启动', 2), unit('明日方舟，启动', 3)],
    },
    {
      name: '一股→一股X（味）', expect: ['一股'],
      units: [unit('咋一股ai味', 1), unit('一股打工人的无奈', 2), unit('一股饭圈味', 3)],
    },
    {
      name: 'steam→steam管家', expect: ['steam管家'],
      units: [unit('steam管家可以玩', 1), unit('steam管家真的可以玩', 1)],
    },
    {
      name: '爆→爆了', expect: ['爆了'],
      units: [unit('某个v爆了', 1), unit('那个v爆了', 2)],
    },
    {
      name: '纷争→纷争开始了', expect: ['纷争开始了'],
      units: [unit('纷争开始了', 1), unit('纷争开始了', 2)],
    },
    {
      name: '骨架<X>文本→字面请输入文本', expect: ['请输入文本'],
      units: [unit('请输入文本', 1), unit('请输入文本', 2)],
      generic: [],
    },
    {
      name: 'bin哥…→完整句式', expect: ['bin哥你做人真的可以'],
      units: [unit('bin哥你做人真的可以', 1), unit('bin哥你做人真的可以', 2)],
    },
    {
      name: '单字x+游戏名→x环', expect: ['x环'],
      units: [unit('又是x环', 1), unit('怎么又是x环', 2)],
    },
  ]
  for (const c of CASES) {
    it(c.name, () => {
      const corpus = buildCorpus(c.units)
      const fixed = extractFixed(corpus, new Set(c.generic ?? []), () => 3)
      const tpls = extractTemplates(corpus)
      const heads = new Set([...fixed.map((f) => f.head), ...tpls.map((t) => t.head)])
      for (const want of c.expect) {
        expect(heads.has(want), `"${want}" 应以完整形被抽出；实际：${[...heads].join(', ')}`).toBe(true)
      }
    })
  }
})

describe('collectUnits 基础行为', () => {
  it('评论入列、楼中楼短消息拼接为接龙单元', () => {
    const ts = Math.floor(Date.now() / 1000)
    const rows = [
      { message: '正常评论', oid: 1, rpid: 1, root: 0, parent: 0, mid: 1, ctime: ts },
      { message: '好', oid: 2, rpid: 2, root: 9, parent: 9, mid: 2, ctime: ts },
      { message: '笑', oid: 2, rpid: 3, root: 9, parent: 9, mid: 3, ctime: ts + 1 },
    ]
    const units = collectUnits(rows as never[])
    expect(units.filter((u) => !u.chain).length).toBe(3) // 评论本身也入列
    const chain = units.find((u) => u.chain)
    expect(chain?.text).toBe('好笑')
    expect(chain?.chain).toBe(true)
  })
})
