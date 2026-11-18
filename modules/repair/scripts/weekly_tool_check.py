#!/usr/bin/env python3
"""每周工具检查：只看版本，什么都不升级。

repair 模块每周跑它一次，结果作为提醒留给角色；要不要升，角色问过主人再定。
查的是 brew 装的工具（模块配置 brewTools）：`brew outdated --json=v2 <工具>`，全是只读命令。
结果另存一份到模块的状态目录（tool-check-latest.md），回头好对照。
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from hh_env import hh, words

say = words(__file__)

BREW = shutil.which('brew') or '/opt/homebrew/bin/brew'
OUT = Path(hh.module_state) / 'tool-check-latest.md'
BREW_TOOLS = list(hh.config.get('brewTools', []))
ENV = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE='1', NO_COLOR='1')


def run(args: list[str], timeout: int) -> tuple[int, str, str]:
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=ENV, cwd=str(Path.home()))
        return p.returncode, p.stdout or '', p.stderr or ''
    except subprocess.TimeoutExpired:
        return 124, '', 'timed out'
    except OSError as e:
        return 127, '', str(e)


# ---- 解析（纯函数，test_weekly_tool_check.py 测这些） ----

def brew_outdated(tool: str, rc: int, stdout: str) -> list[str] | None:
    """返回这个工具过期的版本说明；查不了返回 None。"""
    try:
        d = json.loads(stdout)
    except ValueError:
        return None
    return [f"{f['name']} {'/'.join(f.get('installed_versions') or ['?'])}→{f.get('current_version', '?')}"
            for f in d.get('formulae', [])]


def brew_line(results: dict[str, list[str] | None]) -> str:
    old = [x for v in results.values() if v for x in v]
    unknown = [t for t, v in results.items() if v is None]
    parts = []
    if old:
        parts.append(say('hasNew', tools=say('listSep').join(old)))
    elif not unknown:
        parts.append(say('allLatest'))
    if unknown:
        parts.append(say('cannotCheck', tools=say('listSep').join(unknown)))
    return say('brewLine', parts=say('partSep').join(parts))


def compose(lines: list[str]) -> str:
    mark = say('hasNew', tools='')   # what brew_line adds after the tools that can be upgraded
    news = any(mark in l for l in lines)
    return '\n'.join([say('head')] + [f'- {l}' for l in lines] + [say('tailNew' if news else 'tailNone')])


# ---- 跑 ----

def main() -> int:
    try:
        res = {}
        for t in BREW_TOOLS:
            b_rc, b_out, _ = run([BREW, 'outdated', '--json=v2', t], 120)
            res[t] = brew_outdated(t, b_rc, b_out)
        msg = compose([brew_line(res)]) if BREW_TOOLS else compose([say('noTools')])
    except Exception as e:  # 无论如何报一句，别让人以为查过了
        msg = say('failed', error=f'{type(e).__name__}: {str(e)[:200]}')
    try:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(f'<!-- {dt.datetime.now():%Y-%m-%d %H:%M} -->\n{msg}\n', encoding='utf-8')
    except OSError:
        pass
    print(msg)
    return 0


if __name__ == '__main__':
    sys.exit(main())
