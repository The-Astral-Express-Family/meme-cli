"""DSH wire 客户端：SSE 解析、凭证缺失、可重试错误分类（不打真网）。"""

import json

import pytest

from meme.config import InductionConfig
from meme.errors import MemeError
from meme.induct.llm import WireLLM


def _sse(events: list[dict]) -> bytes:
    out = []
    for ev in events:
        out.append(f"event: {ev['type']}")
        out.append("data: " + json.dumps(ev, ensure_ascii=False))
        out.append("")
    return ("\n".join(out)).encode()


def _mock(monkeypatch, status=200, body: bytes = b"", headers=None):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers=headers or {},
                              request=request)

    transport = httpx.MockTransport(handler)
    orig = httpx.Client

    def patched(*a, **kw):
        kw["transport"] = transport
        return orig(*a, **kw)

    monkeypatch.setattr(httpx, "Client", patched)


def _cfg(monkeypatch, key="k-test"):
    monkeypatch.setenv("DEEPSEEK_API_KEY", key)
    return InductionConfig()


def test_sse_text_and_usage(monkeypatch):
    body = _sse([
        {"type": "message_start", "message": {"usage": {"input_tokens": 25}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "你好"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "，世界"}},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
         "usage": {"output_tokens": 7}},
        {"type": "message_stop"},
    ])
    _mock(monkeypatch, body=body)
    llm = WireLLM(_cfg(monkeypatch))
    res = llm.complete("sys", "user", retries=0)
    assert res.text == "你好，世界"
    assert res.usage == {"input_tokens": 25, "output_tokens": 7}
    assert res.stop_reason == "end_turn"


def test_body_shape_matches_dsh_adapter(monkeypatch):
    import httpx

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["json"] = json.loads(request.content)
        return httpx.Response(200, content=_sse([
            {"type": "message_start", "message": {"usage": {"input_tokens": 1}}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}},
            {"type": "message_delta", "delta": {}, "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ]), request=request)

    monkeypatch.setenv("DEEPSEEK_API_KEY", "k-shape")
    orig = httpx.Client
    monkeypatch.setattr(httpx, "Client",
                        lambda *a, **kw: orig(*a, **{**kw, "transport": httpx.MockTransport(handler)}))
    llm = WireLLM(InductionConfig())
    llm.complete("sys", "user", retries=0)
    assert captured["headers"]["x-api-key"] == "k-shape"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    body = captured["json"]
    assert body["stream"] is True
    assert body["thinking"] == {"type": "enabled"}
    assert body["output_config"] == {"effort": "low"}
    assert body["messages"][0]["role"] == "user"


def test_missing_credential_raises_typed(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    llm = WireLLM(InductionConfig())
    with pytest.raises(MemeError) as ei:
        llm.complete("s", "u", retries=0)
    assert ei.value.code == "MEME_LLM_NO_CREDENTIAL"


def test_auth_error_not_retried(monkeypatch):
    _mock(monkeypatch, status=401)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k-bad")
    llm = WireLLM(InductionConfig())
    with pytest.raises(MemeError) as ei:
        llm.complete("s", "u", retries=2)
    assert ei.value.code == "MEME_LLM_AUTH"
