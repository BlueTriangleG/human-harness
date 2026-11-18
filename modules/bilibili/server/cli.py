#!/usr/bin/env python3
"""命令行直接调 B站 工具（和 MCP 是同一套函数）。给脚本、Claude Code 工人、调试用。

  bin/bili list                         # 列出所有工具和一句话说明
  bin/bili help <工具>                   # 看某个工具的完整说明和参数
  bin/bili <工具> '{"bvid":"BV1xx"}'      # JSON 参数
  bin/bili <工具> bvid=BV1xx num=5       # 或者 key=value（数字/true/false/[..] 会自动转）
"""
import asyncio
import inspect
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402
from bilitools import core  # noqa: E402


def _tools():
    return {fn.__name__: fn for mod in main.MODULES for fn in mod.TOOLS}


def _val(s: str):
    try:
        return json.loads(s)
    except ValueError:
        return s


def main_cli(argv):
    tools = _tools()
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "list":
        for n, fn in sorted(tools.items()):
            print(f"{n:18s} {core.text(f'tool.{n}').splitlines()[0]}")
        return 0
    if argv[0] == "help":
        fn = tools.get(argv[1] if len(argv) > 1 else "")
        if not fn:
            print(core.say("cli.main_cli.1"), file=sys.stderr)
            return 2
        print(f"{fn.__name__}{inspect.signature(fn)}\n\n{core.text(f'tool.{fn.__name__}')}")
        return 0
    fn = tools.get(argv[0])
    if not fn:
        print(core.say("cli.main_cli.2", a=argv[0]), file=sys.stderr)
        return 2
    kwargs = {}
    rest = argv[1:]
    if len(rest) == 1 and rest[0].lstrip().startswith("{"):
        kwargs = json.loads(rest[0])
    else:
        for a in rest:
            if "=" not in a:
                print(core.say("cli.main_cli.3", a=a), file=sys.stderr)
                return 2
            k, v = a.split("=", 1)
            kwargs[k] = _val(v)
    out = asyncio.run(fn(**kwargs))
    print(json.dumps(core.named_out(out) if isinstance(out, dict) else out, ensure_ascii=False, indent=1))
    return 0 if not (isinstance(out, dict) and out.get("ok") is False) else 1


if __name__ == "__main__":
    sys.exit(main_cli(sys.argv[1:]))
