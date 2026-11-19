"""DSH wire 客户端：按 deepseek-harness 官方适配器的 Messages 协议直连（O1 落地）。

端点：{DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}/v1/messages
凭证：x-api-key: $DEEPSEEK_API_KEY（与 DSH 生态同一环境变量约定）
模型 ID 直通（deepseek-flash / deepseek-v4-pro / 新模型无需登记）。
DSH 核心不做重试——本工具无外层 agent，自行做有界退避重试。
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field

import httpx

from .. import __version__
from ..config import InductionConfig
from ..errors import MemeError, llm_call_failed, llm_no_credential

ANTHROPIC_VERSION = "2023-06-01"


@dataclass
class LLMResult:
    text: str
    model: str
    usage: dict = field(default_factory=dict)  # input_tokens / output_tokens
    stop_reason: str | None = None


class WireLLM:
    def __init__(self, cfg: InductionConfig):
        self.cfg = cfg
        self.base = cfg.base_url().rstrip("/")
        if not self.base.endswith("/v1"):
            self.base += "/v1"

    def _headers(self) -> dict:
        key = self.cfg.api_key()
        if not key:
            raise llm_no_credential()
        return {
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            "user-agent": f"meme/{__version__} (dsh-wire)",
        }

    def complete(
        self,
        system: str,
        user: str,
        model: str | None = None,
        effort: str | None = None,
        max_tokens: int | None = None,
        retries: int = 2,
    ) -> LLMResult:
        model = model or self.cfg.model
        effort = effort or self.cfg.reasoning_effort
        body: dict = {
            "model": model,
            "stream": True,
            "max_tokens": max_tokens or self.cfg.max_tokens,
            "messages": [{"role": "user", "content": [{"type": "text", "text": user}]}],
        }
        if system:
            body["system"] = system
        if effort == "off":
            body["thinking"] = {"type": "disabled"}
        else:
            body["thinking"] = {"type": "enabled"}
            body["output_config"] = {"effort": effort}

        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return self._stream_once(body, model)
            except MemeError:
                raise
            except (_Retryable, httpx.HTTPError) as e:
                # 429/5xx/overloaded/限流事件 与 连接层传输错误 同等对待：有界退避重试
                last_err = e
                if attempt >= retries:
                    break  # 末次失败不再白等退避
                wait = min(2.0**attempt * 1.5, 12.0)
                print(
                    f"meme: llm: {e}（{wait:.0f}s 后重试 {attempt + 1}/{retries}）",
                    file=sys.stderr,
                )
                time.sleep(wait)
        raise llm_call_failed(f"重试耗尽：{last_err}")

    def _stream_once(self, body: dict, model: str) -> LLMResult:
        chunks: list[str] = []
        usage: dict = {}
        stop_reason: str | None = None
        with httpx.Client(timeout=httpx.Timeout(30.0, read=300.0)) as client:
            with client.stream(
                "POST", f"{self.base}/messages", headers=self._headers(), json=body
            ) as resp:
                if resp.status_code in (401, 403):
                    raise MemeError("MEME_LLM_AUTH", f"模型凭证被拒绝（HTTP {resp.status_code}）",
                                    suggestion="检查 DEEPSEEK_API_KEY 是否有效。")
                if resp.status_code == 429:
                    raise _Retryable("RATE_LIMIT")
                if resp.status_code >= 500:
                    raise _Retryable(f"HTTP {resp.status_code}")
                if resp.status_code != 200:
                    detail = resp.read()[:300].decode("utf-8", "replace")
                    raise llm_call_failed(f"HTTP {resp.status_code}: {detail}")
                for line in resp.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    et = ev.get("type")
                    if et == "content_block_delta":
                        delta = ev.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            chunks.append(delta.get("text", ""))
                    elif et == "message_start":
                        u = (ev.get("message") or {}).get("usage") or {}
                        usage["input_tokens"] = u.get("input_tokens", 0)
                    elif et == "message_delta":
                        u = ev.get("usage") or {}
                        usage["output_tokens"] = u.get("output_tokens", 0)
                        stop_reason = (ev.get("delta") or {}).get("stop_reason")
                    elif et == "error":
                        err = ev.get("error") or {}
                        if err.get("type") in ("overloaded_error", "api_error", "rate_limit_error"):
                            raise _Retryable(err.get("type", "api_error"))
                        raise llm_call_failed(f"{err.get('type')}: {err.get('message')}")
        if not chunks:
            # usage 非空但无文本：多半是思考阶段烧尽 max_tokens——重试无意义，报错引导调参
            raise llm_call_failed(
                f"空文本响应（stop_reason={stop_reason}）：max_tokens 可能被思考耗尽，"
                "可调大 [induction] max_tokens"
            )
        return LLMResult("".join(chunks), model, usage, stop_reason)


class _Retryable(Exception):
    """可重试的临时故障（限流/过载/5xx）。"""
