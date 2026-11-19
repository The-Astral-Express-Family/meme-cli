"""领域模型（pydantic v2）。字段为设计文档 §4 概念级示意的落地形态。"""

from __future__ import annotations

import json
import time
import warnings
from typing import Literal

from pydantic import BaseModel, Field

# card.register 是设计文档 §4.3 的字段名；遮蔽 BaseModel 属性的告警无害
warnings.filterwarnings("ignore", message='Field name "register"')

Kind = Literal["word", "formula", "format", "interaction", "event", "derived"]
MemeState = Literal["observing", "active", "fading", "tombstone"]
CandState = Literal["pending", "triggered", "inducted", "rejected"]
SlotName = Literal["<num>", "<ent>", "<emo>", "<url>", "<any>"]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


class Card(BaseModel):
    """注入 LLM 的默认知识形态（§10），约 100 token。"""

    gist: str
    usage: list[str] = Field(default_factory=list)
    taboo: str | None = None
    register: str | None = None
    aggression: str | None = None


class UsageSample(BaseModel):
    text: str
    aid: int = 0
    rpid: int = 0
    root: int = 0
    parent: int = 0
    mid: int = 0
    ctime: int = 0
    chain: bool = False  # 楼中楼短消息拼接（一人一字接龙）合成文本


class Spread(BaseModel):
    videos: int = 0
    ups: int = 0
    first: str | None = None
    last: str | None = None


class BurstInfo(BaseModel):
    z: float | None = None
    baseline_days: int = 90


class RelatedRef(BaseModel):
    id: str
    type: Literal["same_form", "derived", "related"]
    score: float


class Evidence(BaseModel):
    usages: list[UsageSample] = Field(default_factory=list)
    spread: Spread = Field(default_factory=Spread)
    burst: BurstInfo = Field(default_factory=BurstInfo)


class Constraints(BaseModel):
    """word/formula 类匹配的位置/语境约束 DSL（§8.1）。

    standalone: 须单独成句（前后为标点/边界/胶水字；与 sentence_final 为 OR 语义，启用其一组即可满足）
    sentence_final: 须位于句尾（其后为句末标点或串尾）
    forbid_inner: 禁止作为更长词语的一部分（按 jieba 分词判定，胶水字邻接不算）
    forbid_context: 命中span 前后 N 字内出现这些词则否决
    require_context: 必须至少出现其一（同窗口）
    """

    standalone: bool = False
    sentence_final: bool = False
    forbid_inner: bool = False  # 命中不得是更长 jieba token 的一部分（胶水字邻接不算）
    forbid_context: list[str] = Field(default_factory=list)
    require_context: list[str] = Field(default_factory=list)
    context_window: int = 12


class PatternSpec(BaseModel):
    """归纳器产出的匹配模式描述，编译后进 matcher。

    kind=lex: terms 为字面词表（word/event_phrase 亦走 lex 层）
    kind=skeleton: tokens 为字面/槽位序列，槽位 ∈ <num> <ent> <emo> <url> <any>
    kind=interaction: trigger/response 各为一个 lex/skeleton 子模式
    """

    kind: Literal["lex", "skeleton", "interaction"]
    terms: list[str] = Field(default_factory=list)
    tokens: list[str] = Field(default_factory=list)
    trigger_terms: list[str] = Field(default_factory=list)
    trigger_tokens: list[str] = Field(default_factory=list)
    response_terms: list[str] = Field(default_factory=list)
    response_tokens: list[str] = Field(default_factory=list)


class MatcherSpec(BaseModel):
    patterns: list[PatternSpec] = Field(default_factory=list)
    constraints: Constraints = Field(default_factory=Constraints)


class Lineage(BaseModel):
    parent: str | None = None  # 父词条 id
    mutation: str | None = None  # 变异点描述


class Birth(BaseModel):
    circa: str | None = None  # "2021" 或 "2023-08"


class DriftEntry(BaseModel):
    period: str  # "2021" / "2024Q2"
    change: str
    evidence: str | None = None  # cid 或说明


class MemeStats(BaseModel):
    wild_freq_30d: float = 0.0  # 近 30 天日均命中
    peak_freq: float = 0.0
    last_seen: str | None = None
    last_matched_round: int = 0


class Meme(BaseModel):
    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    class_: Kind = Field(alias="class", default="word")
    lineage: Lineage = Field(default_factory=Lineage)
    platform: list[str] = Field(default_factory=lambda: ["bilibili"])
    state: MemeState = "observing"
    birth: Birth = Field(default_factory=Birth)
    matcher: MatcherSpec | None = None
    card: Card
    examples: list[str] = Field(default_factory=list)
    drift: list[DriftEntry] = Field(default_factory=list)
    stats: MemeStats = Field(default_factory=MemeStats)
    wild_rounds: list[int] = Field(default_factory=list)
    # 复活确认流计数：0 正常 / 1 首次 show 见最小卡 / 2 已确认过一次（再 show 恢复完整卡）。
    # 必须 int 而非 bool——bool 会把 2 塌缩成 True，二次确认永远走不到（实战 bug）。
    revived_pending: int = 0
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)

    model_config = {"populate_by_name": True}

    @property
    def terms(self) -> list[str]:
        return [self.name, *self.aliases]


class Candidate(BaseModel):
    cid: str
    head: str
    kind_guess: Kind = "word"
    # image=图梗（pHash 簇）；chain=一字接龙（楼中楼平级拼字）；copy=整句复读（跨视频重复文本）
    channel: Literal["phrase", "skeleton", "image", "chain", "copy"] = "phrase"
    state: CandState = "pending"
    z_score: float | None = None
    distinct_videos: int = 0
    distinct_ups: int = 0
    first_seen: str = Field(default_factory=now_iso)
    last_seen: str = Field(default_factory=now_iso)
    surfs_seen: int = 0
    last_round: int = 0
    evidence_usages: list[UsageSample] = Field(default_factory=list)
    related: list[RelatedRef] = Field(default_factory=list)
    provenance: str = "bilibili"
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class AuditRecord(BaseModel):
    action: str
    source: Literal["surf", "lookup", "note", "add", "edit", "system"] = "system"
    payload: dict = Field(default_factory=dict)
    ts: str = Field(default_factory=now_iso)


# ---------- 归纳器输出（LLM YAML 围栏的解析目标） ----------


class InductionOutput(BaseModel):
    """归纳器一次调用必须产出的结构（§7.3）。"""

    name: str
    aliases: list[str] = Field(default_factory=list)
    class_: Kind = Field(alias="class")
    birth_circa: str | None = None
    card: Card
    examples: list[str] = Field(default_factory=list)
    matcher: MatcherSpec | None = None
    lineage_parent: str | None = None
    lineage_mutation: str | None = None
    notes: str | None = None  # 归纳器自述（不确定点，进 audit 不进 card）

    model_config = {"populate_by_name": True}


# ---------- JSON 序列化辅助 ----------


def _pydantic_default(o):
    if isinstance(o, BaseModel):
        return o.model_dump(by_alias=True)
    raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")


def j(obj: BaseModel | list | dict | None) -> str:
    if obj is None:
        return "null"
    if isinstance(obj, BaseModel):
        return obj.model_dump_json(by_alias=True)
    return json.dumps(obj, ensure_ascii=False, default=_pydantic_default)


def mj(raw: str | None, default):
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default
