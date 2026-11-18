#!/usr/bin/python3
"""额度别浪费（主人 2026-10-21）：Claude 的 5 小时窗口快重置了还剩很多，就叫醒我用掉；睡前提醒给 Claude Code 派夜里的活。

给感知层用（senses.json 里的 command 事件源 quota）：每次输出 0 到 2 行 JSON（text + body）。
只看 Claude（我自己的 Max 账号）。Codex 是 主人 也在用的订阅，守 50% 红线，不催。
用量先读 HH 自己的读数（不调模型），读不到就发一个极小的 Haiku 请求读；15 分钟缓存一次，只在活动时间读。都读不到就不出声。
"""
import datetime
import json
import os
import pwd
import shutil
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

from hh_env import hh, words

say = words(__file__)

HOME = os.environ.get("QUOTA_HOME") or pwd.getpwuid(os.getuid()).pw_dir
STATE = os.path.join(os.path.join(hh.workspace, hh.config["dataDir"]) if hh.config.get("dataDir") else hh.module_state, "quota_pulse.json")
TZ = ZoneInfo(hh.tz)
CACHE_SEC = 900
NUDGE_BEFORE_RESET_MIN = 90   # 窗口重置前这么久之内
NUDGE_MAX_USED = 60           # 用量还不到这个百分比才提醒
WEEK_STOP = 85                # 7 天窗口到这里就不催了
ACTIVE = (8.0, 25.0)          # 早上 8 点到夜里 1 点（25 = 次日 1 点）
BEDTIME = (0.5, 1.0)          # 0:30–1:00 提醒睡前派夜里的活


def load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def usage(st, now_ts):
    c = st.get("cache") or {}
    if now_ts - c.get("at", 0) < CACHE_SEC:
        return c.get("claude")
    claude = None
    try:
        # 11-01 起读 HH 自己的读数（HH 醒着时每 10 分钟查一次），不再起 openclaw status
        r = subprocess.run([hh.hh_bin, "status"], capture_output=True, text=True, timeout=20)
        q = json.loads(r.stdout[r.stdout.find("{"):]).get("quotaUsed") or {}
        if q.get("fiveHour") is not None and q.get("at") and now_ts - q["at"] / 1000 < 30 * 60:
            claude = {"used": q["fiveHour"], "reset": (q.get("fiveHourResetsAt") or 0) / 1000, "week": q.get("sevenDay")}
    except Exception:
        claude = None
    if claude is None:
        claude = probe()
    if claude is None and c.get("claude") and now_ts - c.get("at", 0) < 3 * CACHE_SEC:
        return c["claude"]  # 用量接口偶尔 429，短时间内沿用上一次的
    st["cache"] = {"at": now_ts, "claude": claude}
    return claude


def probe():
    """HH 的读数太旧或 HH 不在：退回发一个极小的 Haiku 请求，从 rate_limit_event 里读（跟 quota.sh 一样）。"""
    d = os.path.join(HOME, ".cache/quota-probe")
    os.makedirs(d, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
    try:
        r = subprocess.run([shutil.which("claude") or os.path.join(HOME, ".local/bin/claude"), "-p", "ok", "--model", "haiku", "--max-turns", "1",
                            "--output-format", "stream-json", "--verbose"], capture_output=True, text=True,
                           timeout=90, cwd=d, env=env, stdin=subprocess.DEVNULL)
    except Exception:
        return None
    for line in r.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "rate_limit_event":
            w = (e.get("rate_limit_info") or {}).get("unifiedWindows") or {}
            five, week = w.get("five_hour") or {}, w.get("seven_day") or {}
            if five.get("utilization") is None:
                return None
            return {"used": round(five["utilization"] * 100), "reset": five.get("resetsAt") or 0,
                    "week": round(week["utilization"] * 100) if week.get("utilization") is not None else None}
    return None


def hour_of(dt):
    h = dt.hour + dt.minute / 60
    return h + 24 if h < 4 else h


def pulse(now=None, fetch=usage):
    now = now or datetime.datetime.now(TZ)
    now_ts = now.timestamp()
    st = load(STATE, {})
    out = []
    h = hour_of(now)
    c = None
    if ACTIVE[0] <= h < ACTIVE[1]:
        c = fetch(st, now_ts)
        if c and c.get("used") is not None and c.get("reset"):
            left_min = (c["reset"] - now_ts) / 60
            week_ok = c.get("week") is None or c["week"] < WEEK_STOP
            key = str(int(c["reset"] // 60))
            if 0 < left_min <= NUDGE_BEFORE_RESET_MIN and c["used"] < NUDGE_MAX_USED and week_ok \
                    and st.get("nudged_window") != key:
                st["nudged_window"] = key
                at = datetime.datetime.fromtimestamp(c["reset"], TZ).strftime("%H:%M")
                out.append({"id": f"quota:5h:{key}",
                            "text": say("quotaIdleText", used=c['used'], at=at),
                            "body": (say("quotaIdleBody", used=c['used'], at=at, minutes=int(left_min), week=c.get('week')))})
        if BEDTIME[0] + 24 <= h < BEDTIME[1] + 24 and st.get("bedtime_day") != now.strftime("%Y-%m-%d"):
            if not c or c.get("week") is None or c["week"] < WEEK_STOP:
                st["bedtime_day"] = now.strftime("%Y-%m-%d")
                out.append({"id": f"quota:bedtime:{now.strftime('%Y-%m-%d')}",
                            "text": say("quotaNightText"),
                            "body": (say("quotaNightBody", week=say("quotaNightWeek", week=c.get('week')) if c else ""))})
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f)
    return out


if __name__ == "__main__":
    for e in pulse():
        print(json.dumps(e, ensure_ascii=False))
