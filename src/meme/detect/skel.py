"""骨架化（D5）：token 归一化后的模板形状，发现与匹配的共同基础。

归一化：数字→<num>、URL/BV号→<url>/<ent>、[表情]→<emo>、@用户→<at>。
公式梗发现的“单槽掩码变体”法：对每条文本，除全归一化骨架外，另将每个
连续实词串逐一替换为 <ent> 生成变体——可变实体位置因此在统计上显形，
“一眼原神鉴定为云玩家”与“一眼华为鉴定为遥遥领先”坍缩到同一骨架。
"""

from __future__ import annotations

import hashlib
import re

import jieba

jieba.setLogLevel(60)  # 关闭构建前缀字典的日志噪音

RE_SUB = re.compile(
    r"https?://\S+|www\.\S+|b23\.tv/\S+|bilibili\.com/\S+"
    r"|\bBV[0-9A-Za-z]{9,11}\b"
    r"|\[[^\[\]\s]{1,12}\]"
    r"|@[^\s@：:，,。！？~]{1,30}"
)
RE_NUMTOK = re.compile(r"^[0-9０-９]+([.,，][0-9０-９]+)*[%％]?$")
RE_CJK = re.compile(r"[\u4e00-\u9fff]")
RE_LATIN = re.compile(r"^[A-Za-z]{3,}$")
# 楼中楼 UI 前缀（"回复 @某人 ："）是界面残留不是评论内容，剥离防其污染骨架/短语
RE_REPLY_PREFIX = re.compile(r"^\s*回复\s*@[^\s：:，,。！？]{1,30}\s*[:：]\s*")

SLOT_URL, SLOT_ENT, SLOT_EMO, SLOT_AT, SLOT_NUM = "<url>", "<ent>", "<emo>", "<at>", "<num>"

# 掩码时保留的虚词/功能词（不作为实体槽候选）；retrieve/fts 查询侧也用它降噪。
# 注意：此表只服务"槽位掩码"语义，禁止用作短语通道的首/尾词过滤——
# 那会系统性误杀功能词开头结尾的句式梗（我记下了/乐子人/属于是曾全部被杀）。
FUNC_WORDS = {
    "的", "了", "是", "我", "你", "他", "她", "它", "咱", "们", "也", "都",
    "就", "和", "在", "有", "不", "没", "很", "太", "真", "啊", "吧", "吗",
    "呢", "哦", "哈", "呀", "着", "过", "与", "及", "或", "但", "因为", "所以",
    "如果", "这", "那", "被", "把", "让", "给", "对", "从", "向", "到", "说",
    "看", "来", "去", "个", "么", "什么", "怎么", "还是", "而且", "然后", "一个",
    # 实战 surf 分诊沉淀（round 4-14）：单/双字功能词是候选噪音主力
    "还", "好", "能", "人", "会", "做", "才", "又", "没有", "大", "里", "完",
    "多", "想", "已经", "这么", "那么", "这样", "那样", "真是", "真的", "可能",
    "应该", "一定", "其实", "确实", "现在", "时候", "知道", "觉得", "出来",
    "开始", "终于", "其他", "这些", "那些", "其中", "而已", "比如", "如果",
    "只是", "就是", "不是", "要是", "要是说", "居然", "竟然", "依然", "仍然",
    "突然", "忽然", "本来", "原来", "果然", "竟然", "首先", "然后", "最后",
    "第一", "第二", "反正", "难道", "毕竟", "居然", "稍微", "有点", "有些",
    "非常", "特别", "十分", "比较", "更加", "越来越",
    "以为", "好像", "不过", "这里", "一次", "需要", "是不是", "很多", "起来",
    "一样", "一点", "这是", "还有", "找到", "不了", "一下", "自己", "有人",
}

PUNCT = "，。！？；：、…—～·“”‘’()（）<>《》【】[].!?;:\"' \t\n"

# 功能字：骨架通道里并入后随 token（吸收 jieba 对"为云/为遥遥"的切分漂移）
FUNC_CHARS = "为了的是在就都也还又再更最太真和跟对被把让向从到与及或"


def _skeleton_tokens(tokens: list[str]) -> list[str]:
    """骨架通道专用的 token 整备：len≤2 且以功能字开头的 token 并入后随 token。

    使"鉴定/为云/玩家"与"鉴定/为/遥遥领先"整备为相同的"鉴定为云|玩家"与
    "鉴定为|遥遥领先"形状后，槽位掩码能跨用例坍缩。
    """
    out: list[str] = []
    pending = ""
    for t in tokens:
        if t.startswith("<"):
            out.append(pending + t)
            pending = ""
            continue
        if len(t) <= 2 and t and t[0] in FUNC_CHARS:
            pending += t
            continue
        out.append(pending + t)
        pending = ""
    if pending:
        if out:
            out[-1] += pending
        else:
            out.append(pending)
    return out


def _slot_for(match: re.Match) -> str:
    s = match.group(0)
    if s.startswith(("http", "www", "b23.tv", "bilibili.com")):
        return SLOT_URL
    if s.startswith("BV") or RE_LATIN.match(s):
        return SLOT_ENT
    if s.startswith("["):
        return SLOT_EMO
    return SLOT_AT


def _pre_replace(text: str) -> str:
    """表情/URL/@/BV号 → 槽位占位（供短语通道复用，防表情名泄漏成词）。"""
    text = RE_SUB.sub(_slot_for, text)
    return text


def normalize_spanned(text: str) -> list[tuple[str, int, int]]:
    """归一化 token 序列，附原文本字符偏移 (token, start, end)。"""
    out: list[tuple[str, int, int]] = []
    shift = 0
    prefix = RE_REPLY_PREFIX.match(text)
    if prefix:
        shift = prefix.end()  # UI 前缀剥离：偏移平移保持 span 指向原文
        text = text[shift:]
    pos = 0
    for m in RE_SUB.finditer(text):
        seg = text[pos : m.start()]
        _emit_segment(out, seg, pos + shift)
        slot = _slot_for(m)
        out.append((slot, m.start() + shift, m.end() + shift))
        pos = m.end()
    _emit_segment(out, text[pos:], pos + shift)
    return out


def _emit_segment(out: list[tuple[str, int, int]], seg: str, base: int) -> None:
    if not seg:
        return
    off = 0
    for tok in jieba.lcut(seg):
        start, end = off, off + len(tok)
        off = end
        stripped = tok.strip()
        if not stripped:
            continue
        if RE_NUMTOK.match(stripped):
            out.append((SLOT_NUM, base + start, base + end))
        else:
            out.append((stripped, base + start, base + end))


def normalize(text: str) -> list[str]:
    """文本 → 归一化 token 序列（字面词 + 槽位标记 + 结构标点）。"""
    return [t for t, _, _ in normalize_spanned(text)]


def skeleton_hash(skel: str) -> str:
    return hashlib.sha1(skel.encode("utf-8")).hexdigest()[:16]


def _is_maskable(tok: str) -> bool:
    """实词槽候选：含 CJK 且非虚词，或显式 <num>/<ent> 槽位。"""
    if tok in (SLOT_NUM, SLOT_ENT):
        return True
    if tok in FUNC_WORDS or tok in PUNCT:
        return False
    return bool(RE_CJK.search(tok))


def skeleton_variants(text: str) -> list[str]:
    """全骨架 + 掩码变体（每条文本内去重）。

    掩码单元 = 单个实词 token，并生成单点与任意成对掩码——两槽公式梗
    （"一眼X鉴定为Y"）需要对两个实体槽同时掩码才能跨用例坍缩。
    变体仅保留剩余字面 token ≥2 的（否则退化为纯词候选，由短语通道负责）。

    候选资格不在此层：同一文本的近重复变体（复制粘贴家族）由信号层的
    "≥2 种不同文本复现"门拦截——变体只是坍缩路径，不是候选本身。
    """
    tokens = _skeleton_tokens(normalize(text))
    full = " ".join(tokens)
    seen = {full}
    variants = [full]
    maskable = [i for i, t in enumerate(tokens) if _is_maskable(t)]

    def emit(idxs: tuple[int, ...]) -> None:
        drop = set(idxs)
        masked = [SLOT_ENT if k in drop else tokens[k] for k in range(len(tokens))]
        literals = sum(1 for t in masked if t not in PUNCT and not t.startswith("<"))
        if literals < 2:
            return
        s = " ".join(masked)
        if s not in seen:
            seen.add(s)
            variants.append(s)

    for i in maskable:
        emit((i,))
    # 成对掩码（两槽公式）；长评论只取前 8 个可掩码位控制组合数
    m = maskable[:8]
    for a in range(len(m)):
        for b in range(a + 1, len(m)):
            emit((m[a], m[b]))
    return variants[:24]
