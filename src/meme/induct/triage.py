"""triage 分流（§7.2）：归纳成本经济学。

词梗占新梗的多数但几乎不花钱——这个分流本身是归纳成本控制的主力。
"""

from __future__ import annotations

from dataclasses import dataclass

from ..models import Candidate


@dataclass
class TriagePlan:
    path: str  # zero_word | card_small | derived | flagship
    model_tier: str  # small | flagship


def triage(target: Candidate | str, kind_guess: str | None = None) -> TriagePlan:
    kind = kind_guess or (target.kind_guess if isinstance(target, Candidate) else "word")
    if kind == "word":
        return TriagePlan("zero_word", "small")
    if kind == "event":
        return TriagePlan("card_small", "small")
    if kind == "derived":
        return TriagePlan("derived", "small")
    return TriagePlan("flagship", "flagship")  # formula / format / interaction


def model_for(plan: TriagePlan, cfg) -> str:
    return cfg.small_model if plan.model_tier == "small" else cfg.model
