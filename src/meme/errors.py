"""类型化错误：稳定 SCREAMING_SNAKE 错误码 + 下一步行动引导（设计文档 §5.2 第 3 条、§10.3）。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class MemeError(Exception):
    """所有可预期失败的类型化载体。报错本身在教 LLM 下一步做什么。"""

    code: str  # 稳定错误码，如 MEME_NOT_FOUND
    message: str  # 人类可读摘要（中文）
    suggestion: str | None = None  # 建议动作
    nearby: list[dict] = field(default_factory=list)  # 近似词条 [{id,name,score}]
    exit_code: int = 1  # 工具失败统一 1（用法错误 2 由 click 处理）

    def to_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        if self.suggestion:
            d["suggestion"] = self.suggestion
        if self.nearby:
            d["nearby"] = self.nearby
        return d


def not_found(query: str, nearby: list[dict]) -> MemeError:
    return MemeError(
        code="MEME_NOT_FOUND",
        message=f"未找到词条：{query}",
        nearby=nearby[:3],
        suggestion="可先 `meme add \"<文本>\" --ctx <出处>` 记一笔（observing 入库），或 `meme note add` 记录疑点。",
    )


def candidate_not_found(cid: str, nearby: list[dict] | None = None) -> MemeError:
    return MemeError(
        code="CANDIDATE_NOT_FOUND",
        message=f"未找到候选：{cid}",
        nearby=nearby or [],
        suggestion="用 `meme surf --more` 翻看候选，或 `meme search` 核对是否已有同形词条。",
    )


def llm_no_credential(hint: str = "") -> MemeError:
    return MemeError(
        code="MEME_LLM_NO_CREDENTIAL",
        message="归纳器缺少模型凭证：环境变量 DEEPSEEK_API_KEY 未设置"
        + (f"（{hint}）" if hint else ""),
        suggestion="设置 DEEPSEEK_API_KEY（或在 meme.toml [induction] 配置 api_key_env 指向的变量）后重试；read path（lookup/search/show）不需要凭证。",
    )


def llm_call_failed(detail: str) -> MemeError:
    return MemeError(
        code="MEME_LLM_CALL_FAILED",
        message=f"归纳器调用失败：{detail}",
        suggestion="稍后重试 `meme add`；候选证据已保留在队列中，不会丢失。也可用 `meme note add` 先记一笔。",
    )


def budget_exceeded(queued: int) -> MemeError:
    return MemeError(
        code="MEME_BUDGET_EXCEEDED",
        message=f"归纳日预算已用尽，本次触发已进入排队（当前排队 {queued} 条）。",
        suggestion="等待下一轮 surf 自动处理排队候选，或在 meme.toml [induction] daily_call_budget 调大预算。",
    )


def db_foreign(path: str) -> MemeError:
    return MemeError(
        code="MEME_DB_FOREIGN",
        message=f"数据库文件不是 meme 库或版本过新：{path}",
        suggestion="检查 --db 路径是否指向了 meme 创建的库文件。",
    )


def invalid_matcher(detail: str) -> MemeError:
    return MemeError(
        code="MEME_MATCHER_INVALID",
        message=f"匹配器描述无法编译：{detail}",
        suggestion="该词条将以纯向量模式入库（matcher=null），仍可被 search 检索。",
    )
