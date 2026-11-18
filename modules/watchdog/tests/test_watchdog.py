"""Run as: python3 tests/test_watchdog.py scripts/watchdog.py — the watchdog's rounds with made-up bridges, time and names."""
import importlib.util, json, os, sys, tempfile
tmp = tempfile.mkdtemp()
cfg = os.path.join(tmp, "instance.json")
json.dump({"channels": {"whatsapp": {"via": "bridge"}, "qqbot": {"via": "gateway"}}}, open(cfg, "w"))
mod = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[1])))
os.environ.update(HH_WORKSPACE=tmp, HH_STATE_DIR=tmp, HH_MODULE_DIR=mod, HH_MODULE_STATE=os.path.join(tmp, "wd"), HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林",
                  HH_TZ="UTC", HH_LANG="zh", HH_BIN=tmp + "/no-hh", HH_CONFIG=cfg, HH_MODULE_CONFIG=json.dumps({"model": "claude-opus-5-5"}))
sys.path.insert(0, os.path.join(mod, "..", "_lib"))
spec = importlib.util.spec_from_file_location("W", sys.argv[1]); W = importlib.util.module_from_spec(spec); spec.loader.exec_module(W)
os.makedirs(W.D)
n = 0
def ok(cond, what):
    global n
    assert cond, what
    n += 1

UP, OFF, OUT = {"connected": True}, {"connected": False}, {"connected": False, "down": "logged out"}
class World:
    """One watchdog with its own memory: started[] is what it launched, acts[] the restarts it made (each answers `mend`)"""
    def __init__(self, mend=True):
        self.st, self.started, self.acts, self.mend, self.answers = {}, [], [], mend, True
    def round(self, now, seen, dry=False):
        return W.check(self.st, now, dry, {"whatsapp": seen}, act=lambda ch: (self.acts.append(ch) or (self.mend, "重启了桥")), start=lambda *a: self.started.append(a),
                       answers=self.answers, hhd_act=lambda: (self.acts.append("hhd") or (self.mend, "重启了 hhd")))
    def told(self): return [a[1] for a in self.started if a[0] == "notify"]

# 1 a bridge that does not answer: nothing before three minutes, a restart at three, the owner told over a channel that is up, the role told through its senses
w = World()
ok(w.round(0, None) == [] and w.round(170, None) == [] and w.acts == [], "no restart before NO_ANSWER")
ok(w.round(180, None) == [("acted", "no_answer:whatsapp", True)] and w.acts == ["whatsapp"], "a restart at three minutes")
ok(len(w.told()) == 1 and "已经救回来了" in w.told()[0] and "/cc" in w.told()[0] and w.started[0][2:] == ("whatsapp",), "the owner is told, the mended channel first")
ok("刚才你这边出了问题" in open(W.EVENTS, encoding="utf-8").read() and "[no_answer:whatsapp]" in open(W.INCIDENTS, encoding="utf-8").read(), "the role's digest line and the incident record")
ok(w.round(240, UP) == [] and w.round(300, None) == [] and w.round(480, None) == [("cooldown", "no_answer:whatsapp")], "the same trouble within half an hour: no second restart")

# 2 restarts that do not mend it: two tries, half an hour apart, then no more — one diagnosis, the owner told; neither repeated the next minute
w = World(mend=False)
w.round(0, None)
ok(w.round(180, None) == [("acted", "no_answer:whatsapp", False)] and w.round(180 + 1800, None) == [("acted", "no_answer:whatsapp", False)], "two failed restarts")
ok(w.round(180 + 3600, None) == [("gave_up", "no_answer:whatsapp")] and len(w.acts) == 2, "no third restart")
ok([a[0] for a in w.started].count("diagnose") == 1 and "试了 2 次没救回来" in w.told()[-1], "one diagnosis, and the owner knows")
before = len(w.started)
ok(w.round(180 + 3660, None) == [("gave_up", "no_answer:whatsapp")] and len(w.started) == before, "nothing new a minute later")
ok(w.round(180 + 3720, UP) == [] and "no_answer:whatsapp" not in w.st["failed_actions"], "back by itself: the count starts again")

# 3 answering but disconnected: ten minutes; a channel that says it was signed out is never restarted, the owner is told once in six hours
w = World()
ok(w.round(0, OFF) == [] and w.round(590, OFF) == [] and w.round(600, OFF) == [("acted", "not_connected:whatsapp", True)], "disconnected for ten minutes")
w = World()
ok(w.round(0, OUT) == [("told", "down:whatsapp")] and w.acts == [] and "logged out" in w.told()[0] and "重新登录" in w.told()[0], "signed out: told, not restarted")
ok(w.round(3600, OUT) == [] and w.round(6 * 3600, OUT) == [("told", "down:whatsapp")] and w.acts == [], "told again only after six hours")

# 4 the owner's command: taken from <channel>.direct/, started with the words after /cc, recorded, the file gone; a dry run leaves everything
box = os.path.join(tmp, "channels", "whatsapp.direct"); os.makedirs(box)
def put(name, text): json.dump({"channel": "whatsapp", "text": text, "senderId": "+614000001", "isGroup": False}, open(os.path.join(box, name), "w"))
put("0000000001-000000.json", "/cc 看看她怎么了"); put("0000000002-000000.json", "  ／CC")
w = World()
ok(w.round(0, UP, dry=True) == [("cc", "whatsapp", "看看她怎么了"), ("cc", "whatsapp", "阿青好像出问题了，帮我看看是什么问题（先诊断，别急着改）")] and w.started == [] and len(os.listdir(box)) == 2, "a dry run starts nothing")
w.round(0, UP)
ok(w.started == [("cc", "whatsapp", "看看她怎么了"), ("cc", "whatsapp", "阿青好像出问题了，帮我看看是什么问题（先诊断，别急着改）")] and os.listdir(box) == [], "both started in order, the files gone")
ok("[cc] whatsapp: 看看她怎么了" in open(W.INCIDENTS, encoding="utf-8").read() and "+614000001" not in open(W.INCIDENTS, encoding="utf-8").read(), "recorded with the channel and the words, not the number")
ok([bool(W.OWNER_COMMAND.match(t)) for t in ("/cc", "／cc 修", "/CC\n照诊断修", "/ccx", "说到 /cc")] == [True, True, True, False, False], "the bridge's own rule for what a command is")

# 5 the senses collector gets each line once
import io, contextlib
def events():
    b = io.StringIO()
    with contextlib.redirect_stdout(b): W.events()
    return b.getvalue().splitlines()
ok(len(events()) == 2 and events() == [], "two lines so far (cases 1 and 3), then nothing new")

# 6 a Claude Code session: the model is named, only the tools listed and no account connectors; a Fable model is refused
calls = []
class R: returncode = 0; stdout = "查过了，是桥的登录过期。"
real_run = W.subprocess.run   # the tests below put their own in its place
exe = os.path.join(tmp, "claude-on-path"); open(exe, "w").write("#!/bin/sh\n"); os.chmod(exe, 0o755)
W.shutil.which = lambda name: exe if name == "claude" else None
W.subprocess.run = lambda argv, **kw: calls.append((argv, kw)) or R()
text = W.claude("提示", ["--tools", "Read"], 5, os.path.join(tmp, "out.md"))
argv, kw = calls[0]
ok(argv[:5] == [exe, "--print", "--model", "claude-opus-5-5", "--strict-mcp-config"] and argv[5:] == ["--tools", "Read"] and kw["input"] == "提示" and kw["cwd"] == tmp and kw["env"]["CLAUDE_CODE_TMPDIR"] == os.path.join(tmp, "tmp"), "how claude is started")
ok(kw["env"]["USER"] == kw["env"]["LOGNAME"] == __import__("pwd").getpwuid(os.getuid()).pw_name, "the session is given the user's name, whatever environment the round was started in")
ok(text == "查过了，是桥的登录过期。" and open(os.path.join(tmp, "out.md"), encoding="utf-8").read().strip() == text, "its words are kept in the file")
W.hh.config["model"] = "claude-FABLE-5-2"
try: W.claude("x", [], 5, os.path.join(tmp, "o2.md")); ok(False, "a Fable model must be refused")
except W.NotStarted as e: ok("Fable" in str(e), "a Fable model is refused")
W.hh.config["model"] = "claude-opus-5-5"
ok("老林" in W.prompt_of("cc", words="看看") and "看看" in W.prompt_of("cc", words="看看") and "[no_answer:whatsapp]" in W.prompt_of("diagnose", kind="no_answer:whatsapp", what="x"), "the prompts take the role's names and the words")

# 7 telling the owner: a connected bridge first, then the channels that go another way, a bridge that is not connected last
tried = []
class No: returncode = 1
W.subprocess.run = lambda argv, **kw: tried.append(argv[argv.index("--channel") + 1]) or No()
ok(W.notify("x", ["whatsapp"]) is None and tried == ["whatsapp", "qqbot"], "the connected bridge is tried first")
tried.clear()
ok(W.notify("x", []) is None and tried == ["qqbot", "whatsapp"], "the bridge that is not connected is tried last")

# 8 the claude command: the config's, else the one on PATH, else ~/.local/bin/claude — a launchd job's PATH has neither
os.environ["HOME"] = tmp
W.shutil.which = lambda name: None
try: W.session(); ok(False, "no claude anywhere must not start")
except W.NotStarted as e: ok(os.path.join(tmp, ".local/bin/claude") in str(e), "nowhere: it says where it looked")
os.makedirs(os.path.join(tmp, ".local/bin")); home = os.path.join(tmp, ".local/bin/claude"); open(home, "w").write("#!/bin/sh\n"); os.chmod(home, 0o755)
ok(W.session() == (home, "claude-opus-5-5"), "not on PATH, not in the config: the installer's place")
W.hh.config["claude"] = exe
ok(W.session()[0] == exe, "the config's wins")
timer = {**os.environ, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONPATH": os.path.join(mod, "..", "_lib")}   # as launchd starts the round: nothing of a login shell's PATH
ready = lambda: real_run([sys.executable, sys.argv[1], "ready"], env=timer, capture_output=True, text=True)
r = ready()
ok(r.returncode == 0 and json.loads(r.stdout) == {"claude": home, "model": "claude-opus-5-5"}, "the script itself, under a timer's environment: " + r.stderr[-300:])
os.remove(home)
r = ready()
ok(r.returncode == 1 and "modules.watchdog.claude" in r.stderr, "and it says what to write when there is none")

# 9 a command or a diagnosis that cannot start: one line in the incidents with the reason, the owner told, no "received"
del W.hh.config["claude"]
sent = []
class Sent: returncode = 0
W.subprocess.run = lambda argv, **kw: sent.append(argv) or Sent()
W.cc("whatsapp", "看看")
ok(len(sent) == 1 and sent[0][1:3] == ["send", "老林"] and "没起来" in sent[0][3] and "modules.watchdog.claude" in sent[0][3] and "收到" not in sent[0][3], "the owner hears why, on the channel the command came by")
ok("[cc] whatsapp: Claude 没起来" in open(W.INCIDENTS, encoding="utf-8").read() and not os.path.exists(os.path.join(W.D, "cc.lock")), "recorded, and the next command is not locked out")
told = []
W.notify = lambda text, up: told.append(text)
W.status = lambda ch: None
W.diagnose("no_answer:whatsapp", "桥没有回应")
ok(len(told) == 1 and "没起来" in told[0] and "/cc" not in told[0] and "[no_answer:whatsapp] Claude 没起来" in open(W.INCIDENTS, encoding="utf-8").read(), "a diagnosis that cannot start: recorded and told, without the hint to send /cc")

# 10 the owner is not answered: three private messages within twenty minutes, all taken, nothing sent since the first —
#    the owner is told and nothing is restarted; one diagnosis when it is still so half an hour later
w = World()
wrote = lambda now, out=None: {"connected": True, "waiting": 0, "ownerIn": [now - 900, now - 400, now - 100], "lastOut": out}
ok(w.round(5000, {"connected": True, "waiting": 0, "ownerIn": [3700, 4600, 4900], "lastOut": None}) == [], "two within twenty minutes are not yet a pattern")
ok(w.round(5000, wrote(5000, out=4500)) == [], "something went out after the first of them")
ok(w.round(5000, wrote(5000)) == [("told", "no_reply:whatsapp")] and w.acts == [] and "/cc" in w.told()[-1] and "3 条" in w.told()[-1], "told, with the way to call Claude; nothing restarted")
ok(w.round(5060, wrote(5060)) == [] and w.round(5000 + 1800, wrote(5000 + 1800)) == [("diagnose", "no_reply:whatsapp")] and [a[0] for a in w.started].count("diagnose") == 1,
   "not told again a minute later; still so after half an hour: one diagnosis")

# 11 hhd: no answer on its control socket, or a message left untaken, for three minutes — restarted; five minutes while the
#    machine is under heavy work; not while a deploy's own watchdog is still judging the new start
w = World(); w.answers = False
ok(w.round(0, UP) == [] and w.round(170, UP) == [] and w.round(180, UP) == [("acted", "hhd", True)] and w.acts == ["hhd"] and "hhd" in w.told()[-1], "three minutes without an answer")
w = World()
ok(w.round(0, {"connected": True, "waiting": 200}) == [("acted", "hhd", True)], "it answers, but a message has waited more than three minutes")
busy = os.path.join(tmp, "busy"); open(busy, "w").close(); W.hh.config["busyFile"] = busy
w = World(); w.answers = False; w.round(0, UP)
ok(w.round(200, UP) == [] and w.round(300, UP) == [("acted", "hhd", True)], "under heavy work it gets five minutes")
del W.hh.config["busyFile"]
os.makedirs(os.path.join(tmp, "repair"))
mark = lambda f, commit, t: json.dump({"commit": commit, "t": t}, open(os.path.join(tmp, "repair", f), "w"))
mark("boot.json", "new", "2026-01-01T00:02:00Z"); mark("healthy.json", "old", "2026-01-01T00:01:00Z")
w = World(); w.answers = False; w.round(0, UP)
ok(w.round(180, UP) == [("deploying", "hhd")] and w.acts == [], "a deploy restarted it and has not called this start healthy yet: left alone")
mark("healthy.json", "new", "2026-01-01T00:03:00Z")
ok(w.round(240, UP) == [("acted", "hhd", True)], "once that start is healthy the watchdog is on again")
import socket as so, threading
srv = so.socket(so.AF_UNIX); srv.bind(os.path.join(tmp, "hh.sock")); srv.listen(1)
def answer_once():
    c, _ = srv.accept(); answer_once.asked = c.makefile("r").readline(); c.sendall(b'{"ok":true,"data":{"ok":true}}\n'); c.close()
threading.Thread(target=answer_once, daemon=True).start()
ok(W.hhd_answers() is True and json.loads(answer_once.asked) == {"cmd": "ping"}, "the ping hhd's control socket understands")
srv.close(); os.remove(os.path.join(tmp, "hh.sock"))
ok(W.hhd_answers() is False, "nothing there: no answer")

print("ok %d" % n)
