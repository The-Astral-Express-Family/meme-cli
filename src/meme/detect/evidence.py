"""梗证据评分：候选的"梗性"统计特征（零 LLM）。

设计动机（实战教训）：泛用词与真梗在"跨视频计数"上无法区分（"不行"dv=14，
"难绷"dv=6），手工黑名单打地鼠三轮仍失守。梗的本质是**被复读的表达**——
泛用词出现在千变万化的句子里，真梗的用例文本/形状高度重复。四个可计算特征：

- copy_pairs   跨视频完全重复的归一化文本对数（整句复读："警钟长鸣"×3）
- skel_top_share 最常见骨架占非平凡骨架的比例（模板化用："赢麻了/亏麻了/输麻了"
                 坍缩为 "<ent>麻了"）——注意这是"用例收敛于一个形状"，与
                 候选发现层的"形状跨文本复现"互为表里
- standalone_rate 独立成评率（"典。"式整评就是梗）
- usage_text_share 重复文本占比（同文本多次出现，含同视频）

meme_score 权重经真实湖回放校准（exp/replay.py），泛用词 ≈0，真梗 ≥1。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

from .skel import _skeleton_tokens, normalize

# 复读判定的文本归一化：去槽位/标点/空白，仅保留内容字符
_STRIP = set("，。！？；：、…—～·“”‘’()（）<>《》【】[].!?;:\"' \t\n\x00")


@lru_cache(maxsize=65536)
def norm_text(text: str) -> str:
    """复读比较键：槽位占位归一 + 去标点空白。"[doge]好活" 与 "好活[doge]" 同键。"""
    toks = [t for t in normalize(text) if t not in _STRIP and not t.startswith("<")]
    return "".join(toks).lower()


@lru_cache(maxsize=65536)
def skeleton_of(text: str) -> str:
    """用例骨架（与发现层同一整备管道），供坍缩度统计。"""
    return " ".join(_skeleton_tokens(normalize(text)))


@dataclass
class MemeFeatures:
    copy_pairs: int = 0
    skel_top_share: float = 0.0
    standalone_rate: float = 0.0
    usage_text_share: float = 0.0
    n_usages: int = 0

    @property
    def meme_score(self) -> float:
        """梗性综合分。copy_pairs 是最强信号（整句复读跨视频），
        模板坍缩次之，独立成评最弱（泛用客套词也能独立成评）。"""
        return (
            2.0 * min(self.copy_pairs, 3)
            + 1.0 * self.skel_top_share
            + 0.5 * self.usage_text_share
            + 0.5 * self.standalone_rate
        )

    def to_dict(self) -> dict:
        return {
            "copy_pairs": self.copy_pairs,
            "skel_top_share": round(self.skel_top_share, 3),
            "standalone_rate": round(self.standalone_rate, 3),
            "usage_text_share": round(self.usage_text_share, 3),
            "n_usages": self.n_usages,
            "meme_score": round(self.meme_score, 3),
        }


def meme_features(usages, head: str = "") -> MemeFeatures:
    """从用例样本计算梗特征。usages: list[UsageSample]（或 duck-typed 同字段对象）。

    head：候选词头。复读证据只算"该表达近似独立成评"的复读——否则复读长句的
    每个组成 gram（"干净"）都会继承整句的 copy_pairs，泛用词被复读句污染。
    """
    texts = [u.text for u in usages if u and u.text and u.text.strip()]
    if not texts:
        return MemeFeatures()
    aids = [u.aid for u in usages if u and u.text and u.text.strip()]
    pairs = list(zip(texts, aids))

    # 独立用例：归一化文本 ≈ head 本身（复读的正是这个表达，不是含它的长句）。
    # 窗口 ±1：±2 会让"干货"继承"干货满满"整句复读的证据（实战抓获）
    head_len = len(norm_text(head)) if head else None
    if head_len:
        keep = [(t, aid) for t, aid in pairs if abs(len(norm_text(t)) - head_len) <= 1]
    else:
        keep = pairs
    normed_keep = [norm_text(t) for t, _ in keep]

    # 跨视频重复文本对：同一归一化键出现在 ≥2 个不同视频 → 该键贡献 (n-1) 对
    by_key: dict[str, set[int]] = {}
    for (t, aid), k in zip(keep, normed_keep):
        if k:
            by_key.setdefault(k, set()).add(aid)
    copy_pairs = sum(max(len(v) - 1, 0) for k, v in by_key.items() if len(v) >= 2 and len(k) >= 2)

    # 骨架坍缩：非平凡骨架（≥2 token 且含字面）中的众数占比
    skels = [s for s in (skeleton_of(t) for t in texts) if s.count(" ") >= 1]
    skel_top_share = 0.0
    if skels:
        top = Counter(skels).most_common(1)[0][1]
        skel_top_share = top / len(skels)

    # 独立成评率：整评长度 ≈ 短语长度（沿用发现层的判定）
    standalone = sum(1 for t in texts if len(t.strip()) <= 6)
    # 文本重复占比：非单例文本的次数占比（独立用例口径）
    cnt = Counter(k for k in normed_keep if k)
    dup_n = sum(c for c in cnt.values() if c >= 2)
    return MemeFeatures(
        copy_pairs=copy_pairs,
        skel_top_share=skel_top_share,
        standalone_rate=standalone / len(texts),
        usage_text_share=dup_n / len(texts),
        n_usages=len(texts),
    )
