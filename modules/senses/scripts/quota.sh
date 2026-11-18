#!/bin/bash
# 查询 主人 的 Claude Code 和 Codex 订阅额度用了多少。
# Claude：先读 HH 的读数（不调模型，行尾标 "(HH)"）；读不到再发一个极小的请求读实时数据（只占很少一点额度）。
# Codex：发一个极小的请求读。11-01 起不再走 OpenClaw 的用量接口（主人：不要走 OpenClaw）。
# 输出示例：
#   claude 5h=3% 7d=19%
#   codex  5h=0% 7d=3%
# 读不到的窗口显示 "?"（不是 0%），这时按超限处理。
# 规则：任一窗口 >= 50% 就不能再派任务给对应的工具（见 AGENTS.md）。

CLAUDE=${QUOTA_CLAUDE_BIN:-claude}
CODEX=${QUOTA_CODEX_BIN:-codex}
CODEX_HOME_DIR="$HOME/.codex-coding-agent"
PROBE_TIMEOUT=${QUOTA_PROBE_TIMEOUT:-90}    # 秒；老办法探测一次最多等这么久

# macOS 没有 timeout 命令：用 perl 实现。子进程放进单独的进程组、stdin 接 /dev/null，
# 到点把整组杀掉（codex 是 node 包着原生程序，只杀外层的话里面那个会一直占着管道）。
with_timeout() {
  local secs=$1; shift
  perl -e '
    my $t = shift;
    my $pid = fork;
    die "fork: $!\n" unless defined $pid;
    if ($pid == 0) { setpgrp(0, 0); open(STDIN, "<", "/dev/null"); exec @ARGV or exit 127; }
    $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 1; kill "KILL", -$pid; exit 124 };
    alarm $t;
    waitpid($pid, 0);
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
  ' "$secs" "$@"
}

# 11-01 起：Claude 的用量先读 HH 自己的读数（HH 醒着时每 10 分钟查一次），
# 读数超过 30 分钟或者 HH 不在，再发一个极小的请求读实时数据。
hh_claude_usage() {
  local out
  out=$(with_timeout "${QUOTA_HH_TIMEOUT:-15}" "${HH_BIN:-hh}" status 2>/dev/null) || return 1
  printf '%s' "$out" | python3 -c '
import json, sys, time
try:
    q = json.load(sys.stdin).get("quotaUsed") or {}
except ValueError:
    sys.exit(1)
five, week, at = q.get("fiveHour"), q.get("sevenDay"), q.get("at")
if five is None or week is None or not at or time.time() * 1000 - at > 30 * 60 * 1000:
    sys.exit(1)
print("claude 5h={}% 7d={}% (HH)".format(round(five), round(week)))
'
}

claude_usage() {
  hh_claude_usage && return
  local dir; dir=$(mktemp -d)
  (unset CLAUDE_CONFIG_DIR; cd "$dir" && with_timeout "$PROBE_TIMEOUT" "$CLAUDE" -p "ok" --model haiku --max-turns 1 \
      --output-format stream-json --verbose 2>/dev/null) | python3 -c '
import json, sys
def pct(w, key):
    v = (w.get(key) or {}).get("utilization")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "?"
    return "%d%%" % round(v * 100)
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "rate_limit_event":
        w = (d.get("rate_limit_info") or {}).get("unifiedWindows") or {}
        print("claude 5h={} 7d={}".format(pct(w, "five_hour"), pct(w, "seven_day")))
        sys.exit(0)
print("claude unknown (no rate_limit_event; check login)")
'
  rm -rf "$dir"
}

codex_usage() {
  if [ ! -d "$CODEX_HOME_DIR" ]; then
    echo "codex  Codex 未登录（~/.codex-coding-agent 不存在）"
    return
  fi
  local dir; dir=$(mktemp -d); git -C "$dir" init -q
  with_timeout "$PROBE_TIMEOUT" env -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN -u OPENAI_API_KEY CODEX_HOME="$CODEX_HOME_DIR" \
    "$CODEX" exec --json -C "$dir" "reply ok" 2>/dev/null | python3 -c '
import json, re, sys
data = sys.stdin.read()
m = None
for m in re.finditer(r"\"rate_limits\":(\{.*?\"credits\")", data):
    pass
if not m:
    print("codex unknown (no rate_limits; check CODEX_HOME login)")
    sys.exit(0)
rl = json.loads(m.group(1)[: -len(",\"credits\"")] + "}")
out = {}
for key in ("primary", "secondary"):
    w = rl.get(key) or {}
    mins = w.get("window_minutes")
    if mins == 300:
        out["5h"] = w.get("used_percent")
    elif mins == 10080:
        out["7d"] = w.get("used_percent")
def pct(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "?"
    return "%d%%" % round(v)
print("codex  5h={} 7d={}".format(pct(out.get("5h")), pct(out.get("7d"))))
'
  rm -rf "$dir"
}

case "${1:-all}" in
  claude) claude_usage ;;
  codex) codex_usage ;;
  *) claude_usage; codex_usage ;;
esac
