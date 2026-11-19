"""短语通道：jieba n-gram 抽取（word 类候选的主信号）。

结构性判别（不含任何"已知梗"知识——判别器不得预知梗词，否则丧失发现能力）：
- 表情/URL/@ 先切段、标点/空白再切段：gram 不跨标点（"太酷辣，直接"拼不出"太酷辣直接"）；
- gram 必须含至少一个实词/词典外成分（纯功能组合直接排除；词典外新词 jieba 标
  'x' 视为内容——新梗恰恰在词典外）；
- 纯数字串是刷屏噪音。

首/尾 FUNC_WORDS 词表规则已废除：该表在实战中膨胀到 146 条（83 条多字词），
把「我记下了/那咋了/太抽象了/乐子人/属于是/你说得对」这类功能词开头结尾的
句式热梗系统性误杀——而功能词头僵尸组合（"这里有人"）与句式梗在 gram 层面
无结构差异，只能靠用法证据区分：signals 层的"独立成评率"闸门
（FUNC_HEAD_RATE）按用例拦截，不按词表拉黑。
"""

from __future__ import annotations

import re

import jieba

import jieba.posseg as pseg

from .skel import PUNCT, RE_REPLY_PREFIX, RE_SUB

RE_HAS_CONTENT = re.compile(r"[\u4e00-\u9fffA-Za-z0-9]")
SEG_SEP = "\x01"
# 标点/空白切段：gram 不得跨越任何标点（RE_SUB 槽位段早于标点切分，槽名不经过分词器）
RE_PUNCT_SPLIT = re.compile(f"[{re.escape(PUNCT)}]")

# 纯功能词性（北大词性标记）：gram 只要有任一实词/未知词成分即可入选（发现优先）。
# 词典外新词 jieba 标 'x'——新梗恰恰是词典外的，'x' 视为内容成分。
# 'm'（量词）不在此列：jieba 把"一眼"标 m，而它是活跃梗词（一眼丁真）；
# 纯数量组合由 FUNC_WORDS/GENERIC 与 df 闸门兜住。
FUNCTION_TAGS = set("dpcuyermqtwokeh") - {"m"}

jieba.setLogLevel(60)
try:
    pseg.setLogLevel(60)
except AttributeError:
    pass


def _is_content(tag: str) -> bool:
    return tag not in FUNCTION_TAGS

RE_PURE_DIGIT = re.compile(r"^[0-9０-９]+$")


def _keep_token(tok: str) -> bool:
    """保留一切非标点 token（含虚词——gram 级内容性检查再管）；纯数字串是刷屏噪音。"""
    if not tok or tok in PUNCT:
        return False
    if RE_PURE_DIGIT.match(tok):
        return False
    return bool(RE_HAS_CONTENT.search(tok))


def phrases(text: str, max_tokens: int = 5, max_chars: int = 14) -> list[str]:
    """产出去重的候选短语（1..5 token，总字长 ≤ max_chars）。"""
    text = RE_REPLY_PREFIX.sub("", text)  # 楼中楼 UI 前缀不是评论内容
    plain = RE_SUB.sub(f" {SEG_SEP} ", text)
    out: list[str] = []
    seen: set[str] = set()
    for seg in plain.split(SEG_SEP):
        for chunk in RE_PUNCT_SPLIT.split(seg):
            if not chunk.strip():
                continue
            pairs = [p for p in pseg.lcut(chunk) if _keep_token(p.word)]
            tags = {w: t for w, t in pairs}
            tokens = [w for w, _ in pairs]
            for n in range(1, max_tokens + 1):
                for i in range(len(tokens) - n + 1):
                    gram = tokens[i : i + n]
                    if not any(_is_content(tags.get(t, "x")) for t in gram):
                        continue  # 纯功能组合
                    s = "".join(gram)
                    if len(s) > max_chars or s in seen:
                        continue
                    seen.add(s)
                    out.append(s)
    return out
