"""输出层：单一结果 dict → 人类可读 / JSON 双渲染（§5.2 第 7 条：同源生成）。

stdout 只放机器数据或呈现内容；诊断一律 stderr 且带 meme: 前缀。
"""

from __future__ import annotations

import json
import sys

from .. import JSON_SCHEMA_VERSION
from ..errors import MemeError


def emit(command: str, payload: dict, as_json: bool, human: str) -> None:
    if as_json:
        doc = {"schema_version": JSON_SCHEMA_VERSION, "command": command}
        doc.update(payload)
        print(json.dumps(doc, ensure_ascii=False, default=str))
    else:
        print(human)


def emit_error(err: MemeError, as_json: bool) -> int:
    if as_json:
        doc = {"schema_version": JSON_SCHEMA_VERSION, "error": err.to_dict()}
        print(json.dumps(doc, ensure_ascii=False))
    else:
        print(f"meme: {err.code}: {err.message}", file=sys.stderr)
        if err.nearby:
            for nb in err.nearby:
                print(f"  ~ {nb.get('id', '?')} {nb.get('name', '')}（相似度 {nb.get('score', '?')}）",
                      file=sys.stderr)
        if err.suggestion:
            print(f"  建议：{err.suggestion}", file=sys.stderr)
    return err.exit_code


def warn(msg: str) -> None:
    print(f"meme: {msg}", file=sys.stderr)
