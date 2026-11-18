#!/bin/bash
# 离线测试（不连 B站）。改了插件代码就跑一遍：hh modules run bilibili ../tests/run.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# bili_events.py 的私信测试只用标准库和感官模块：系统的 python3 就行
python3 "$ROOT/tests/test_bili_events.py" || exit 1
exec "${HH_MODULE_STATE:?}/venv/bin/python" -E -s "$ROOT/tests/test_offline.py"
