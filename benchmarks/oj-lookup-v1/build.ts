/**
 * OJ lookup benchmark v1 的题目构建器（fixture 源，评估专用）。
 *
 * 运行 `npx tsx benchmarks/oj-lookup-v1/build.ts` 重新生成 entries.jsonl / cases.jsonl /
 * manifest.json。用例与期望（expect）同文件存放——OJ 评的是系统/模型对"给定词条 +
 * 输入"的行为，不是盲测；模型作答走 scripts/oj-judge-prompt.ts 生成的无期望 prompt。
 *
 * 出题纪律（对应 README 的必测类别）：
 * - 正例必须含目标词条的合法形式（canonical/alias/槽位填充）；
 * - 词表负例不得包含连续的目标词，除非该负例依赖约束（forbid_inner/standalone）否决；
 * - 公式负例测槽位语法限制与字面义——部分字面义（槽内词被吞进 span）是 matcher
 *   已知硬负例（tag 标 slot-literal-hard），系统行 FP 是真实暴露，不是出题事故；
 * - 交互题上下文必须成对（ctx = [上句, 本句]，最后一行是待匹配行）；
 * - 示例不得与 candidate-judgment-v4 金标同源（防串题）。
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 词条：26 个，覆盖 word(lex) / formula(skeleton) / interaction / conditional
// （forbid/require context）。matcher 写法与 entry JSON schema 一致。
// ---------------------------------------------------------------------------
interface EntryDef {
  id: string
  name: string
  family: string
  class: 'word' | 'formula' | 'interaction' | 'event'
  gist: string
  matcher: unknown
}

const L = (terms: string[], constraints: Record<string, unknown> = {}): unknown => ({
  patterns: [{ kind: 'lex', terms }],
  constraints: { standalone: false, sentence_final: false, forbid_inner: false, forbid_context: [], require_context: [], ...constraints },
})
const S = (tokens: string[], constraints: Record<string, unknown> = {}): unknown => ({
  patterns: [{ kind: 'skeleton', tokens }],
  constraints: { standalone: false, sentence_final: false, forbid_inner: false, forbid_context: [], require_context: [], ...constraints },
})
const I = (trigger: string[], response: string[]): unknown => ({
  patterns: [{ kind: 'interaction', trigger_terms: trigger, response_terms: response, trigger_tokens: [], response_tokens: [] }],
  constraints: {},
})

const ENTRY_DEFS: EntryDef[] = [
  // ---- word（词表层）----
  { id: 'm_0001', name: '蚌埠住了', family: 'bengbu', class: 'word', gist: '绷不住的谐音，忍俊不禁',
    matcher: L(['蚌埠住了', '蚌住了']) },
  { id: 'm_0002', name: '栓Q', family: 'shuanq', class: 'word', gist: 'thank you 谐音，无奈感谢',
    matcher: L(['栓Q', '栓q', 'shuanQ', 'shuanq']) },
  { id: 'm_0003', name: '我不到啊', family: 'wobudao', class: 'word', gist: '我不知道啊的口音梗',
    matcher: L(['我不到啊']) },
  { id: 'm_0004', name: '典中典', family: 'dianzhongdian', class: 'word', gist: '过于经典、讽刺性地经典',
    matcher: L(['典中典', '完全是典中典']) },
  { id: 'm_0005', name: '乐子人', family: 'leziren', class: 'word', gist: '只为看乐子参与争论的人',
    matcher: L(['乐子人']) },
  { id: 'm_0006', name: '遥遥领先', family: 'yaoyao', class: 'word', gist: '发布会式夸张宣传语',
    matcher: L(['遥遥领先']) },
  { id: 'm_0007', name: '那咋了', family: 'nazhale', class: 'word', gist: '满不在乎的反问回应',
    matcher: L(['那咋了', '那咋了嘛']) },
  { id: 'm_0008', name: '偷感很重', family: 'tougan', class: 'word', gist: '行事鬼祟、怕被注意的状态',
    matcher: L(['偷感很重', '偷感']) },
  { id: 'm_0009', name: '尊嘟假嘟', family: 'zundu', class: 'word', gist: '真的假的的卖萌说法',
    matcher: L(['尊嘟假嘟', '尊嘟']) },
  { id: 'm_0010', name: '包的', family: 'baode', class: 'word', gist: '肯定的、稳的（赌定语气）',
    matcher: L(['包的', '包g'], { forbid_inner: true }) },
  { id: 'm_0011', name: 'city不city', family: 'city', class: 'word', gist: '洋气不洋气、时髦不时髦',
    matcher: L(['city不city', 'city不city啊']) },
  { id: 'm_0012', name: '你人还怪好的嘞', family: 'guaihao', class: 'word', gist: '反差式夸人善良',
    matcher: L(['你人还怪好的嘞', '人还怪好的嘞']) },
  { id: 'm_0013', name: '泰裤辣', family: 'taiku', class: 'word', gist: '太酷啦的谐音赞叹',
    matcher: L(['泰裤辣', '太酷啦']) },
  { id: 'm_0014', name: '硬控', family: 'yingkong', class: 'word', gist: '被牢牢吸引住走不开',
    matcher: L(['硬控'], { forbid_inner: true }) },
  { id: 'm_0015', name: '典', family: 'dian', class: 'word', gist: '单字：太经典/太讽刺了',
    matcher: L(['典'], { forbid_inner: true, standalone: true }) },

  // ---- formula（骨架层）----
  { id: 'm_0101', name: '<X>麻了', family: 'male', class: 'formula', gist: '被整到麻木/服了的前缀槽公式',
    matcher: S(['<ent>', '麻了'], { forbid_context: ['脚', '手', '腿', '胳膊', '肩膀', '脖子'] }) },
  { id: 'm_0102', name: '<X>大学习', family: 'daxuexi', class: 'formula', gist: '套用集体学习节目名的公式化调侃',
    matcher: S(['<ent>', '大学习'], { forbid_context: ['主题', '任务', '课程', '复习', '作业', '知识'] }) },
  { id: 'm_0103', name: '不是<X>买不起，而是<Y>更有性价比', family: 'xingjiabi', class: 'formula', gist: '两槽对比式消费理由公式',
    matcher: S(['不是', '<ent>', '买不起，而是', '<ent>', '更有性价比']) },
  { id: 'm_0104', name: '<X>含金量还在上升', family: 'hanjinliang', class: 'formula', gist: '某人/物的权威性不断被验证的公式',
    matcher: S(['<ent>', '含金量', '还在', '上升']) },
  { id: 'm_0105', name: '<X>，启动！', family: 'qidong', class: 'formula', gist: '宣告某事物开演的仪式感公式',
    matcher: S(['<ent>', '启动'], { forbid_context: ['发动机', '引擎', '汽车', '点火', '电门', '钥匙'] }) },
  { id: 'm_0106', name: '一眼<X>鉴定为<Y>', family: 'jianding', class: 'formula', gist: '一眼定性句式，双槽公式',
    matcher: S(['一眼', '<ent>', '鉴定为', '<ent>']) },

  // ---- interaction（交互层，需会话上文）----
  { id: 'm_0201', name: '小黑子', family: 'xiaoheizi', class: 'interaction', gist: '对某明星黑粉的戏称接龙',
    matcher: I(['蔡徐坤', '坤坤', 'ikun', '鸡你太美', '食不食油饼'], ['小黑子', '鸡脚', '露出鸡脚', '食不食油饼']) },
  { id: 'm_0202', name: '我是云南的', family: 'yunnan', class: 'interaction', gist: '报家乡接龙梗',
    matcher: I(['我是云南的'], ['云南怒江的', '傈僳族的', '怒江傈僳族的']) },
  { id: 'm_0203', name: '注意看小帅', family: 'xiaoshuai', class: 'interaction', gist: '解说电影开头句式接龙',
    matcher: I(['注意看'], ['这个男人叫小帅', '这个女人叫小美', '小帅', '小美']) },

  // ---- conditional（约束层：forbid/require context）----
  { id: 'm_0301', name: '回答我', family: 'huida', class: 'word', gist: '祈使咆哮式追问；疑问句用法否决',
    matcher: L(['回答我'], { forbid_context: ['？', '?', '吗', '吧', '呢', '一下', '请'] }) },
  { id: 'm_0302', name: '上桌', family: 'shangzhuo', class: 'word', gist: '牌局语境的"新人入局"梗；日常餐桌用法否决',
    matcher: L(['上桌'], { require_context: ['德州', '德扑', '牌', '局', '墩子', '筹码'], forbid_context: ['菜', '饭', '端', '搬', '酒'] }) },
]

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

interface CaseDef {
  channel: 'phrase' | 'formula' | 'interaction' | 'conditional'
  family: string
  entry: string
  text: string
  ctx?: string[]
  hit: boolean
  forbid?: string[]
  tags: string[]
  note?: string
}

const cases: CaseDef[] = []

/** phrase 正例：每个 (text | [text, ctx]) 一题。 */
const P = (family: string, entry: string, tags: string[], texts: Array<string | [string, string[]]>, note?: string): void => {
  for (const t of texts) {
    if (Array.isArray(t)) push({ channel: 'phrase', family, entry, text: t[0], ctx: t[1], hit: true, tags, note })
    else push({ channel: 'phrase', family, entry, text: t, hit: true, tags, note })
  }
}
/** phrase 硬负例：不包含连续目标词（约束否决类除外），forbid = 该家族。 */
const N = (family: string, entry: string, tags: string[], texts: string[], note?: string): void => {
  for (const t of texts) push({ channel: 'phrase', family, entry, text: t, hit: false, forbid: [family], tags, note })
}
const push = (c: CaseDef): void => { cases.push(c) }

// ---- phrase 正例：canonical / 别名 / 句中位置 ----
P('bengbu', '蚌埠住了', ['canonical', 'sentence-mid'], [
  '蚌埠住了', '我真是蚌埠住了', '看到这个结尾我蚌埠住了',
])
P('bengbu', '蚌埠住了', ['alias'], ['这也太蚌住了'])
P('shuanq', '栓Q', ['canonical', 'sentence-final'], ['栓Q', '我真的会栓Q', '讲到这里我只想说栓Q'])
P('shuanq', '栓Q', ['lowercase-alias'], ['看完我 shuanq 了'])
P('wobudao', '我不到啊', ['canonical'], ['我不到啊', '问就是——我不到啊', '你问我我问谁，我不到啊'])
P('dianzhongdian', '典中典', ['canonical'], ['典中典', '属于是完全典中典了', '这剧情真是典中典'])
P('leziren', '乐子人', ['canonical'], ['乐子人又赢了', '别吵了，我就一乐子人', '这评论区全是乐子人'])
P('yaoyao', '遥遥领先', ['canonical'], ['遥遥领先', '这配置可以说遥遥领先了', '销量遥遥领先的还是它'])
P('nazhale', '那咋了', ['canonical'], ['那咋了', '迟到五分钟，那咋了', '考挂了，那咋了嘛'])
P('tougan', '偷感很重', ['canonical'], ['偷感很重', '他拍照时偷感很重', '全程偷感很重地瞄屏幕'])
P('tougan', '偷感', ['alias'], ['主打一个偷感十足'])
P('zundu', '尊嘟假嘟', ['canonical'], ['尊嘟假嘟', '这价格尊嘟假嘟？尊嘟！'])
P('zundu', '尊嘟', ['alias'], ['尊嘟，不骗你'])
P('baode', '包的', ['canonical'], ['包的', '明天赢，包的', '这把包的，兄弟们冲'])
P('baode', '包g', ['alias'], ['能成，包g'])
P('city', 'city不city', ['canonical'], ['city不city', '这街拍 city不city啊'])
P('guaihao', '你人还怪好的嘞', ['canonical'], ['你人还怪好的嘞', '帮我占了座，你人还怪好的嘞'])
P('taiku', '泰裤辣', ['canonical'], ['泰裤辣', '这舞台泰裤辣'])
P('taiku', '太酷啦', ['alias'], ['这个联动太酷啦'])
P('yingkong', '硬控', ['canonical', 'sentence-mid'], ['这视频硬控我三秒', '直接硬控我一整天', '被这个手法硬控住了'])
P('dian', '典', ['single-char', 'glue-context'], ['太典了', '真典', '这段视频是真的典'])

// ---- phrase 正例补充：标点/表情变体、更长自然句 ----
P('bengbu', '蚌埠住了', ['emoji-variant'], ['哈哈哈哈蚌埠住了[笑哭]', '蚌埠住了，这视频太好了', '一天笑了八次，蚌埠住了'])
P('shuanq', '栓Q', ['sentence-mid'], ['栓Q，无语子', '教培行业栓Q了属于是'])
P('wobudao', '我不到啊', ['dialogue'], ['我不到啊，你问他', '急了？我不到啊'])
P('dianzhongdian', '典中典', ['extended'], ['典中典之从不自证', '太典了，属于是典中典'])
P('leziren', '乐子人', ['sentence-mid'], ['纯乐子人，别当真', '乐子人路过，你们继续'])
P('yaoyao', '遥遥领先', ['repeat'], ['遥遥领先，遥遥领先', '不得不说，遥遥领先'])
P('nazhale', '那咋了', ['dialogue'], ['加班到十点，那咋了', '0分，那咋了'])
P('tougan', '偷感很重', ['sentence-mid'], ['偷感很重地摸鱼', '上课偷感很重地传纸条'])
P('zundu', '尊嘟假嘟', ['sentence-mid'], ['尊嘟假嘟，你再说一遍', '尊嘟假嘟o.O'])
P('baode', '包的', ['dialogue'], ['包的，等我消息', '这题包的，不用查'])
P('city', 'city不city', ['extended'], ['这里city不city啊？好city啊'])
P('guaihao', '你人还怪好的嘞', ['sentence-mid'], ['你还帮我带了饭，你人还怪好的嘞'])
P('taiku', '泰裤辣', ['sentence-mid'], ['他唱泰裤辣那段全场沸腾', '这特效泰裤辣'])
P('yingkong', '硬控', ['duration'], ['硬控半小时', '这个视频把我硬控了'])
P('dian', '典', ['dialogue'], ['太典了兄弟们', '确实典'])

// ---- phrase 硬负例：同子串的普通用法 / 更长词内部 / 地名字面 ----
N('bengbu', '蚌埠住了', ['place-name-literal'], [
  '去蚌埠出差住了三天', '蚌埠市的房价又涨了', '他从蚌埠回来住了两晚酒店', '他在蚌埠住过十年',
], '地名"蚌埠"与"住了"被隔断，非梗')
N('dianzhongdian', '典中典', ['cross-char-substring'], [
  '新华字典的典部收字很多', '词典中的释义页码标错了',
], '"典/中/典"被其他词隔断')
N('leziren', '乐子人', ['substring-normal'], [
  '周末就想找点乐子', '马戏团的乐子真多', '他讲了个乐子，大家笑笑',
], '"乐子"是普通名词，缺"人"')
N('nazhale', '那咋了', ['variant-only'], [
  '那咋办，钥匙丢了得找物业', '这咋了，你倒是说清楚啊',
], '近形但非梗形')
N('shuanq', '栓Q', ['cross-char-substring'], [
  '门栓缺了Q型密封圈', '木栓切Q面工艺不合格',
], '"栓/Q"不相邻')
N('baode', '包的', ['forbid-inner', 'substring-normal'], [
  '面包的味道不错', '这个包裹的封条完好', '钱包的拉链坏了',
], '"包的"是"面包的/包裹的/钱包的"内部，forbid_inner 否决')
N('yingkong', '硬控', ['forbid-inner', 'substring-normal'], [
  '游戏里加了个硬控制技能', '这游戏的硬控制系统做得不行',
], '"硬控"是"硬控制"内部，forbid_inner 否决')
N('dian', '典', ['forbid-inner'], [
  '古典音乐电台', '他可是网上词典的编辑', '字典里查到这个字',
], '"典"在更长词内部，forbid_inner 否决')
N('dian', '典', ['forbid-inner'], [
  '经典永流传', '典礼开始了',
], '"典"在更长词内部，forbid_inner 否决')
N('city', 'city不city', ['english-literal'], [
  '这个 city 的 map 上没有环路', '上海 city walk 的路线火了',
], 'city 作英文本义，非完整梗形')
N('guaihao', '你人还怪好的嘞', ['variant-literal'], [
  '你这人还怪好说话的',
], '字面夸"好说话"，非完整梗形')
N('taiku', '泰裤辣', ['variant-only'], [
  '太酷了，这个图标设计', '这条裤子太酷了',
], '字面"太酷了"，缺谐音形')
N('tougan', '偷感', ['substring-normal'], [
  '小偷偷钱包被当场抓住',
], '"偷/感"不相邻')
N('wobudao', '我不到啊', ['variant-only'], [
  '我找不到答案', '这个数据我查不到啊',
], '字面"查不到"，非口音梗形')
N('zundu', '尊嘟假嘟', ['variant-only'], [
  '嘟嘟囔囔说了半天', '他在嘟嘟囔囔抱怨',
], '"尊嘟"不相邻')
N('bengbu', '蚌埠住了', ['context-split'], [
  '绷不住了——抱歉说错了，是蚌埠的亲戚来住了',
], '谐音源词出现但宿主被句隔断')
N('baode', '包的', ['forbid-inner'], [
  '面包的保质期到了', '包裹的快递单号查不到',
], '"包的"在更长词内部，forbid_inner 否决')
N('yingkong', '硬控', ['forbid-inner'], [
  '硬控制住了场面', '他硬控制住了情绪',
], '"硬控"是"硬控制"内部，forbid_inner 否决')
N('泰裤辣', '泰裤辣', ['variant-only'], [
  'taiku 这个词怎么拼',
], '拼音形不在词表，严格按词表宁漏不滥')
N('nazhale', '那咋了', ['variant-only'], [
  '咋了这是，吓我一跳',
], '语序不同，非梗形')
N('leziren', '乐子人', ['variant-only'], [
  '找乐子的小人物', '他就是个逗乐子的',
], '"乐子"用法普通，缺"乐子人"完整形')
N('dianzhongdian', '典中典', ['variant-only'], [
  '典籍中的经典段落', '字典里典章制度的条目',
], '"典中典"跨词隔断')

// ---- 全局噪音负例：泛夸 / 礼仪 / 日常句，不允许命中任何家族 ----
const NOISE_FORBID = ['bengbu', 'shuanq', 'wobudao', 'dianzhongdian', 'leziren', 'yaoyao', 'nazhale',
  'tougan', 'zundu', 'baode', 'city', 'guaihao', 'taiku', 'yingkong', 'dian',
  'male', 'daxuexi', 'xingjiabi', 'hanjinliang', 'qidong', 'jianding',
  'xiaoheizi', 'yunnan', 'xiaoshuai', 'huida', 'shangzhuo']
for (const text of [
  '主播讲得真好，又学到了',
  '太牛了，这个画质无敌了',
  '支持支持，期待更新',
  '来了来了，前排打卡',
  '这个知识点讲得真清楚，收藏了',
  '哈哈哈，太逗了',
  '楼主辛苦了，整理得很全',
  '深度好文，转发给朋友了',
  '第一次来，关注了',
  '视频做得真不错，赞',
  '今天天气不错，适合出门',
  '这个游戏我玩了三年了',
  '我的猫今天不吃东西，好担心',
  '求个bgm歌名',
  '蹲一个后续',
  'up主加油，慢慢更新不着急',
  '这期数据不错啊，恭喜',
  '弹幕都在刷屏，太热闹了',
  '刚看完电影回来，结局还行',
  '楼下说得对',
  '有内味儿了',
  '这波操作可以',
  '太离谱了吧',
  '？？？？',
  '哈哈哈哈哈哈哈',
  '这个剪辑太帅了',
  '建议出续集',
  '前排围观',
  '路过留个脚印',
  '群主威武',
  'mark一下',
  '学到了学到了',
  '泪目了兄弟们',
  '这才是真的技术流',
]) {
  push({ channel: 'phrase', family: 'noise', entry: '（无）', text, hit: false, forbid: NOISE_FORBID, tags: ['global-noise'], note: '泛夸/礼仪/日常噪音，不允许命中任何家族' })
}

// ---- formula 正例：同类替换 / 跨域 / 多词实体 / 多槽 / 标点差异 ----
const F = (family: string, entry: string, tags: string[], rows: Array<{ text: string; note?: string }>): void => {
  for (const r of rows) push({ channel: 'formula', family, entry, text: r.text, hit: true, tags, note: r.note })
}
F('male', '<X>麻了', ['slot-same-domain'], [
  { text: '赢麻了' }, { text: '累麻了' }, { text: '帅麻了' }, { text: '看到期末安排我爽麻了' },
])
F('male', '<X>麻了', ['slot-cross-domain'], [
  { text: '这波反向操作给我看麻了' }, { text: '甲方需求改了八遍，改麻了' },
])
F('male', '<X>麻了', ['slot-multi-word'], [
  { text: '连续加班两周的人已经emo麻了' },
])
F('daxuexi', '<X>大学习', ['slot-same-domain'], [
  { text: '青年大学习' }, { text: '每日325大学习' }, { text: '全网都开始元宇宙大学习了' },
])
F('daxuexi', '<X>大学习', ['slot-cross-domain'], [
  { text: '小区团购大学习' }, { text: '办公室摸鱼大学习' },
])
F('xingjiabi', '不是<X>买不起，而是<Y>更有性价比', ['multi-slot'], [
  { text: '不是羽绒服买不起，而是军大衣更有性价比' },
  { text: '不是咖啡买不起，而是豆浆更有性价比', note: '跨域替换' },
  { text: '不是新手机买不起，而是二手的更有性价比', note: '多词实体槽' },
])
F('hanjinliang', '<X>含金量还在上升', ['slot-same-domain'], [
  { text: '选手的含金量还在上升' },
  { text: '这本教材的含金量还在上升', note: '跨域' },
])
F('hanjinliang', '<X>含金量还在上升', ['slot-multi-word'], [
  { text: '食堂阿姨手不抖传说的含金量还在上升' },
])
F('qidong', '<X>，启动！', ['slot-same-domain', 'punctuation'], [
  { text: '原神，启动！' }, { text: '原神启动', note: '无标点变体' },
  { text: '周一，启动！' }, { text: '考研模式，启动！' },
])
F('jianding', '一眼<X>鉴定为<Y>', ['multi-slot'], [
  { text: '一眼原神鉴定为云玩家' },
  { text: '一眼AI鉴定为检讨书' },
  { text: '一眼腱子肉鉴定为健身佬', note: '跨域' },
])
F('male', '<X>麻了', ['slot-same-domain'], [
  { text: '破防麻了' }, { text: '无语麻了' }, { text: '卷麻了' }, { text: '这题简单到我笑麻了' },
  { text: '新功能用麻了' },
])
F('daxuexi', '<X>大学习', ['slot-cross-domain'], [
  { text: '周五团建大学习' }, { text: '考证大学习' },
])
F('xingjiabi', '不是<X>买不起，而是<Y>更有性价比', ['multi-slot'], [
  { text: '不是外卖买不起，而是自己做更有性价比' },
  { text: '不是显卡买不起，而是云电脑更有性价比' },
])
F('hanjinliang', '<X>含金量还在上升', ['slot-same-domain'], [
  { text: '老将的含金量还在上升' }, { text: '这套打法的含金量还在上升' },
])
F('qidong', '<X>，启动！', ['slot-cross-domain'], [
  { text: '下班，启动！' }, { text: '春节档，启动！' }, { text: '减肥计划，启动！' },
])
F('jianding', '一眼<X>鉴定为<Y>', ['multi-slot'], [
  { text: '一眼假货鉴定为营销号' },
  { text: '一眼手绘鉴定为AI图' },
])

// ---- formula 硬负例：语法受限槽 / 字面义 / 残缺模板 ----
const FN = (family: string, entry: string, tags: string[], rows: Array<{ text: string; note?: string }>): void => {
  for (const r of rows) push({ channel: 'formula', family, entry, text: r.text, hit: false, forbid: [family], tags, note: r.note })
}
FN('male', '<X>麻了', ['slot-literal-hard'], [
  { text: '脚都麻了', note: '肢体词被槽吞进 span（ent 贪婪跨 token）——matcher 已知硬负例' },
  { text: '手写了一小时，手也麻了' },
  { text: '蹲久了脚麻了' },
  { text: '腿坐麻了，起来活动下' },
])
FN('male', '<X>麻了', ['truncated'], [
  { text: '麻了', note: '残缺：无主体槽' },
])
FN('male', '<X>麻了', ['slot-literal-hard'], [
  { text: '手麻了拿不稳筷子' },
])
FN('daxuexi', '<X>大学习', ['grammar-limit', 'literal'], [
  { text: '老年大学学习班', note: '字面"大学+学习班"，跨词桥接命中——matcher 已知硬负例' },
  { text: '大学习强国的积分还没做', note: '残缺：无前缀槽' },
])
FN('xingjiabi', '不是<X>买不起，而是<Y>更有性价比', ['structure-differs'], [
  { text: '不是不想买，而是买不起', note: '结构不同' },
  { text: '更有性价比的选择其实很多', note: '无公式结构' },
])
FN('hanjinliang', '<X>含金量还在上升', ['literal'], [
  { text: '金饰的含金量还在上升，纯度提高了', note: '字面含金量——matcher 已知硬负例' },
])
FN('qidong', '<X>，启动！', ['literal'], [
  { text: '系统启动，欢迎回来', note: '字面启动——matcher 已知硬负例' },
  { text: '程序启动了', note: '字面启动——matcher 已知硬负例' },
])
FN('daxuexi', '<X>大学习', ['grammar-limit', 'literal'], [
  { text: '大学习', note: '残缺：无前缀槽' },
  { text: '大学生的学习压力真大', note: '字面"大学+学习"，分词后不相邻' },
  { text: '本周大学习主题是网络安全', note: '字面学习活动，forbid_context 否决' },
])
FN('xingjiabi', '不是<X>买不起，而是<Y>更有性价比', ['truncated', 'literal'], [
  { text: '不是iPhone买不起', note: '残缺：只有前半句' },
  { text: '这个真不是预算问题，纯粹是更有性价比', note: '无公式结构' },
])
FN('hanjinliang', '<X>含金量还在上升', ['truncated', 'literal'], [
  { text: '含金量还在上升', note: '残缺：无主体槽' },
  { text: '金条的含金量还在上升，金价又涨了', note: '字面含金量——matcher 已知硬负例' },
])
FN('qidong', '<X>，启动！', ['truncated', 'literal-veto'], [
  { text: '启动！', note: '残缺：无主体槽' },
  { text: '发动机启动了，准备出发', note: '字面启动，forbid_context 否决' },
  { text: '汽车点火启动，很顺畅' },
])
FN('jianding', '一眼<X>鉴定为<Y>', ['truncated'], [
  { text: '一眼鉴定为云玩家', note: '残缺：缺第一槽' },
  { text: '鉴定为天才', note: '残缺：缺"一眼"与第一槽' },
])
F('jianding', '一眼<X>鉴定为<Y>', ['punctuation-bridge'], [
  { text: '看了一眼，鉴定为巧合', note: '标点被槽吸收的合法桥接' },
])

// ---- interaction 正例：成对上下文 ----
const IP = (family: string, entry: string, tags: string[], pairs: Array<[string, string]>): void => {
  for (const [prev, cur] of pairs) push({ channel: 'interaction', family, entry, text: cur, ctx: [prev, cur], hit: true, tags })
}
IP('xiaoheizi', '小黑子', ['pair-valid'], [
  ['你喜欢蔡徐坤吗', '小黑子露出鸡脚了吧'],
  ['听闻地下倍速圈都在放鸡你太美', '食不食油饼'],
  ['ikun们集合了', '小黑子露出鸡脚了吧'],
])
IP('yunnan', '我是云南的', ['pair-valid'], [
  ['我是云南的', '云南怒江的'],
  ['我是云南的', '我是云南的，云南怒江的'],
  ['我是云南的', '傈僳族的，你家哪的'],
  ['我是云南的', '我是云南的，云南怒江的，哈哈'],
])
IP('xiaoshuai', '注意看小帅', ['pair-valid'], [
  ['注意看', '这个男人叫小帅'],
  ['注意看', '这个女人叫小美'],
])

// ---- interaction 负例：缺上文 / 错上文 / 只有触发 / 只有回应 ----
const IN = (family: string, entry: string, tags: string[], rows: Array<{ text: string; ctx?: string[]; note?: string }>): void => {
  for (const r of rows) push({ channel: 'interaction', family, entry, text: r.text, ctx: r.ctx, hit: false, forbid: [family], tags, note: r.note })
}
IN('xiaoheizi', '小黑子', ['missing-context'], [
  { text: '小黑子露出鸡脚了', note: '回应句单独出现，无触发上文' },
  { text: '食不食油饼' },
])
IN('xiaoheizi', '小黑子', ['wrong-context'], [
  { text: '小黑子露出鸡脚了', ctx: ['今天天气真好', '我们去爬山吧'], note: '上文与触发无关' },
])
IN('xiaoheizi', '小黑子', ['trigger-only'], [
  { text: '我最喜欢蔡徐坤的歌', note: '只有触发话题，本句非回应句' },
  { text: '集合了', ctx: ['ikun们报道', '人都到齐了'], note: '触发在上文，但本句非回应句' },
])
IN('yunnan', '我是云南的', ['missing-context'], [
  { text: '云南怒江的风景真美', note: '接龙句单独出现' },
])
IN('yunnan', '我是云南的', ['wrong-context'], [
  { text: '云南怒江的', ctx: ['这个雪山好漂亮', '拍照技术不错'], note: '上文非报家乡触发' },
])
IN('xiaoshuai', '注意看小帅', ['missing-context'], [
  { text: '这个男人叫小帅', note: '解说句单独出现' },
])
IN('xiaoshuai', '注意看小帅', ['trigger-only'], [
  { text: '注意看，这个细节很重要', note: '触发词后无接龙回应' },
  { text: '别错过细节', ctx: ['注意看', '慢慢看'], note: '触发在上文本句非回应' },
])
IN('xiaoshuai', '注意看小帅', ['wrong-context'], [
  { text: '小帅', ctx: ['老师点名', '到'], note: '人名单独出现' },
])
IP('xiaoheizi', '小黑子', ['pair-valid'], [
  ['鸡你太美循环了一整天', '小黑子食不食油饼'],
])
IN('yunnan', '我是云南的', ['strict-response'], [
  { text: '云南大理的', ctx: ['我是云南的', '云南大理的'], note: '回应变体不在词表：宁漏不滥' },
])

// ---- conditional 正/负例：约束（forbid/require context）----
const C = (family: string, entry: string, tags: string[], hit: boolean, forbid: string[] | undefined, rows: Array<{ text: string; note?: string }>): void => {
  for (const r of rows) push({ channel: 'conditional', family, entry, text: r.text, hit, forbid, tags, note: r.note })
}
C('huida', '回答我', ['imperative-positive'], true, undefined, [
  { text: '回答我！Look in my eyes！' },
  { text: '告诉我，回答我！' },
  { text: '回答我，就现在！' },
])
C('huida', '回答我', ['question-veto', 'forbid-context'], false, ['huida'], [
  { text: '为什么不回答我？', note: '疑问用法' },
  { text: '能回答我吗' },
  { text: '请你回答我一下' },
  { text: '你倒是回答我吧' },
])
C('huida', '回答我', ['polite-veto', 'forbid-context'], false, ['huida'], [
  { text: '麻烦回答我一下，谢谢', note: '礼貌标记语境' },
  { text: '回答我一下呗' },
])
C('shangzhuo', '上桌', ['require-context-positive'], true, undefined, [
  { text: '德扑群里新人也说能上桌了' },
  { text: '这局牌他终于有资格上桌' },
  { text: '入局三年，他终于上桌了' },
])
C('shangzhuo', '上桌', ['literal-veto', 'forbid-context'], false, ['shangzhuo'], [
  { text: '把菜端上桌了，开饭', note: '餐桌字面义，forbid 否决' },
  { text: '他把行李搬上桌找充电器', note: '字面摆放，forbid 否决' },
  { text: '酒过三巡他把杯子端上桌', note: '双重 forbid 命中' },
])
C('shangzhuo', '上桌', ['require-context-missing'], false, ['shangzhuo'], [
  { text: '这下他真上桌了', note: '疑似梗义但无牌局语境词：保守不命中' },
  { text: '又有人上桌了', note: '无语境词，保守不命中' },
])

// ---- 一句多梗：主命中 + 额外命中（scorer 单独统计额外命中）----
push({ channel: 'phrase', family: 'bengbu', entry: '蚌埠住了', text: '蚌埠住了，泰裤辣！', hit: true, tags: ['multi-meme'], note: '主命中 bengbu；taiku 记额外命中' })
push({ channel: 'phrase', family: 'nazhale', entry: '那咋了', text: '考挂了，那咋了，我不到啊', hit: true, tags: ['multi-meme'], note: '主命中 nazhale；wobudao 记额外命中' })
push({ channel: 'phrase', family: 'dianzhongdian', entry: '典中典', text: '典中典，偷感很重的乐子人发言', hit: true, tags: ['multi-meme'] })
push({ channel: 'phrase', family: 'shuanq', entry: '栓Q', text: '一天班下来我栓Q了，包的', hit: true, tags: ['multi-meme'] })

// ---------------------------------------------------------------------------
// emit entries.jsonl / cases.jsonl / manifest.json
// ---------------------------------------------------------------------------

const entryRows = ENTRY_DEFS.map((e, i) => ({
  id: e.id,
  name: e.name,
  family: e.family,
  class: e.class,
  gist: e.gist,
  order: i + 1,
  matcher: e.matcher,
}))
const entryText = entryRows.map((e) => JSON.stringify(e)).join('\n') + '\n'

const caseRows = cases.map((c, i) => ({
  id: `oj-${String(i + 1).padStart(4, '0')}`,
  channel: c.channel,
  family: c.family,
  entry_ref: c.entry,
  input: c.ctx ? { text: c.text, ctx: c.ctx } : { text: c.text },
  expect: c.hit ? { hit: true, family: c.family } : { hit: false, forbid: c.forbid },
  tags: c.tags,
  ...(c.note ? { note: c.note } : {}),
}))
const caseText = caseRows.map((c) => JSON.stringify(c)).join('\n') + '\n'

const sha = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
const manifest = {
  dataset_id: 'oj-lookup-v1',
  version: 1,
  created_at: '2026-11-26',
  entry_count: entryRows.length,
  case_count: caseRows.length,
  channels: caseRows.reduce<Record<string, number>>((acc, c) => {
    acc[c.channel] = (acc[c.channel] ?? 0) + 1
    return acc
  }, {}),
  positives: caseRows.filter((c) => c.expect.hit).length,
  negatives: caseRows.filter((c) => !c.expect.hit).length,
  hashes: { 'entries.jsonl': sha(entryText), 'cases.jsonl': sha(caseText) },
  notes: [
    'OJ behavior fixture：词条+期望同行存放（行为测试，非盲测）；模型作答用无期望 prompt（scripts/oj-judge-prompt.ts）。',
    '负例的 expect.forbid 列出绝不允许命中的家族；多梗正例的额外命中由 scorer 单独统计，不进主混淆矩阵。',
    '词条示例刻意避开 candidate-judgment-v4 金标同源梗，防止两套基准串题。',
    'tag 含 slot-literal-hard 的负例是 matcher 已知硬负例（槽内词被吞进 span，窗口约束失效），scorer 分开统计。',
  ],
}

writeFileSync(join(HERE, 'entries.jsonl'), entryText)
writeFileSync(join(HERE, 'cases.jsonl'), caseText)
writeFileSync(join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`emitted ${entryRows.length} entries, ${caseRows.length} cases (pos=${manifest.positives} neg=${manifest.negatives})`)
console.log('channels:', JSON.stringify(manifest.channels))
