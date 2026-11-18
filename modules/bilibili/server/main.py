#!/usr/bin/env python3
"""{me}的 B站 MCP 服务（stdio）。OpenClaw 通过插件的 mcp.json 拉起它；工具在 code mode 里是 MCP.bili.<工具名>。

基于 AGI_Ananas/bilibili-mcp 和 c1overzz/dsh-bili-scroll（都是 MIT，见 vendor/），按{me}的用法重写和扩展。
"""
import functools
import inspect
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP  # noqa: E402
from mcp.types import CallToolResult, TextContent  # noqa: E402

from bilitools import act, auth, core, discover, inbox, ledger, publish, viewing  # noqa: E402

mcp = FastMCP("bili", instructions=core.text("instructions"))

MODULES = (auth, discover, viewing, act, inbox, ledger, publish)


def as_mcp(fn):
    """工具函数返回 dict → MCP 结果：structuredContent 原样（code mode 里直接当对象用），
    文本是紧凑 JSON（不缩进，省 token）；ok=false 标 isError。"""
    sig = inspect.signature(fn, eval_str=True)

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        out = await fn(*args, **kwargs)
        if not isinstance(out, dict):
            out = {"ok": True, "result": out}
        out = core.named_out(out)
        text = json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str)
        return CallToolResult(content=[TextContent(type="text", text=text)],
                              structuredContent=json.loads(text), isError=out.get("ok") is False)

    wrapper.__signature__ = sig.replace(return_annotation=CallToolResult)
    wrapper.__annotations__ = {**{k: p.annotation for k, p in sig.parameters.items()}, "return": CallToolResult}
    return wrapper


def register():
    names = set()
    for mod in MODULES:
        for fn in mod.TOOLS:
            name = fn.__name__
            if name in names:
                raise RuntimeError(core.say("main.register.1", a=name))
            names.add(name)
            mcp.tool(name=name, description=core.text(f"tool.{name}"))(as_mcp(fn))
    return sorted(names)


TOOL_NAMES = register()

if __name__ == "__main__":
    mcp.run("stdio")
