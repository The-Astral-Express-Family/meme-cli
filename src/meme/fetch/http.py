"""HTTP 会话：buvid 引导、真实 UA、礼貌延迟（§11：低频批量、激进缓存）。"""

from __future__ import annotations

import random
import time

import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class FetchError(Exception):
    """获取失败：code 为 B站 code 或 HTTP 状态。surf 对此降级（§6.6）。"""

    def __init__(self, code: int | str, msg: str):
        self.code = code
        self.msg = msg
        super().__init__(f"bilibili fetch error {code}: {msg}")


class BiliSession:
    def __init__(self, delay_min: float = 0.8, delay_max: float = 1.5, timeout: float = 15.0,
                 sessdata: str = ""):
        self.client = httpx.Client(
            headers={
                "User-Agent": UA,
                "Referer": "https://www.bilibili.com/",
                "Accept": "application/json",
            },
            timeout=timeout,
            follow_redirects=True,
        )
        if sessdata:
            # 登录态：解锁搜索接口与完整评论区（匿名下精选视频只露冰山一角）
            self.client.cookies.set("SESSDATA", sessdata, domain=".bilibili.com")
        self.delay_min, self.delay_max = delay_min, delay_max
        self._buvid_ready = False
        self._last_req = 0.0

    def _polite(self) -> None:
        gap = random.uniform(self.delay_min, self.delay_max)
        wait = self._last_req + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_req = time.monotonic()

    def bootstrap(self) -> None:
        """匿名 buvid 引导（部分接口无 cookie 会被风控）。失败不致命。"""
        if self._buvid_ready:
            return
        try:
            r = self.client.get("https://api.bilibili.com/x/frontend/finger/spi")
            data = r.json().get("data") or {}
            for key in ("b_3", "b_4"):
                if data.get(key):
                    self.client.cookies.set(key, data[key], domain=".bilibili.com")
            self._buvid_ready = True
        except Exception:  # noqa: BLE001 - 引导失败由后续请求自然暴露
            pass

    def get_json(self, url: str, params: dict | None = None) -> dict:
        self.bootstrap()
        self._polite()
        r = self.client.get(url, params=params)
        if r.status_code != 200:
            raise FetchError(r.status_code, f"HTTP {r.status_code} for {url}")
        body = r.json()
        code = body.get("code", -1)
        if code != 0:
            raise FetchError(code, body.get("message", "unknown"))
        return body.get("data") or {}

    def get_bytes(self, url: str) -> bytes:
        """下载二进制（评论图片 CDN）。图床防盗链依赖 Referer。"""
        self._polite()
        r = self.client.get(url, headers={"Referer": "https://www.bilibili.com/"})
        if r.status_code != 200:
            raise FetchError(r.status_code, f"HTTP {r.status_code} for {url}")
        return r.content

    def close(self) -> None:
        self.client.close()
