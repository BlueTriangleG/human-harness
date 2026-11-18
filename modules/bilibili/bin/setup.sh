#!/bin/bash
# 建这个模块自己的 Python 环境（<module state>/venv，不进仓库）。重跑安全。经 hh modules run bilibili ../bin/setup.sh 跑。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${HH_MODULE_STATE:?}/venv"
UV="$(command -v uv || echo /opt/homebrew/bin/uv)"
PYBIN="${BILI_PYTHON:-/opt/homebrew/bin/python3.12}"
[ -x "$VENV/bin/python" ] || "$UV" venv -q --python "$PYBIN" "$VENV"
"$UV" pip install -q --python "$VENV/bin/python" -r "$ROOT/server/requirements.txt"
"$VENV/bin/python" -E -s -c "import sys; sys.path.insert(0,'$ROOT/server'); import main; print('ok', len(main.TOOL_NAMES), 'tools')"
