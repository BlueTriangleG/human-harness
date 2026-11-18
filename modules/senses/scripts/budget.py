#!/usr/bin/python3
"""budget — the role's quota ledger: reads the Claude quota (a tiny request, cached), keeps the readings in
memory/budget/snaps.jsonl, shows how the week is paced, and wakes the role through the senses when the week runs far
behind or far ahead. `budget help` prints the commands in the role's language (the entry "budgetUsage" of texts.*.json).
"""
import datetime, glob, json, os, shutil, subprocess, sys, tempfile, time
from zoneinfo import ZoneInfo

from hh_env import hh, words

say = words(__file__)

HOME = os.path.expanduser("~")
WS = hh.workspace
DIR = os.path.join(WS, "memory/budget")
SNAPS = os.path.join(DIR, "snaps.jsonl")
STATE = os.path.join(DIR, "pulse_state.json")
CLAUDE = shutil.which("claude") or os.path.join(HOME, ".local/bin/claude")
CC_DB = hh.config.get("helperSessionsDir", "")   # where the helpers keep their session files; unset: none are counted
TZ = ZoneInfo(hh.tz)
CACHE_SEC = 900
STALE_SEC = 3600          # 读不到新数时，旧数超过这么久就不拿来催（10-31 23:23 起读法变了，旧的 56% 用了一整天）
WEEK_TARGET = 95          # 一周想用到多少（留 5% 给意外）
BEHIND_PTS = 8            # 比节奏落后这么多点就叫我（在浪费）
AHEAD_PTS = 12            # 比节奏超前这么多点就叫我（烧太快）
NUDGE_GAP_H = 3
ACTIVE = (8.0, 25.0)
DAY_START = 4


def now():
    return datetime.datetime.now(TZ)


def day_of(ts):
    t = datetime.datetime.fromtimestamp(ts, TZ) - datetime.timedelta(hours=DAY_START)
    return t.date().isoformat()


def running_cc():
    out = []
    for f in glob.glob(os.path.join(CC_DB, "*.json")) if CC_DB else []:
        try:
            m = json.load(open(f))
            if m.get("state") == "running" and m.get("pid"):
                os.kill(m["pid"], 0)
                out.append(os.path.basename(f)[:-5])
        except (OSError, ValueError):
            pass
    return sorted(out)


def parse(stdout):
    """从 stream-json 里拿额度。窗口可能分在几条 rate_limit_event 里，也可能只给一个（11-01 起常常只有 seven_day）。
    有 7 天窗口就算读到；5 小时窗口没给就记 None。"""
    wins = {}
    for line in stdout.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("type") != "rate_limit_event":
            continue
        for k, v in ((j.get("rate_limit_info") or {}).get("unifiedWindows") or {}).items():
            if isinstance(v, dict) and isinstance(v.get("utilization"), (int, float)):
                wins[k] = v
    f, s = wins.get("five_hour"), wins.get("seven_day")
    if not s:
        return None
    return {"five": round(f["utilization"] * 100, 1) if f else None, "five_reset": f.get("resetsAt") if f else None,
            "week": round(s["utilization"] * 100, 1), "week_reset": s.get("resetsAt")}


def probe():
    d = tempfile.mkdtemp()
    env = dict(os.environ)
    env.pop("CLAUDE_CONFIG_DIR", None)
    try:
        p = subprocess.run([CLAUDE, "-p", "ok", "--model", "haiku", "--max-turns", "1",
                            "--output-format", "stream-json", "--verbose"],
                           cwd=d, env=env, capture_output=True, text=True, timeout=90)
    except Exception:
        return None
    return parse(p.stdout)


def snaps():
    try:
        return [json.loads(l) for l in open(SNAPS, encoding="utf-8") if l.strip()]
    except OSError:
        return []


def snap(force=False):
    s = snaps()
    if s and not force and time.time() - s[-1]["ts"] < CACHE_SEC:
        return s[-1]
    r = probe()
    if not r:
        return dict(s[-1], stale=True) if s else None   # 读不到：给旧数，但标上，pulse 不拿太旧的催
    r.update(ts=int(time.time()), t=now().strftime("%Y-%m-%d %H:%M"), cc=running_cc())
    os.makedirs(DIR, exist_ok=True)
    with open(SNAPS, "a", encoding="utf-8") as f:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return r


def pace(r):
    """周窗口按时间均匀用到 WEEK_TARGET：现在应该用到多少。"""
    if not r.get("week_reset"):
        return None
    start = r["week_reset"] - 7 * 86400
    frac = min(1, max(0, (time.time() - start) / (7 * 86400)))
    return round(frac * WEEK_TARGET, 1)


def pct(v):
    return "?" if v is None else f"{v}%"


def fmt_ts(ts):
    return datetime.datetime.fromtimestamp(ts, TZ).strftime("%m-%d %H:%M") if ts else "?"


def today_spend(s, d):
    rows = [x for x in s if day_of(x["ts"]) == d]
    if len(rows) < 2:
        return None
    return round(rows[-1]["week"] - rows[0]["week"], 1)


def status():
    r = snap()
    if not r:
        print(say("budgetUnreadable"))
        return
    s = snaps()
    p = pace(r)
    left_days = (r["week_reset"] - time.time()) / 86400 if r.get("week_reset") else None
    if r.get("stale"):
        print(say("budgetStale", at=r.get('t', '?')))
    print(say("budgetFive", pct=pct(r['five']), at=fmt_ts(r['five_reset'])))
    print(say("budgetWeek", week=r['week'], at=fmt_ts(r['week_reset']), left_days=left_days) if left_days else say("budgetWeekOnly", week=r['week']))
    if p is not None:
        diff = r["week"] - p
        print(say("budgetPace", p=p, week=r['week'], gap=say("budgetBehind", points=-diff) if diff < 0 else say("budgetAhead", diff=diff)))
        if left_days and left_days > 0:
            print(say("budgetPerDay", points=(WEEK_TARGET - r['week']) / left_days))
    t = today_spend(s, day_of(time.time()))
    if t is not None:
        print(say("budgetToday", t=t))
    print(say("budgetRunning", list=say("comma").join(r.get("cc") or []) or say("none")))


def day(d=None):
    d = d or day_of(time.time())
    rows = [x for x in snaps() if day_of(x["ts"]) == d]
    if not rows:
        print(say("dayNone"))
        return
    print(say("dayHead", d=d, week=rows[0]['week'], week2=rows[-1]['week'], points=rows[-1]['week'] - rows[0]['week']))
    prev = rows[0]
    for x in rows[1:]:
        dw = x["week"] - prev["week"]
        df = x["five"] - prev["five"] if x.get("five") is not None and prev.get("five") is not None else None
        if dw > 0 or (df or 0) > 0:
            five = "?" if df is None else f"{'+' if df >= 0 else ''}{df:.1f}"
            print(say("dayRow", t=prev['t'][11:], t2=x['t'][11:], dw=dw, five=five, list=say("comma").join(x.get('cc') or []) or '-'))
        prev = x


def pulse():
    n = now()
    h = n.hour + n.minute / 60
    if h < DAY_START:
        h += 24
    if not (ACTIVE[0] <= h < ACTIVE[1]):
        return
    r = snap()
    if not r or (r.get("stale") and time.time() - r.get("ts", 0) > STALE_SEC):
        return
    p = pace(r)
    if p is None:
        return
    try:
        st = json.load(open(STATE))
    except (OSError, ValueError):
        st = {}
    diff = r["week"] - p
    kind = "behind" if diff <= -BEHIND_PTS else "ahead" if diff >= AHEAD_PTS else None
    if not kind or time.time() - st.get(kind, 0) < NUDGE_GAP_H * 3600:
        return
    st[kind] = time.time()
    os.makedirs(DIR, exist_ok=True)
    json.dump(st, open(STATE, "w"))
    cc = say("comma").join(r.get("cc") or []) or say("none")
    if kind == "behind":
        text = say("pulseBehind", week=r['week'], p=p, points=-diff)
        todo = say("pulseBehindTodo")
    else:
        text = say("pulseAhead", week=r['week'], p=p, diff=diff)
        todo = say("pulseAheadTodo")
    body = "\n".join([text, say("pulseWindows", pct=pct(r['five']), at=fmt_ts(r['five_reset']), at2=fmt_ts(r['week_reset'])),
                      say("pulseRunning", cc=cc), todo, say("pulseDetails")])
    print(json.dumps({"id": f"budget:{kind}:{int(time.time() // 3600)}", "text": text, "body": body}, ensure_ascii=False))


if __name__ == "__main__":
    a = sys.argv[1:]
    c = a[0] if a else "status"
    if c == "snap":
        print(json.dumps(snap("--force" in a), ensure_ascii=False))
    elif c == "status":
        status()
    elif c == "pulse":
        pulse()
    elif c == "day":
        day(a[1] if len(a) > 1 else None)
    else:
        print(say("budgetUsage"))
