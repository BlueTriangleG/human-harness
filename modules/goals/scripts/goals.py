#!/usr/bin/python3
"""goals — the role's own goals on four levels (dream, long, short, today): it sets them, follows them and judges by
itself when one is done. `goals help` prints the commands in the role's language (the entry "usage" of texts.*.json).
Data: memory/goals/goals.json in the workspace, with a readable GOALS.md rewritten at every change.
"""
import datetime
import json
import os
import sys
import time
from zoneinfo import ZoneInfo

from hh_env import hh, words

say = words(__file__)

WS = hh.workspace
DATA = os.path.join(WS, hh.config.get("dataFile", "memory/goals/goals.json"))
DIR = os.path.dirname(DATA)
MD = os.path.join(DIR, "GOALS.md")
CC_DB = hh.config.get("helperSessionsDir", "")  # the helpers' session records (<name>.json each); "" = no helpers to look at
TZ = ZoneInfo(hh.tz)
LEVELS = {"dream": say("levelDream"), "long": say("levelLong"), "short": say("levelShort"), "today": say("levelToday")}
ORDER = ["dream", "long", "short", "today"]
PARENT_OK = {"today": {"short", "long", "dream"}, "short": {"long", "dream"}, "long": {"dream"}, "dream": set()}
STATUS = {"active": say("statusActive"), "done": say("statusDone"), "dropped": say("statusDropped"), "blocked": say("statusBlocked")}
MAX_TODAY = 3
PULSE_GAP_MIN = int(os.environ.get("GOALS_PULSE_GAP_MIN", "30"))  # 多久没进展就叫一次
PULSE_MAX_PER_DAY = 10                                             # 每个目标一天最多叫几次
DAY_START = hh.config.get("dayStartsAt", 4)   # the hour the role's day changes: before it, it is still the day before
# the hours the pulse may wake the role, counted in the role's day (an hour before DAY_START is the next morning's: +24)
PULSE_HOURS = tuple(float(x) + (24 if x < DAY_START else 0) for x in (hh.config.get("remindFrom", 8), hh.config.get("remindUntil", 1)))


def now():
    return datetime.datetime.now(TZ)


def today():
    return (now() - datetime.timedelta(hours=DAY_START)).strftime("%Y-%m-%d")


def stamp():
    return now().strftime("%Y-%m-%d %H:%M")


def die(msg):
    print(msg)
    sys.exit(1)


def load():
    try:
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"next": 1, "goals": []}


def save(d):
    os.makedirs(DIR, exist_ok=True)
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA)
    with open(MD + ".tmp", "w", encoding="utf-8") as f:
        f.write(render_md(d))
    os.replace(MD + ".tmp", MD)


def get(d, gid):
    for g in d["goals"]:
        if g["id"] == gid:
            return g
    die(say("noGoal", gid=gid))


def opts(args, names):
    out, rest, i = {}, [], 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and a[2:] in names and i + 1 < len(args):
            out[a[2:]] = args[i + 1]
            i += 2
        else:
            rest.append(a)
            i += 1
    return out, rest


def ago_min(ts):
    return int((time.time() - ts) / 60)


def ago_text(ts):
    m = ago_min(ts)
    return say("agoMinutes", m=m) if m < 60 else say("agoHours", h=m // 60) if m < 48 * 60 else say("agoDays", d=m // 1440)


def last_touch(g):
    ts = [g.get("created_ts", 0), g.get("last_pulse", 0)] + [x.get("ts", 0) for x in g.get("log", [])]
    return max(ts)


def active_today(d):
    return [g for g in d["goals"] if g["level"] == "today" and g["status"] == "active" and g.get("day") == today()]


def stale_today(d):
    return [g for g in d["goals"] if g["level"] == "today" and g["status"] == "active" and g.get("day") != today()]


def cc_running(name):
    if not CC_DB:
        return False
    try:
        m = json.load(open(os.path.join(CC_DB, name + ".json")))
        if m.get("state") != "running":
            return False
        if not m.get("pid"):
            # 后台模式（claude --bg）只有 bg_id 没有 pid，跟 cc.py busy() 一样算在干活
            return m.get("mode") == "bg"
        os.kill(m["pid"], 0)
        return True
    except (OSError, ValueError):
        return False


def links_busy(g):
    return [l for l in g.get("links", []) if l.startswith("cc:") and cc_running(l[3:])]


# ---------- 命令 ----------

def cmd_add(args):
    o, rest = opts(args, {"why", "done-when", "parent", "due", "link"})
    if len(rest) < 2 or rest[0] not in LEVELS:
        die(say("addUsage"))
    level, title = rest[0], " ".join(rest[1:]).strip()
    if not o.get("why") or not o.get("done-when"):
        die(say("addNeedsWhy"))
    d = load()
    if level == "today" and len(active_today(d)) >= MAX_TODAY:
        die(say("todayFullList", max=MAX_TODAY, list=say("comma").join(f"{g['id']} {g['title']}" for g in active_today(d))))
    if o.get("parent"):
        p = get(d, o["parent"])
        if p["level"] not in PARENT_OK[level]:
            die(say("dreamNoParent") if level == "dream" else
                say("parentMustBe", level=LEVELS[level], list=say("comma").join(LEVELS[x] for x in ORDER if x in PARENT_OK[level])))
    g = {"id": f"g{d['next']}", "level": level, "title": title, "why": o["why"], "done_when": o["done-when"],
         "parent": o.get("parent"), "due": o.get("due"), "status": "active", "created": stamp(),
         "created_ts": time.time(), "log": [], "links": [o["link"]] if o.get("link") else []}
    if level == "today":
        g["day"] = today()
    d["next"] += 1
    d["goals"].append(g)
    save(d)
    print(say("added", id=g['id'], level=LEVELS[level], title=title))


def cmd_log(gid, text):
    d = load()
    g = get(d, gid)
    g.setdefault("log", []).append({"t": stamp(), "ts": time.time(), "text": text})
    save(d)
    print(say("logged", gid=gid, text=text[:60]))


def close(gid, status, note):
    d = load()
    g = get(d, gid)
    g.update(status=status, closed=stamp(), closed_note=note)
    g.setdefault("log", []).append({"t": stamp(), "ts": time.time(), "text": f"[{STATUS[status]}] {note}"})
    save(d)
    print(say("closed", gid=gid, title=g['title'], status=STATUS[status], note=note[:80]))


def cmd_resume(gid):
    d = load()
    g = get(d, gid)
    if g["status"] == "active":
        die(say("alreadyActive"))
    if g["level"] == "today" and len(active_today(d)) >= MAX_TODAY and g.get("day") == today():
        die(say("todayFull", max=MAX_TODAY))
    g.update(status="active")
    g["log"].append({"t": stamp(), "ts": time.time(), "text": say("logResumed")})
    save(d)
    print(say("resumed", gid=gid))


def cmd_carry(gid):
    d = load()
    g = get(d, gid)
    if g["level"] != "today" or g["status"] != "active":
        die(say("carryOnlyToday"))
    if g.get("day") == today():
        die(say("carryAlreadyToday"))
    if len(active_today(d)) >= MAX_TODAY:
        die(say("todayFull", max=MAX_TODAY))
    g["log"].append({"t": stamp(), "ts": time.time(), "text": say("logCarried", day=g.get('day'))})
    g.update(day=today(), pulses={})
    save(d)
    print(say("carried", gid=gid))


def cmd_edit(gid, args):
    o, _ = opts(args, {"title", "why", "done-when", "due", "parent"})
    if not o:
        die(say("editWhat"))
    d = load()
    g = get(d, gid)
    if o.get("parent"):
        p = get(d, o["parent"])
        if p["level"] not in PARENT_OK[g["level"]]:
            die(say("editBadParent"))
    for k, v in o.items():
        g[k.replace("-", "_")] = v
    g["log"].append({"t": stamp(), "ts": time.time(), "text": say("logEdited", fields=say("comma").join(o))})
    save(d)
    print(say("edited", gid=gid))


def cmd_link(gid, link):
    if not link.startswith("cc:"):
        die(say("linkFormat"))
    d = load()
    g = get(d, gid)
    if link not in g.setdefault("links", []):
        g["links"].append(link)
    save(d)
    print(say("linked", gid=gid, link=link))


def line(g, d, detail=False):
    s = say("line", id=g['id'], level=LEVELS[g['level']], status=STATUS[g['status']], title=g['title'])
    if g.get("due"):
        s += say("due", due=g['due'])
    if g["level"] == "today" and g.get("day") != today() and g["status"] == "active":
        s += say("lineStale", day=g.get('day'))
    if g.get("parent"):
        s += f" ← {g['parent']}"
    if detail:
        s += say("lineDetail", why=g['why'], done_when=g['done_when'])
        if g.get("links"):
            s += say("lineLinks", links=say("comma").join(g["links"]))
        for x in g.get("log", [])[-3:]:
            s += f"\n    {x['t'][5:]} {x['text'][:120]}"
    return s


def cmd_ls(show_all):
    d = load()
    gs = d["goals"] if show_all else [g for g in d["goals"] if g["status"] in ("active", "blocked")]
    if not gs:
        print(say("lsEmpty"))
        return
    for lv in ORDER:
        sub = [g for g in gs if g["level"] == lv]
        if sub:
            print(f"\n## {LEVELS[lv]}")
            for g in sub:
                print("- " + line(g, d, detail=True))


def cmd_show(gid):
    d = load()
    g = get(d, gid)
    print(line(g, d))
    print(say("showDetail", why=g['why'], done_when=g['done_when'], created=g['created'], links=say("showLinks", links=say("comma").join(g['links'])) if g.get("links") else ""))
    kids = [k for k in d["goals"] if k.get("parent") == gid]
    if kids:
        print(say("kids", list=say("semicolon").join(say("showKid", id=k['id'], title=k['title'], status=STATUS[k['status']]) for k in kids)))
    for x in g.get("log", []):
        print(f"  {x['t']} {x['text']}")


def brief(d, who="main"):
    act = [g for g in d["goals"] if g["status"] in ("active", "blocked")]
    if not act:
        return say("briefNone")
    out = [say("briefHead")]
    tod = [g for g in act if g["level"] == "today"]
    if tod:
        out.append(say("briefToday"))
        for g in tod:
            last = g["log"][-1] if g.get("log") else None
            busy = links_busy(g)
            s = say("briefLine", id=g['id'], title=g['title'], done_when=g['done_when'][:80])
            s += say("briefLast", text=last['text'][:60], ago=ago_text(last['ts'])) if last else say("briefNoProgress")
            if busy:
                s += say("briefBusy", links=say("comma").join(busy))
            if g.get("day") != today():
                s += say("briefStale", day=g.get('day'))
            if g["status"] == "blocked":
                s += say("briefBlocked")
            out.append(s)
    else:
        out.append(say("briefTodayNone", hint="" if who == "life" else say("briefTodayHint")))
    for lv in ("short", "long", "dream"):
        sub = [g for g in act if g["level"] == lv]
        if sub:
            out.append(say("briefLevel", level=LEVELS[lv], list=say("semicolon").join(f"{g['id']} {g['title']}" + (say("due", due=g['due']) if g.get("due") else "")
                                                   + (say("briefBlockedMark") if g["status"] == "blocked" else "") for g in sub)))
    return "\n".join(out)


TRACK_STALE_DAYS = {"short": 2, "long": 4, "dream": 10}  # 这么多天没 log 进展就叫我
TRACK_BLOCKED_DAYS = 3                                     # 卡住的目标，隔几天叫我看看解没解开


def last_progress(g):
    return max([g.get("created_ts", 0)] + [x.get("ts", 0) for x in g.get("log", [])])


def track_upper(d):
    """短期/长期/梦想：过期、快到期、太久没进展、卡住太久，一天最多叫一次（主人 10-21：都要一直 track）。"""
    out = []
    t = today()
    for g in d["goals"]:
        if g["level"] == "today" or g["status"] not in ("active", "blocked"):
            continue
        if g.get("track_day") == t or links_busy(g):
            continue
        why = None
        idle = (time.time() - last_progress(g)) / 86400
        if g["status"] == "blocked":
            if idle >= TRACK_BLOCKED_DAYS:
                why = say("trackBlocked", days=int(idle))
        elif g.get("due") and g["due"] < t:
            why = say("trackOverdue", due=g['due'])
        elif g.get("due") and g["level"] == "short" and g["due"] == t:
            why = say("trackDueToday", due=g['due'])
        elif idle >= TRACK_STALE_DAYS[g["level"]]:
            why = say("trackIdle", days=int(idle))
        if not why:
            continue
        g["track_day"] = t
        kids = [k for k in d["goals"] if k.get("parent") == g["id"] and k["status"] in ("active", "blocked")]
        body = [say("trackGoal", title=g['title'], id=g['id'], level=LEVELS[g['level']]), say("trackWhyRemind", why=why),
                say("whyWant", why=g['why']), say("doneWhen", done_when=g['done_when'])]
        if g.get("due"):
            body.append(say("dueLine", due=g['due']))
        body.append(say("kids", list=say("comma").join(f"{k['id']} {k['title']}" for k in kids) if kids else say("trackNoKids")))
        body.append(say("recent", list=say("semicolon").join(f"{x['t']} {x['text'][:100]}" for x in g["log"][-3:]) if g.get("log") else say("noneYet")))
        body.append(say("trackWhatToDo"))
        out.append({"id": f"track:{g['id']}:{t}", "text": say("trackText", level=LEVELS[g['level']], id=g['id'], title=g['title'][:30], why=why), "body": "\n".join(body)})
    return out


def cmd_pulse():
    """今日目标太久没进展、短期/长期/梦想过期或太久没进展，就出一行（JSON，带正文）让感知层叫醒我。"""
    n = now()
    hour = n.hour + n.minute / 60
    if hour < DAY_START:
        hour += 24
    if not (PULSE_HOURS[0] <= hour < PULSE_HOURS[1]):
        return
    d = load()
    changed = False
    for g in active_today(d):
        if links_busy(g):
            continue
        if time.time() - last_touch(g) < PULSE_GAP_MIN * 60:
            continue
        pulses = g.setdefault("pulses", {})
        k = pulses.get(today(), 0)
        if k >= PULSE_MAX_PER_DAY:
            continue
        pulses[today()] = k + 1
        g["last_pulse"] = time.time()
        changed = True
        last = g["log"][-1] if g.get("log") else None
        parent = next((p for p in d["goals"] if p["id"] == g.get("parent")), None)
        body = [say("pulseGoal", title=g['title'], id=g['id']),
                say("why", why=g['why']), say("doneWhen", done_when=g['done_when'])]
        if parent:
            body.append(say("pulseParent", id=parent['id'], title=parent['title'], level=LEVELS[parent['level']]))
        body.append(say("recent", list=say("semicolon").join(f"{x['t'][11:]} {x['text'][:100]}" for x in g["log"][-3:]) if g.get("log") else say("noneYet")))
        if g.get("links"):
            body.append(say("pulseLinks", links=say("comma").join(g["links"])))
        body.append(say("pulseCount", n=k + 1, max=PULSE_MAX_PER_DAY))
        body.append(say("pulseWhatToDo"))
        print(json.dumps({"id": f"goal:{g['id']}:{today()}:{k + 1}",
                          "text": say("pulseText", id=g['id'], title=g['title'][:40], last=say("pulseLast", ago=ago_text(last['ts'])) if last else say("pulseNoProgress")),
                          "body": "\n".join(body)}, ensure_ascii=False))
    for ev in track_upper(d):
        changed = True
        print(json.dumps(ev, ensure_ascii=False))
    if changed:
        save(d)


def cmd_topic(a):
    if a and a[0] == "add":
        o, rest = opts(a[1:], {"why", "done-when", "parent", "due", "link"})
        g = {"title": " ".join(rest[1:]).strip(), "why": o.get("why")}
    elif a and a[0] in ("log", "block") and len(a) > 1:
        g = next((x for x in load()["goals"] if x.get("id") == a[1]), None)
    else:
        g = None
    print(json.dumps({"title": g["title"], "why": g.get("why")} if g and g.get("title") else None, ensure_ascii=False))


def render_md(d):
    out = [say("mdTitle"), "", say("mdNote", stamp=stamp()), ""]
    for lv in ORDER:
        sub = [g for g in d["goals"] if g["level"] == lv and g["status"] in ("active", "blocked")]
        if sub:
            out.append(f"## {LEVELS[lv]}")
            out += ["- " + line(g, d, detail=True) for g in sub]
            out.append("")
    done = [g for g in d["goals"] if g["status"] in ("done", "dropped")][-15:]
    if done:
        out.append(say("mdClosed"))
        out += [say("mdClosedLine", id=g['id'], level=LEVELS[g['level']], status=STATUS[g['status']], title=g['title'], note=g.get('closed_note', '')[:100], closed=g.get('closed', ''))
                for g in reversed(done)]
    return "\n".join(out) + "\n"


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(say("usage"))
        return
    c = a[0]
    if c == "add":
        cmd_add(a[1:])
    elif c == "log" and len(a) > 2:
        cmd_log(a[1], " ".join(a[2:]))
    elif c in ("done", "drop", "block") and len(a) > 2:
        close(a[1], {"done": "done", "drop": "dropped", "block": "blocked"}[c], " ".join(a[2:]))
    elif c in ("done", "drop", "block"):
        die({"done": say("doneNeedsGrounds"), "drop": say("dropNeedsReason"), "block": say("blockNeedsReason")}[c])
    elif c == "resume" and len(a) > 1:
        cmd_resume(a[1])
    elif c == "carry" and len(a) > 1:
        cmd_carry(a[1])
    elif c == "edit" and len(a) > 1:
        cmd_edit(a[1], a[2:])
    elif c == "link" and len(a) > 2:
        cmd_link(a[1], a[2])
    elif c == "ls":
        cmd_ls("--all" in a)
    elif c == "show" and len(a) > 1:
        cmd_show(a[1])
    elif c == "brief":
        print(brief(load(), a[1] if len(a) > 1 else "main"))
    elif c == "pulse":
        cmd_pulse()
    elif c == "topic":
        cmd_topic(a[1:])
    else:
        print(say("usage"))
        sys.exit(2)


if __name__ == "__main__":
    main()
