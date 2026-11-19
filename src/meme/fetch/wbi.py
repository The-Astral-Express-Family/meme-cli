"""wbi 签名：mixin key 重排 + md5（B站 web 接口通行证）。"""

from __future__ import annotations

import hashlib
import time
from urllib.parse import urlencode

MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


class WbiSigner:
    """懒加载 nav 的 wbi_img 密钥并签名参数。"""

    def __init__(self, session):
        self.session = session
        self._mixin: str | None = None

    def _load(self) -> None:
        if self._mixin is not None:
            return
        data = self.session.get_json("https://api.bilibili.com/x/web-interface/nav")
        img = (data.get("wbi_img") or {}).get("img_url", "")
        sub = (data.get("wbi_img") or {}).get("sub_url", "")
        raw = img.split("/")[-1].split(".")[0] + sub.split("/")[-1].split(".")[0]
        self._mixin = "".join(raw[i] for i in MIXIN_TAB if i < len(raw))[:32]

    def sign(self, params: dict) -> dict:
        self._load()
        params = {k: v for k, v in params.items() if v is not None}
        params["wts"] = int(time.time())
        # wbi 规范：值中的 !'()* 字符参与签名前必须剔除
        cleaned = {k: "".join(ch for ch in str(v) if ch not in "!'()*")
                   for k, v in params.items()}
        qs = urlencode(sorted(cleaned.items()))
        params["w_rid"] = hashlib.md5((qs + self._mixin).encode()).hexdigest()
        return params
