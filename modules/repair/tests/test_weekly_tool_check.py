#!/usr/bin/python3
"""weekly_tool_check.py 的解析测试。跑：python3 modules/repair/tests/test_weekly_tool_check.py"""
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "scripts"), str(HERE.parent.parent / "_lib")]
# run by itself: what HH hands the script points at an empty temp dir, made-up names
_tmp = tempfile.mkdtemp(prefix="toolcheck-env-")
for _k, _v in dict({k: _tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                   HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="UTC", HH_LANG="zh", HH_BIN=_tmp + "/no-hh").items():
    os.environ.setdefault(_k, _v)
import weekly_tool_check as w  # noqa: E402

# brew
J = '{"formulae":[{"name":"gh","installed_versions":["2.102.0"],"current_version":"2.103.2"}],"casks":[]}'
assert w.brew_outdated('gh', 1, J) == ['gh 2.102.0→2.103.2']
assert w.brew_outdated('gh', 0, '{"formulae":[],"casks":[]}') == []
assert w.brew_outdated('memo', 1, '') is None
line = w.brew_line({'gh': ['gh 2.102.0→2.103.2'], 'memo': None, 'summarize': []})
assert line.startswith('brew：gh 2.102.0→2.103.2 有新版') and '查不了：memo' in line, line
assert w.brew_line({'gh': [], 'summarize': []}) == 'brew：都是最新的'

# 整条消息
m = w.compose(['brew：gh 2.102.0→2.103.2 有新版'])
assert m.splitlines()[0].startswith('每周工具检查') and m.endswith('有新版的，问过老林再升。'), m
assert w.compose(['brew：都是最新的']).endswith('都不用升。')
print('all ok')
