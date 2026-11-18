#!/usr/bin/env python3
"""watchdog.py — keeps the role's bridged channels reachable, and takes the owner's /cc. No model in the loop.

Run every minute by the module's standalone timer (so it runs when hhd is stuck). It only does fixed, safe things:
it changes no code and no config; the cause is left to whoever the owner assigns.

  watchdog.py check [--dry-run]         one round (dry run: print what it would do, change nothing)
  watchdog.py events                    for the senses collector: what it did since last asked, one JSON line each
  watchdog.py status                    what it remembers and the last incidents
  watchdog.py cc <channel> <words…>     the owner's command: one Claude Code session with the owner's words, answered on that channel
  watchdog.py notify <text> [channel…]  tell the owner (the channels named are known to be connected: they are tried first)
  watchdog.py diagnose <kind> <what>    a read-only Claude Code session that looks for the cause and reports to the owner
  watchdog.py ready                     which claude command and model a session would start with; exit 1 and why when none can

One round, for every channel whose config says via "bridge":
  the bridge does not answer its status for NO_ANSWER              -> restart the bridge (hh channels restart <channel>)
  it answers, but has not been connected for NOT_CONNECTED          -> restart the bridge
  it says why it will not come back (the app logged it out)         -> nothing to restart: tell the owner, once per ESCALATE_COOLDOWN
  the same trouble was acted on within ACTION_COOLDOWN              -> nothing
  the same trouble was not mended MAX_FAILED_ACTIONS times in a row -> no more restarts: one diagnosis, tell the owner
  the owner's command waits in <channel>.direct/ (the bridge put it there, apart from the inbox) -> start `cc`
And for the role itself:
  hhd does not answer a ping on its control socket, or leaves a message in a connected bridge's inbox, for NO_ANSWER
  (HHD_PATIENT while the file named by busyFile exists: the machine is under heavy work)  -> restart hhd by its launchd label;
                                                    not while a deploy's own watchdog is still judging the new start
  the owner wrote FAIL_COUNT times within FAIL_WINDOW, hhd took them all, nothing has been sent since the first
                                                 -> tell the owner, restart nothing; one diagnosis if it lasts half an hour

The thresholds are the ones the first role's watchdog has run with since 2026-10-14.
"""
import json, os, pwd, re, shutil, socket, subprocess, sys, time
from hh_env import hh, words

say = words(__file__)

NO_ANSWER = 180
NOT_CONNECTED = 600
HHD_PATIENT = 300
FAIL_WINDOW, FAIL_COUNT = 1200, 3
ACTION_COOLDOWN = 1800
MAX_FAILED_ACTIONS = 2
ESCALATE_COOLDOWN = 6 * 3600
GAVE_UP_NOTE = 3 * 3600
CC_TIMEOUT, DIAGNOSE_TIMEOUT = 2400, 900
REPORT_CHARS = 3500

D = hh.module_state
STATE = os.path.join(D, "state.json")
INCIDENTS = os.path.join(D, "incidents.log")
EVENTS = os.path.join(D, "events.jsonl")
CURSOR = os.path.join(D, "events.cursor")
ME = os.path.abspath(__file__)
OWNER_COMMAND = re.compile(r"\s*[/／]cc(?![A-Za-z0-9_])\s*(.*)", re.S | re.I)   # the bridge's rule (src/channels/bridge.ts), with what follows


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return default


def channels():
    """(the channels that go through a bridge, every channel) of the role's config"""
    table = load(os.environ.get("HH_CONFIG") or "", {}).get("channels") or {}   # no instance file given (a check outside any role): no channel
    return [n for n, c in table.items() if c.get("via") == "bridge"], list(table)


def status(channel):
    """What the channel's bridge says of itself (docs/contracts/channels.md: {"op":"status"}); None when it does not answer"""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(os.path.join(hh.state_dir, "channels", channel + ".sock"))
        s.sendall(b'{"op":"status"}\n')
        return json.loads(s.makefile("r", encoding="utf-8").readline())
    except (OSError, ValueError):
        return None
    finally:
        s.close()


def hhd_answers():
    """Whether hhd answers a ping on its control socket within five seconds"""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(os.path.join(hh.state_dir, "hh.sock"))
        s.sendall(b'{"cmd":"ping"}\n')
        return bool(json.loads(s.makefile("r", encoding="utf-8").readline()).get("ok"))
    except (OSError, ValueError):
        return False
    finally:
        s.close()


def restart_hhd():
    """Restart hhd by its job label (launchd on macOS, a systemd user unit on Linux) and wait for it to answer. (mended?, what was done)"""
    label = (load(os.environ.get("HH_CONFIG") or "", {}).get("launchd") or {}).get("hhd") or "ai.hh.hhd"
    restart = ["launchctl", "kickstart", "-k", "gui/%d/%s" % (os.getuid(), label)] if sys.platform == "darwin" else ["systemctl", "--user", "restart", label + ".service"]
    subprocess.run(restart, capture_output=True, timeout=30)
    for _ in range(15):
        time.sleep(2)
        if hhd_answers():
            return True, say("hhdRestarted")
    return False, say("hhdRestartFailed")


def settled():
    """False in the minutes after a deploy restarted hhd, until the deploy's own watchdog has recorded that start healthy:
    it judges the new version, and takes it back, by itself"""
    boot, ok = (load(os.path.join(hh.state_dir, "repair", f), None) for f in ("boot.json", "healthy.json"))
    return not boot or bool(ok and ok.get("commit") == boot.get("commit") and str(ok.get("t", "")) >= str(boot.get("t", "")))


def restart(channel):
    """Stop the bridge by its own pid record (launchd starts it again) and wait for it to connect. (mended?, what was done)"""
    subprocess.run([hh.hh_bin, "channels", "restart", channel], capture_output=True, timeout=30)
    for _ in range(15):
        time.sleep(2)
        if (status(channel) or {}).get("connected"):
            return True, say("restarted", channel=channel)
    return False, say("restartFailed", channel=channel)


def notify(text, up):
    """A desktop notification, and a message to the owner over the first channel that takes it: the connected bridges
    first, a bridge that is not connected last (a send through it would wait a minute for nothing)"""
    if shutil.which("osascript"):
        subprocess.run(["osascript", "-e", "display notification %s with title %s" % (json.dumps(text), json.dumps(say("title")))], capture_output=True, timeout=10)
    bridged, every = channels()
    for ch in sorted(every, key=lambda c: (c not in up, c in bridged)):
        if subprocess.run([hh.hh_bin, "send", hh.owner, text, "--channel", ch], capture_output=True, timeout=90).returncode == 0:
            return ch
    return None


def record(kind, what, did=""):
    with open(INCIDENTS, "a", encoding="utf-8") as f:
        f.write("%s [%s] %s%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), kind, what, "; " + did if did else ""))


def tell_role(text):
    """For the role itself, through its senses: not a wake-up of its own, a line for the day's digest"""
    with open(EVENTS, "a", encoding="utf-8") as f:
        f.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")


def detached(*argv):
    """Start one of this script's own commands and do not wait: a round must end within the timer's minute. What it prints
    and what it dies of stay in detached.log beside the incidents."""
    with open(os.path.join(D, "detached.log"), "a") as log:
        subprocess.Popen([sys.executable, ME, *argv], stdout=log, stderr=log, start_new_session=True)


def due(st, key, kind, now, every):
    """Whether `every` seconds have gone by since this was last done for this trouble (never done: yes)"""
    last = st.setdefault(key, {}).get(kind)
    return last is None or now - last >= every


def troubles(st, now, seen, answers):
    """What is wrong now: [(kind, channel, what in words)]. Keeps since when each channel has not answered or not been
    connected, and since when hhd has not answered (answers: whether it does now)."""
    na, nc, out = st.setdefault("no_answer", {}), st.setdefault("not_connected", {}), []
    for ch, s in seen.items():
        if s is None:
            nc.pop(ch, None)
            since = na.setdefault(ch, now)
            if now - since >= NO_ANSWER:
                out.append(("no_answer:" + ch, ch, say("noAnswer", channel=ch, minutes=int((now - since) / 60))))
            continue
        na.pop(ch, None)
        if s.get("down"):
            nc.pop(ch, None)
            out.append(("down:" + ch, ch, say("loggedOut", channel=ch, why=s["down"])))
        elif not s.get("connected"):
            since = nc.setdefault(ch, now)
            if now - since >= NOT_CONNECTED:
                out.append(("not_connected:" + ch, ch, say("notConnected", channel=ch, minutes=int((now - since) / 60))))
        else:
            nc.pop(ch, None)
            for k in ("no_answer:", "not_connected:"):   # it is back: the next trouble counts its failed restarts from zero
                st.get("failed_actions", {}).pop(k + ch, None)
            wrote = [t for t in s.get("ownerIn") or [] if now - t <= FAIL_WINDOW]
            if len(wrote) >= FAIL_COUNT and not s.get("waiting") and (s.get("lastOut") or 0) < wrote[0]:
                out.append(("no_reply:" + ch, ch, say("noReply", channel=ch, n=len(wrote), minutes=int((now - wrote[0]) / 60))))
    untaken = max([s.get("waiting") or 0 for s in seen.values() if s and s.get("connected")] or [0])
    if answers:
        st.pop("hhd_silent", None)
    silent = max(untaken, 0 if answers else now - st.setdefault("hhd_silent", now))
    busy = hh.config.get("busyFile")
    if silent >= (HHD_PATIENT if busy and os.path.exists(busy) else NO_ANSWER):
        out.insert(0, ("hhd", None, say("hhdSilent", minutes=int(silent / 60))))
    elif answers and not untaken:
        st.get("failed_actions", {}).pop("hhd", None)
    return out


def check(st, now, dry=False, seen=None, act=restart, start=detached, answers=None, hhd_act=restart_hhd):
    """One round. seen, act, start, answers, hhd_act are replaced in the tests. Returns what it did, one tuple each."""
    tell = lambda text, up: start("notify", text, *up)
    bridged, _ = channels()
    seen = {ch: status(ch) for ch in bridged} if seen is None else seen
    up = [ch for ch, s in seen.items() if s and s.get("connected")]
    done = []
    for ch in bridged:   # the owner's commands first: they are the way in when everything else is broken
        box = os.path.join(hh.state_dir, "channels", ch + ".direct")
        for f in sorted(os.listdir(box)) if os.path.isdir(box) else []:
            if not f.endswith(".json") or f.startswith("."):
                continue
            m = OWNER_COMMAND.match(load(os.path.join(box, f), {}).get("text") or "")
            words = (m.group(1).strip() if m else "") or say("ccDefault")
            done.append(("cc", ch, words))
            if not dry:
                record("cc", "%s: %s" % (ch, words))
                start("cc", ch, words)
                os.remove(os.path.join(box, f))
    for kind, ch, what in troubles(st, now, seen, hhd_answers() if answers is None else answers):
        if kind.startswith("no_reply:"):   # hhd takes the messages and nothing goes out: the cause is on the brain's side, a restart would only lose its work
            if due(st, "told", kind, now, ESCALATE_COOLDOWN):
                done.append(("told", kind))
                if not dry:
                    st["told"][kind] = now
                    record(kind, what)
                    tell(what + say("ccHint"), up)
            elif now - st["told"][kind] >= ACTION_COOLDOWN and due(st, "escalated", kind, now, ESCALATE_COOLDOWN):
                done.append(("diagnose", kind))
                if not dry:
                    st["escalated"][kind] = now
                    start("diagnose", kind, what)
            continue
        if kind == "hhd" and not settled():
            done.append(("deploying", kind))
            continue
        if kind.startswith("down:"):
            if due(st, "told", kind, now, ESCALATE_COOLDOWN):
                done.append(("told", kind))
                if not dry:
                    st["told"][kind] = now
                    record(kind, what)
                    tell(what, up)
            continue
        if not due(st, "last_action", kind, now, ACTION_COOLDOWN):
            done.append(("cooldown", kind))
            continue
        failed = st.setdefault("failed_actions", {}).get(kind, 0)
        if failed >= MAX_FAILED_ACTIONS:
            done.append(("gave_up", kind))
            if dry:
                continue
            if due(st, "gave_up_told", kind, now, GAVE_UP_NOTE):
                st["gave_up_told"][kind] = now
                tell(say("gaveUp", what=what, n=failed) + say("ccHint"), up)
            if due(st, "escalated", kind, now, ESCALATE_COOLDOWN):
                st["escalated"][kind] = now
                start("diagnose", kind, what)
            continue
        if dry:
            done.append(("would_act", kind))
            continue
        ok, did = hhd_act() if kind == "hhd" else act(ch)
        st["last_action"][kind] = now
        st["failed_actions"][kind] = 0 if ok else failed + 1
        record(kind, what, did + ("" if ok else " — " + say("notMended")))
        tell(say("actedOk" if ok else "actedFailed", what=what, did=did) + say("ccHint"), up + [ch] if ok and ch else up)
        if ok:
            tell_role(say("tellRole", what=what, did=did))
        done.append(("acted", kind, ok))
    return done


class NotStarted(Exception):
    """A Claude Code session that cannot be started; its text says why, for the incident record and the owner"""


def session():
    """(the claude command, the model) a session starts with. The model is named, never a default. The command: the
    config's, else the one on PATH, else where its installer puts it — the round runs under launchd, whose PATH has neither."""
    model = hh.config.get("model") or "claude-opus-5-5"
    if "fable" in model.lower():
        raise NotStarted(say("isFable", model=model))
    exe = hh.config.get("claude") or shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
    if not os.access(exe, os.X_OK):
        raise NotStarted(say("noClaude", exe=exe))
    return exe, model


def claude(prompt, flags, timeout, out):
    """One Claude Code session with the prompt on stdin; its last message goes to the file `out`"""
    exe, model = session()
    # its scratch files under this role's state, as HH's own sessions keep theirs; and the user's name, by which Claude
    # Code finds its login: launchd gives it, a round started with a bare environment has none ("Not logged in")
    me = pwd.getpwuid(os.getuid()).pw_name
    env = {**os.environ, "USER": me, "LOGNAME": me, "CLAUDE_CODE_TMPDIR": os.path.join(hh.state_dir, "tmp")}
    try:
        r = subprocess.run([exe, "--print", "--model", model, "--strict-mcp-config", *flags], input=prompt, capture_output=True, text=True, timeout=timeout, cwd=hh.workspace, env=env)
        text = r.stdout.strip() or say("noOutput", code=r.returncode)
    except subprocess.TimeoutExpired:
        text = say("noOutput", code="timeout")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return text


def prompt_of(name, **kw):
    for f in ("%s.%s.md" % (name, hh.lang), name + ".md"):
        p = os.path.join(hh.module_dir, "prompts", f)
        if os.path.exists(p):
            return open(p, encoding="utf-8").read().format(
                me=hh.me, owner=hh.owner, workspace=hh.workspace, state_dir=hh.state_dir, incidents=INCIDENTS,
                background=hh.config.get("background") or "", **kw)


def cc(channel, words):
    """The owner's command. One at a time; the owner is told at the start and at the end, on the channel the command came by."""
    reply = lambda text: subprocess.run([hh.hh_bin, "send", hh.owner, text, "--channel", channel], capture_output=True, timeout=90)
    lock = os.path.join(D, "cc.lock")
    try:
        os.mkdir(lock)
    except FileExistsError:
        if time.time() - os.stat(lock).st_mtime < 3600:
            reply(say("ccBusy"))
            return
    try:
        session()   # one that cannot start says so at once, instead of "received" and then nothing
        reply(say("ccReceived", words=words))
        out = os.path.join(D, time.strftime("cc-%Y%m%d-%H%M%S.md"))
        text = claude(prompt_of("cc", words=words),
                      ["--max-turns", "120", "--permission-mode", "acceptEdits", "--tools", "Read", "Write", "Edit", "Grep", "Glob", "Bash",
                       "--allowedTools", "Read", "Write", "Edit", "Grep", "Glob", "Bash"], CC_TIMEOUT, out)
        reply(say("ccDone", report=text[:REPORT_CHARS], file=out))
    except NotStarted as e:
        record("cc", "%s: %s" % (channel, say("notStarted", why=e)))
        reply(say("ccFailed", why=e))
    finally:
        os.rmdir(lock)


def diagnose(kind, what):
    """Look for the cause, change nothing, report to the owner"""
    out = os.path.join(D, time.strftime("diagnosis-%Y%m%d-%H%M%S.md"))
    read_only = ["Read", "Grep", "Glob"] + ["Bash(%s:*)" % c for c in ("tail", "head", "grep", "jq", "cat", "ls", "wc", "launchctl list", "launchctl print", "date", "pgrep", "ps", "sysctl", "memory_pressure")]
    bridged, _ = channels()
    up = [ch for ch in bridged if (status(ch) or {}).get("connected")]
    try:
        text = claude(prompt_of("diagnose", kind=kind, what=what), ["--max-turns", "40", "--tools", "Read", "Grep", "Glob", "Bash", "--allowedTools", *read_only], DIAGNOSE_TIMEOUT, out)
    except NotStarted as e:
        record(kind, say("notStarted", why=e))
        notify(say("diagnosisFailed", why=e), up)
        return
    notify(say("diagnosis", report=text[:REPORT_CHARS], file=out) + say("ccHint"), up)


def events():
    lines = open(EVENTS, encoding="utf-8").read().splitlines() if os.path.exists(EVENTS) else []
    n = int(open(CURSOR).read().strip() or 0) if os.path.exists(CURSOR) else 0
    for l in lines[n:]:
        print(l)
    with open(CURSOR, "w") as f:
        f.write(str(len(lines)))


def main(a):
    os.makedirs(D, exist_ok=True)
    if a[:1] == ["check"]:
        st, dry = load(STATE, {}), "--dry-run" in a
        try:
            done = check(st, time.time(), dry)
        finally:
            if not dry:
                with open(STATE + ".new", "w", encoding="utf-8") as f:
                    json.dump(st, f, ensure_ascii=False, indent=1)
                os.replace(STATE + ".new", STATE)
        if dry:
            print(json.dumps(done, ensure_ascii=False))
    elif a[:1] == ["events"]:
        events()
    elif a[:1] == ["status"]:
        bridged, _ = channels()
        print(json.dumps({"channels": {ch: status(ch) for ch in bridged}, "state": load(STATE, {})}, ensure_ascii=False, indent=1))
        if os.path.exists(INCIDENTS):
            print("".join(open(INCIDENTS, encoding="utf-8").readlines()[-5:]), end="")
    elif a[:1] == ["notify"] and len(a) >= 2:
        notify(a[1], a[2:])
    elif a[:1] == ["cc"] and len(a) >= 3:
        cc(a[1], " ".join(a[2:]))
    elif a[:1] == ["diagnose"] and len(a) >= 3:
        diagnose(a[1], " ".join(a[2:]))
    elif a[:1] == ["ready"]:
        try:
            print(json.dumps(dict(zip(("claude", "model"), session()))))
        except NotStarted as e:
            sys.exit(str(e))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
