#!/usr/bin/python3
"""helper — Claude Code sessions the role starts, talks to while they work, and reads back: a session is started or
carried on with `helper send`, works in the background and wakes the role through the senses when it has answered.
`helper help` prints the commands in the role's language (the entry "usage" of texts.*.json).
"""
import contextlib
import datetime
import fcntl
import glob
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid

# hooks run this file with python -I (no PYTHONPATH): find hh_env next to the modules
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_lib"))
from hh_env import hh, words  # noqa: E402

say = words(__file__)

HOME = os.environ.get("CC_HOME") or pwd.getpwuid(os.getuid()).pw_dir  # 按真实用户算家目录：sudo -u <角色> 不带 -H 也对
# 帮手的工作目录（模块配置 tasksDir）和会话记录（sessionsDir，默认模块的状态目录）
TASKS = hh.config.get("tasksDir") or os.path.join(HOME, "agent-tasks")
DB = hh.config.get("sessionsDir") or os.path.join(hh.module_state, "sessions")
WS = hh.workspace
CLAUDE = os.environ.get("CC_CLAUDE_BIN") or shutil.which("claude") or os.path.join(HOME, ".local/bin/claude")  # 环境变量只给维护者测试用
JOBS = os.environ.get("CC_JOBS_DIR") or os.path.join(HOME, ".claude/jobs")  # 环境变量只给维护者测试用
HOOK = os.environ.get("CC_HOOK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "cc_inbox_hook.py")
SENSES = os.environ.get("CC_SENSES", "senses")   # 感官模块的命令；CC_SENSES 只给维护者测试用
EVENTS = os.environ.get("CC_EVENTS") or os.path.join(DB, "events.jsonl")  # CC_EVENTS 只给维护者测试用
NODE_BIN = os.path.dirname(os.environ.get("HH_NODE") or shutil.which("node") or "/usr/local/bin/node")   # the node HH runs on
HH = os.environ.get("CC_HH_BIN") or hh.hh_bin  # 环境变量只给维护者测试用
HELPER_NOTES_S = 10            # 问 HH 该附哪几页笔记最多等几秒（HH 那边给判断 4 秒）
# OpenClaw 的 leak-guard 插件里给访客任务定规则的那个程序（模块配置 leakGuardDir）；没有就挡下访客任务
LG = os.environ.get("CC_LEAK_GUARD") or hh.config.get("leakGuardDir", "")  # 环境变量只给维护者测试用
REGISTRY = os.path.join(WS, "memory/people/registry.json")
STUCK_MIN = 20
BG_GRACE = 90                   # 这一轮起步后多少秒内不判「后台任务已经没了」（刚起、刚重拉时 job 文件还是上一轮的）
BG_ENDED = ("done", "stopped")  # ~/.claude/jobs/<id>/state.json 的 state 取值（10-31 采样：done / stopped / working；blocked 见 blocked_reply）
QUOTA_RE = re.compile(r"usage limit|limit reached|rate.?limit|out of (extra )?usage|5-hour limit|weekly limit|session limit", re.I)


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def die(msg):
    print(msg)
    sys.exit(1)


def p(name, ext):
    return os.path.join(DB, f"{name}.{ext}")


def load(name):
    try:
        with open(p(name, "json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(name, m, expected=None):
    os.makedirs(DB, exist_ok=True)
    with open(p(name, "lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if expected is not None:
            current = load(name)
            if any(current.get(k) != v for k, v in expected.items()):
                return False
        tmp = p(name, "json.tmp")
        with open(tmp, "w") as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p(name, "json"))
    return True


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def read_job(bid):
    """~/.claude/jobs/<bid>/state.json；读不到返回 None（调用方不能把读不到当成任务没了）。"""
    try:
        with open(os.path.join(JOBS, bid, "state.json"), encoding="utf-8") as f:
            job = json.load(f)
    except (OSError, ValueError, TypeError):
        return None
    return job if isinstance(job, dict) else None


def bg_job_ended(m):
    """后台任务确定已经结束了（done / stopped）返回 True。读不到、状态没见过、刚起步、job 属于别的会话：都返回 False，
    沿用本地 json 的判断。cc-bugs 10-31：本地标着 running 但任务早停了，busy 恒为 True，插话递进没人读的 inbox。"""
    bid = m.get("bg_id")
    if not bid or time.time() - m.get("started", 0) <= BG_GRACE:
        return False
    job = read_job(bid)
    if not job or job.get("sessionId") not in (None, m.get("session_id")):
        return False
    # #0004：launch_bg 自己 stop 旧进程时 job 文件被写成 stopped，续上的进程第一次请求回来前不会改它（上下文大时要 100 秒以上）。
    # 这一轮的进程起来之前写的 job 文件是上一轮留下的，不能当这一轮结束的证据。
    since = m.get("bg_since") or m.get("started", 0)
    if iso_time(job.get("updatedAt")) <= since:
        return False
    return job.get("state") in BG_ENDED


def busy(m):
    if m.get("state") != "running":
        return False
    if m.get("pid"):
        return alive(m["pid"])
    return m.get("mode") == "bg" and not bg_job_ended(m)


@contextlib.contextmanager
def inbox_lock(name):
    """send 的「判断 busy → 写 inbox」和 Stop 钩子的「读 inbox → 置 idle」用同一把锁（不是 save() 里那把 .lock，
    避免嵌套死锁；顺序固定：先 inbox.lock，再 save() 的 .lock）。"""
    os.makedirs(DB, exist_ok=True)
    with open(p(name, "inbox.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def check_name(name):
    # 不许以「-」开头：以前 send --help … 会开出一个叫「--help」的帮手（#0050，11-13 改）
    if not re.fullmatch(r"[\w一-鿿][\w一-鿿-]*", name):
        die(say("badName"))
    return name


def transcript(m):
    sid = m.get("session_id")
    hits = glob.glob(os.path.join(HOME, ".claude/projects/*", f"{sid}.jsonl")) if sid else []
    return hits[0] if hits else None


BG_ID_RE = re.compile(r"(?:claude stop|backgrounded ·) ([0-9a-f]{6,})")
DROP_ENV = ("CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION",
            "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND", "OPENCLAW_LAUNCHD_LABEL", "OPENCLAW_GATEWAY_SERVICE_PID",
            "OPENCLAW_SERVICE_MANAGED_ENV_KEYS", "OPENCLAW_SYSTEMD_UNIT", "OPENCLAW_SHELL", "XPC_SERVICE_NAME",
            "__PYVENV_LAUNCHER__")


def claude_env(name=None):
    """跑 claude 用的环境：继承原来的，但去掉网关服务自己的标记和会冒充入口的变量；不碰 CLAUDE_CODE_ENTRYPOINT，入口由 claude 自己定。"""
    env = {k: v for k, v in os.environ.items() if k not in DROP_ENV and not k.startswith("OPENCLAW_WINDOWS_")}
    env["HOME"] = HOME
    env["PATH"] = ":".join([NODE_BIN, os.path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
                            "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    if name:
        env["CC_SESSION"] = os.path.join(DB, name)
    return env


def agents():
    try:
        r = subprocess.run([CLAUDE, "agents", "--json"], capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL, env=claude_env())
        return json.loads(r.stdout or "[]")
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


def bg_entry(m):
    sid = m.get("session_id")
    return next((a for a in agents() if a.get("sessionId") == sid), None) if sid else None


def runner_log(name, text):
    with open(p(name, "runner.log"), "a") as f:
        f.write(f"{now()} {text}\n")


# Claude Code starts a background session only in a directory whose trust prompt someone has accepted (a directory under
# an accepted one counts). A role's tasks directory is new, so until its owner accepts once, every turn runs as claude -p.
UNTRUSTED = os.path.join(DB, "untrusted")   # the directory to accept, written when a background launch is refused for it


def note_trust(d):
    """d: the directory a background launch was just refused in; None: a background launch worked"""
    if d:
        os.makedirs(DB, exist_ok=True)
        tasks = os.path.abspath(TASKS)
        with open(UNTRUSTED, "w", encoding="utf-8") as f:
            f.write(tasks if (d + os.sep).startswith(tasks + os.sep) else d)   # accepting the tasks directory covers every helper under it
    elif os.path.exists(UNTRUSTED):
        os.remove(UNTRUSTED)


def untrusted():
    try:
        return open(UNTRUSTED, encoding="utf-8").read().strip()
    except OSError:
        return ""


def trusted_guest(gid):
    """registry 里 trust=trusted 的访客才能派任务。"""
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            p = json.load(f).get(gid)
    except (OSError, ValueError):
        return False
    return isinstance(p, dict) and p.get("privacy") not in (None, "owner") and p.get("trust") == "trusted"


def lg_node(args, stdin=None):
    """跑 leak-guard 的 guest-cli.mjs；失败抛异常（调用方按挡下处理）。"""
    r = subprocess.run([os.path.join(NODE_BIN, "node"), os.path.join(LG, "guest-cli.mjs"), *args], input=stdin,
                       capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-300:] or say("exitCode", returncode=r.returncode))
    return json.loads(r.stdout or "{}")


def guest_settings(m, settings):
    """访客任务：加 sandbox（系统级读限制）、内置工具的 deny 规则、PreToolUse 守卫。拿不到规则就不开这一轮。"""
    me = os.path.abspath(__file__)
    try:
        sb = lg_node(["sandbox", m["guest"], m["dir"]])
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
        die(say("guestRulesFailed", e=e))
    settings["sandbox"] = sb["sandbox"]
    perms = settings.setdefault("permissions", {})
    perms["deny"] = sb["deny"]
    perms.pop("additionalDirectories", None)
    settings.setdefault("hooks", {})["PreToolUse"] = [
        {"matcher": "*", "hooks": [{"type": "command", "command": f"{sys.executable} -I {me} _hook guard"}]}]
    return settings


def write_settings(name, m):
    me = os.path.abspath(__file__)
    hooks = {"PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": f"{sys.executable} -I {HOOK}"}]}]}
    perms = {"allow": m.get("allow", [])}
    if m.get("mode") == "bg":
        hooks["Stop"] = [{"hooks": [{"type": "command", "command": f"{sys.executable} -I {me} _hook stop"}]}]
        hooks["StopFailure"] = [{"hooks": [{"type": "command", "command": f"{sys.executable} -I {me} _hook stopfail"}]}]
        perms["defaultMode"] = "auto"
        if m.get("add_dirs"):
            perms["additionalDirectories"] = m["add_dirs"]
    path = p(name, "settings.json")
    settings = {"permissions": perms, "hooks": hooks}
    if m.get("guest"):
        guest_settings(m, settings)
    with open(path, "w") as f:
        json.dump(settings, f)
    return path


def event(name, kind, text, body=""):
    os.makedirs(DB, exist_ok=True)
    with open(EVENTS, "a") as f:
        f.write(json.dumps({"t": now(), "name": name, "kind": kind, "text": text, "body": body},
                           ensure_ascii=False) + "\n")
    # 马上叫醒，不等感官层下一次轮询
    if shutil.which(SENSES):
        subprocess.Popen([SENSES, "--source", "cc"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                         env=clean_env())


def clean_env():
    """给感官层的干净环境：系统那几样、PATH 和 HH 给的（HH_*）。不带网关和 Claude Code 自己的变量（OPENCLAW_*、
    XPC_SERVICE_NAME、CLAUDE_* 等）：10-25 查到，带着这些变量时第一次叫醒不生效，要等 3 分钟后的重试。"""
    env = {k: os.environ[k] for k in ("USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "PATH") if k in os.environ}
    env.update({k: v for k, v in os.environ.items() if k.startswith("HH_")})
    env["HOME"] = HOME
    return env


def first_line(text):
    for l in text.splitlines():
        l = l.strip().lstrip("#").strip()
        if l:
            return l[:140]
    return ""


def unread(name):
    try:
        lines = [l for l in open(p(name, "inbox.jsonl"), encoding="utf-8").read().splitlines() if l.strip()]
    except OSError:
        return [], 0
    try:
        done = int(open(p(name, "cursor")).read().strip() or 0)
    except (OSError, ValueError):
        done = 0
    return [json.loads(l)["text"] for l in lines[done:]], len(lines)


def mark_read(name, total):
    with open(p(name, "cursor"), "w") as f:
        f.write(str(total))


# ---------- 后台跑一轮（一次 claude -p） ----------

def run_turn(name):
    m = load(name)
    settings = p(name, "settings.json")
    conf = {"permissions": {"allow": m.get("allow", [])},
            "hooks": {"PostToolUse": [{"matcher": "*", "hooks": [
                {"type": "command", "command": f"{sys.executable} -I {HOOK}"}]}]}}
    if m.get("guest"):
        guest_settings(m, conf)
    with open(settings, "w") as f:
        json.dump(conf, f)
    args = [CLAUDE, "-p", "--permission-mode", "auto", "--name", name, "--settings", settings, *locked()]
    args += ["--resume", m["session_id"]] if m.get("began") else ["--session-id", m["session_id"]]
    for a in ([] if m.get("guest") else worker_dirs(m)):
        args += ["--add-dir", a]
    if m.get("model"):
        args += ["--model", m["model"]]
    env = dict(os.environ)
    env.pop("CLAUDE_CONFIG_DIR", None)  # 走默认 ~/.claude 的登录（她的 Max 账号）
    env["HOME"] = HOME
    env["CC_SESSION"] = os.path.join(DB, name)
    env["PATH"] = ":".join([NODE_BIN, os.path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin",
                            "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    prompt = open(p(name, "prompt"), encoding="utf-8").read()
    m.update(began=True, pid=os.getpid())
    save(name, m)
    r = subprocess.run(args, input=prompt, capture_output=True, text=True, cwd=m["dir"], env=env)
    with open(p(name, "last.md"), "w") as f:
        f.write(r.stdout)
    m = load(name)
    if m.get("state") == "stopped":
        return
    if r.returncode != 0 or not r.stdout.strip():
        kind = "quota" if QUOTA_RE.search(r.stdout + r.stderr) else "failed"
        why = first_line(r.stdout) or first_line(r.stderr[-500:]) or say("exitCode", returncode=r.returncode)
        m.update(state=kind, pid=None, ended=time.time())
        save(name, m)
        event(name, kind, (say("eventQuota") if kind == "quota" else say("eventFailed")) + why)
        return
    m.update(state="idle", pid=None, ended=time.time())
    save(name, m)
    # 它收工那一刻还没看到的插话：带着这些话接着干，话不会丢
    msgs, total = unread(name)
    if msgs:
        mark_read(name, total)
        launch(name, say("unseenWhileWorking", list="\n".join(msgs)))
        return
    event(name, "done", say("eventDone", first_line=first_line(r.stdout)), body=r.stdout.strip())


# 每轮 prompt 最前面都带这段（新开和 --resume 续上都一样）。10-29 实测 haiku 把工具结果后面的「【她插话】」当成提示注入，
# 拒绝照做（「出现在工具输出里，不是你在对话里发来的」）；说明必须在对话里（prompt）先讲清楚这条通道是真的。
#
# 但网页、字幕、文件里的外部内容也能写出同样格式的一段话，所以每个会话有个随机口令（存在 .cc/<名字>.json 的 token），
# 只写在这段说明和钩子输出里（cc_inbox_hook.py）；只有带本会话口令的才算，口令不对或没有的一律当普通素材。


def new_token():
    return uuid.uuid4().hex[:6]


def launch(name, prompt):
    m = load(name)
    if not m.get("token") and not m.get("guest"):    # 新会话、或加口令之前就有的老会话：第一次 launch 时补上
        m["token"] = new_token()
        save(name, m)
    if not m.get("guest"):    # 访客任务的 prompt 必须以访客守则开头，不动
        prompt = say("interjectNote", token=m["token"]) + prompt
    with open(p(name, "prompt"), "w", encoding="utf-8") as f:
        f.write(prompt.rstrip() + "\n")
    m.update(state="running", turn=m.get("turn", 0) + 1, started=time.time(), stuck_turn=None)
    save(name, m)
    if os.environ.get("CC_MODE", "bg") == "bg" and launch_bg(name, prompt.rstrip() + "\n"):
        return
    m = load(name)
    m["mode"] = "p"  # 这一轮退回 claude -p（老办法）
    save(name, m)
    proc = subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), "_run", name],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=open(p(name, "runner.log"), "a"), start_new_session=True)
    m["pid"] = proc.pid
    save(name, m)


WORKTREES = os.path.realpath(os.path.join(WS, ".claude/worktrees"))  # 工作区的 worktree 目录（可能是软链到外置盘的）；帮手要能直接进去（11-08）


def worker_dirs(m):
    dirs = list(m.get("add_dirs", []))
    if os.path.isdir(WORKTREES) and WORKTREES not in dirs:
        dirs.append(WORKTREES)
    return dirs


def default_model():
    """她 Claude Code 设置里的默认模型（~/.claude/settings.json 的 model）；没设、读不了返回 None"""
    try:
        with open(os.path.join(HOME, ".claude/settings.json"), encoding="utf-8") as f:
            v = json.load(f).get("model")
        return v if isinstance(v, str) and v else None
    except (OSError, ValueError, AttributeError):
        return None


def locked():
    """Only the built-in tools the role's config names (helpers' tools), and no MCP server but those passed (none): the
    account's connectors (mail, drive, calendar …) stay out of a helper's session, as they stay out of the kernel's"""
    return ["--tools", ",".join(hh.config.get("tools") or []), "--strict-mcp-config"]


def bg_options(name, m, settings):
    """后台会话启动时带的那一套选项：名字、设置文件（钩子、allow）、权限模式、add-dir、模型。
    新开会话、进程没了重拉、老任务丢了选项补回来，都用这一份，别再各写各的（10-29 avatar-motion 进程没了重拉时
    只带了 --model，任务里没有 --settings，插话钩子和收工钩子整个不存在）。口令不是命令行选项，在 launch() 里放进 prompt。"""
    args = ["--name", name, "--settings", settings, "--permission-mode", "auto", *locked()]
    for a in ([] if m.get("guest") else worker_dirs(m)):
        args += ["--add-dir", a]
    if m.get("model"):
        args += ["--model", m["model"]]
    return args


def job_lost_options(bid):
    """后台任务的 respawnFlags 里没有 --settings, or was started before helpers were locked (no --strict-mcp-config): it is
    started again with the whole set（读得到才下结论；读不到当没丢，不乱补）。"""
    try:
        with open(os.path.join(JOBS, bid, "state.json"), encoding="utf-8") as f:
            flags = json.load(f).get("respawnFlags")
    except (OSError, ValueError):
        return False
    return isinstance(flags, list) and ("--settings" not in flags or "--strict-mcp-config" not in flags)


def launch_bg(name, prompt):
    """用交互式后台会话跑一轮（claude --bg，入口 cli，按交互档计费）。起来了返回 True；失败返回 False，调用方退回 claude -p。
    它的进程还在、任务里选项齐全：先停，再不带任何选项续上（带了 claude 会另开一个副本；只有换模型才带 --model，缓存反正要重写）。
    其余情况（新会话、从 claude -p 转来的、进程已经没了、任务里丢了 --settings）：--resume（有历史时）加整套 bg_options。"""
    m = load(name)
    was_bg = m.get("mode") == "bg" and m.get("bg_id")
    m["mode"] = "bg"
    save(name, m)
    settings = write_settings(name, m)
    env = claude_env(name)
    cur = bg_entry(m) if was_bg else None
    if cur:  # 它的进程还在（空闲着）：先停
        subprocess.run([CLAUDE, "stop", cur.get("id") or m["bg_id"]], capture_output=True, timeout=60,
                       stdin=subprocess.DEVNULL, env=env)
        for _ in range(30):
            if not bg_entry(m):
                break
            time.sleep(0.5)
    if cur and not job_lost_options(m["bg_id"]):
        args = [CLAUDE, "--bg", "--resume", m["session_id"]]
        if (m.get("bg_model") or "") != (m.get("model") or ""):
            # 换回默认（不写模型）：照她 Claude Code 设置里的默认模型，没设就不带、交给 claude 自己定（11-13 起不再写死补 opus）
            want = m.get("model") or default_model()
            if want:
                args += ["--model", want]
    else:
        if was_bg and cur:
            runner_log(name, say("logRespawn", bg_id=m['bg_id']))
        # 新会话也传 --session-id：不传的话 claude 自己分配 id，meta 里的 uuid 是假的，轮询 agents() 10 秒换不到，
        # 钩子（按 session_id 认会话）就全认不出来
        args = [CLAUDE, "--bg"] + (["--resume", m["session_id"]] if m.get("began") else ["--session-id", m["session_id"]]) + bg_options(name, m, settings)
    # 「--」结束选项解析：--add-dir 是可变参数（<directories...>），prompt 紧跟在它后面会被当成又一个目录吞掉，
    # 会话起来了却没有 prompt（10-29 bili-eyes：state 是 blocked「send a prompt to start」，空等 7 分钟）
    args += ["--", prompt]
    for attempt in (0, 1):
        since = time.time()    # 旧进程已经 stop 完；job 文件在这之前的写入都不算这一轮的（见 bg_job_ended）
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=120, cwd=m["dir"], env=env,
                               stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as e:
            runner_log(name, f"bg launch failed: {e}")
            return False
        out = r.stdout + r.stderr
        hit = BG_ID_RE.search(out)
        if r.returncode != 0 or not hit:
            runner_log(name, f"bg launch failed rc={r.returncode}: {out[-500:]}")
            if "not trusted" in out:
                note_trust(m["dir"])
            return False
        note_trust(None)
        bid = hit.group(1)
        full = None
        for _ in range(20):
            full = next((a.get("sessionId") for a in agents() if a.get("id") == bid), None)
            if full:
                break
            time.sleep(0.5)
        m = load(name)
        m.update(mode="bg", bg_id=bid, bg_model=m.get("model") or "", began=True, pid=None, bg_since=since)
        if full:
            m["session_id"] = full
        save(name, m)
        runner_log(name, f"bg turn {m.get('turn')} started as {bid}")
        if not stuck_at_start(bid):
            return True
        # 起步卡住（没拿到 prompt）：停掉，用 --resume 带着 prompt 重发一次；再卡就退回 claude -p
        runner_log(name, say("logStuck", bid=bid, next=say("logStuckResend") if attempt == 0 else say("logStuckFallback")))
        subprocess.run([CLAUDE, "stop", bid], capture_output=True, timeout=60, stdin=subprocess.DEVNULL, env=env)
        for _ in range(30):
            if not bg_entry(m):
                break
            time.sleep(0.5)
        if attempt:
            return False
        args = [CLAUDE, "--bg", "--resume", m["session_id"], "--", prompt]
    return False


def stuck_at_start(bid, wait=8.0):
    """起来的后台会话是不是没拿到 prompt：job 的 state.json 里 needs/detail 写着「send a prompt to start」。
    连续 wait 秒都这样才算卡住；中途变了（开始干活）或一直读不到文件就当没卡住。"""
    path = os.path.join(JOBS, bid, "state.json")
    deadline = time.time() + wait
    seen = False
    while time.time() < deadline:
        try:
            with open(path, encoding="utf-8") as f:
                job = json.load(f)
        except (OSError, ValueError):
            job = None
        if job is not None:
            if "send a prompt to start" not in f"{job.get('needs')} {job.get('detail')}":
                return False
            seen = True
        time.sleep(0.5)
    return seen


def find_by_session(sid):
    for f in glob.glob(os.path.join(DB, "*.json")):
        name = os.path.basename(f)[:-5]
        if name.endswith(".settings"):
            continue
        m = load(name)
        if sid and m.get("session_id") == sid:
            return name, m
    return None, None


def last_reply(path, since=None):
    """这一轮它最后回的那段话（最后一条 assistant 文字）。"""
    last = ""
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            msg = e.get("message")
            if e.get("type") != "assistant" or e.get("isSidechain") or not isinstance(msg, dict):
                continue
            if since is not None and iso_time(e.get("timestamp")) <= since:
                continue
            c = msg.get("content")
            if isinstance(c, list):
                t = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text").strip()
                if t:
                    last = t
    except OSError:
        pass
    return last


def iso_time(value):
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return 0



def pending_dialog(bid):
    """后台会话屏幕最后停在一个确认框上（「Do you want to proceed?」这类）就返回那几行，否则 None。
    11-08：EnterWorktree 进软链接到外置盘的 .claude/worktrees 会弹框，job 状态照样是 working，
    blocked_reply 认不出来，只能 20 分钟后报「卡住」。这里看屏幕尾巴认出来。"""
    if not re.fullmatch(r"[0-9a-f]+", bid or ""):
        return None
    try:
        r = subprocess.run([CLAUDE, "logs", bid], capture_output=True, timeout=20, stdin=subprocess.DEVNULL)
        out = r.stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout or b""
    except OSError:
        return None
    s = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", out.decode(errors="ignore")).replace("\r", "\n")
    tail = [l.strip() for l in s.splitlines() if l.strip(" \t│╌─━╭╮╰╯")][-14:]
    i = next((k for k in range(len(tail) - 1, -1, -1) if "Do you want to" in tail[k]), None)
    if i is None or not any(re.search(r"1\.\s*Yes", l) for l in tail[i:]):
        return None
    return "\n".join(tail[max(0, i - 4):i + 1])


def blocked_reply(m, cur):
    """只接当前后台 job、本轮的新等待状态与新回复；不能把上轮 blocked 当成本轮结果。"""
    bid = m.get("bg_id") or ""
    if (cur.get("id") != bid or cur.get("sessionId") != m.get("session_id")
            or cur.get("state") != "blocked" or not re.fullmatch(r"[0-9a-f]+", bid)):
        return None
    try:
        with open(os.path.join(HOME, ".claude/jobs", bid, "state.json"), encoding="utf-8") as f:
            job = json.load(f)
    except (OSError, ValueError):
        return None
    started = m.get("started", 0)
    if (job.get("sessionId") != m.get("session_id") or job.get("state") != "blocked"
            or iso_time(job.get("updatedAt")) <= started):
        return None
    return last_reply(transcript(m) or "", since=started) or None


def bg_notice(name, expected, state, kind, text, reply):
    """慢查询后重查轮次/状态，避免 stop 或新一轮被旧结果覆盖；本地状态也负责去重。"""
    def same_turn(m):
        return all(m.get(k) == expected.get(k) for k in ("session_id", "bg_id", "turn", "started"))
    current = load(name)
    if current.get("state") != "running" or not same_turn(current):
        return
    current.update(state=state, pid=None, ended=time.time())
    match = {k: expected.get(k) for k in ("state", "session_id", "bg_id", "turn", "started")}
    if not save(name, current, expected=match):
        return
    # stop / send 可以在保存后到达；发事件前也不能替已停或已续跑的轮次报结果。
    current = load(name)
    if current.get("state") == state and same_turn(current):
        with open(p(name, "last.md"), "w", encoding="utf-8") as f:
            f.write(reply)
        event(name, kind, text + first_line(reply), body=reply.strip())


def guard_hook(ev):
    """访客任务的 PreToolUse hook：按 leak-guard 的访客规则判断；判断不了就挡（宁可挡错）。"""
    name, m = find_by_session(ev.get("session_id"))
    if not m:
        env_name = os.path.basename(os.environ.get("CC_SESSION", ""))
        m = load(env_name) if env_name else {}
    gid = m.get("guest") if m else None
    why = ""
    if not gid:
        why = say("guardUnknownTask")
    else:
        try:
            r = lg_node(["ccguard"], json.dumps({"guest": gid, "tool_name": ev.get("tool_name"), "tool_input": ev.get("tool_input"),
                                                  "cwd": ev.get("cwd") or m.get("dir")}, ensure_ascii=False))
            why = r.get("deny") or ""
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
            why = say("guardCheckFailed", e=e)
    if why:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": say("guardRefused", why=why)}},
                         ensure_ascii=False))


def cmd_hook(kind):
    """后台会话的 Stop / StopFailure hook：记下这一轮的结果，叫醒她。guard：访客任务的 PreToolUse 守卫。"""
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        if kind == "guard":
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                     "permissionDecisionReason": say("hookBadInput")}}))
        return
    if kind == "guard":
        guard_hook(ev)
        return
    name, m = find_by_session(ev.get("session_id"))
    if not name or m.get("state") in ("stopped", "needs_input"):
        return
    if kind == "stopfail":
        err = json.dumps({k: v for k, v in ev.items() if k not in ("transcript_path", "cwd")}, ensure_ascii=False)[:2000]
        k = "quota" if QUOTA_RE.search(err) else "failed"
        m.update(state=k, pid=None, ended=time.time())
        save(name, m)
        event(name, k, (say("eventQuota") if k == "quota" else say("eventFailed")) + first_line(err))
        return
    reply = last_reply(ev.get("transcript_path") or transcript(m) or "")
    with inbox_lock(name):    # 和 cmd_send 的「busy 判断 + 写 inbox」互斥：话要么在这里被读走，要么 send 看到 idle 另开一轮
        msgs, total = unread(name)
        if msgs:  # 收工那一刻还有没看到的插话：不让它停，带着这些话接着干
            mark_read(name, total)
            print(json.dumps({"decision": "block", "reason": say("unseenWhileWorking", list="\n".join(msgs))},
                             ensure_ascii=False))
            return
        m = load(name)
        if m.get("state") in ("stopped", "needs_input"):
            return
        with open(p(name, "last.md"), "w") as f:
            f.write(reply)
        m.update(state="idle", pid=None, ended=time.time())
        save(name, m)
    event(name, "done", say("eventDone", first_line=first_line(reply)), body=reply.strip())


# ---------- 命令 ----------

MODELS_LOG = "models.jsonl"   # 每开一个会话记一行：名字、模型、第一句话（工具只记，不管怎么挑；用的人拿它回头核自己挑得对不对）



def cmd_send(name, text, opts):
    if hh.config.get("model"):   # the role's config picks the helpers' model: a --model given here does not, and is told so
        fixed = "" if hh.config["model"] == "default" else hh.config["model"]
        if opts.get("model", fixed) != fixed:
            print(say("modelPinned", model=hh.config['model']))
        opts["model"] = fixed
    check_name(name)
    said = text   # 她的原话（后面会接上笔记、轻量前缀、访客守则）：记新帮手时记这份
    gid = opts.get("guest")
    if gid:
        if opts.get("dir") or opts.get("add_dirs"):
            die(say("guestNoDir", tasks=TASKS))
        if not trusted_guest(gid):
            die(say("guestNotTrusted", gid=gid))
        m1 = load(name)
        if m1 and m1.get("guest") != gid:
            die(say("guestNotTheirs", name=name, gid=gid))
        if not m1 and os.path.exists(os.path.join(TASKS, name)):
            die(say("guestDirTaken", tasks=TASKS, name=name))
    m0 = load(name)
    if not (m0 and busy(m0)):  # 正在跑的会话插话不拦，只拦新开一轮
        kind = "cc-light" if opts.get("light") else "cc"
        try: g = subprocess.run(["load", "gate", kind], capture_output=True, text=True)
        except FileNotFoundError: g = subprocess.CompletedProcess([], 127, say("noLoadCommand"), "")
        if g.returncode != 0:
            sys.exit(say("notNow", why=g.stdout.strip()))
        if say("loadWarnMark") in g.stdout:
            print(g.stdout.strip().split(say("sentenceEnd"))[0])
    # 她的笔记附给帮手（访客派的任务不附：她的笔记不给访客的帮手看）；拿她写的原话去问，不带下面的轻量前缀
    notes = "" if gid or (m0 and m0.get("guest")) else helper_notes(name, text)
    brief = notes_brief(notes)
    if notes:
        text = text + "\n\n" + notes
    if opts.get("light"):
        text = say("lightPrefix", text=text)
    m = load(name)
    if not m:
        d = os.path.abspath(os.path.expanduser(opts["dir"])) if opts.get("dir") else os.path.join(TASKS, name)
        os.makedirs(d, exist_ok=True)
        m = {"session_id": str(uuid.uuid4()), "dir": d, "created": now(), "turn": 0, "began": False,
             "add_dirs": opts.get("add_dirs", []), "allow": [], "model": opts.get("model")}
        if gid:
            m["guest"] = gid
            text = say("guestHead", who=guest_name(gid), dir=d) + text
        save(name, m)
        try:
            os.makedirs(DB, exist_ok=True)
            with open(os.path.join(DB, MODELS_LOG), "a") as f:
                f.write(json.dumps({"t": now(), "name": name, "model": m["model"], "first": said[:50], "guest": gid or None},
                                   ensure_ascii=False) + "\n")
        except OSError:
            pass   # 记不下来不挡派活
        launch(name, text)
        print(say("newSession", name=name, model=m['model'] or say("defaultModel"), dir=d, brief=tail_brief(brief)))
        if untrusted():
            print(say("untrustedNote", dir=untrusted()))
        return
    if opts.get("add_dirs"):
        m["add_dirs"] = sorted(set(m.get("add_dirs", []) + opts["add_dirs"]))
        save(name, m)
    if "model" in opts:
        m["model"] = opts["model"] or None  # 下一轮起生效；正在跑的这一轮不变
        save(name, m)
    with inbox_lock(name):    # 判断 busy 和写 inbox 之间 Stop 钩子插不进来
        m = load(name)
        if busy(m):    # busy() 会核对后台任务是不是真的还在（bg_job_ended）；确定没了就当空闲，走下面另开一轮
            with open(p(name, "inbox.jsonl"), "a") as f:
                f.write(json.dumps({"t": now(), "text": text}, ensure_ascii=False) + "\n")
            print(say("passedOn", name=name, brief=tail_brief(brief)))
            return
        left, total = unread(name)
        mark_read(name, total)
    if left:
        # 上一轮没送到的插话别丢（cc-bugs 报告 10-31：以前这里直接标已读，话就没了）
        text = (say("leftover", list="\n".join(f"- {t}" for t in left), text=text))
    launch(name, text)
    print(say("continued", name=name, turn=load(name)['turn'], brief=tail_brief(brief)))


def helper_notes(name, text):
    """派给帮手的活拿去问 HH 该附哪几页笔记（hh learn helper；主人 11-01「给帮手也绑定技能」，11-02 起）：
    回一段接在派给它的话后面（页的绝对路径和一句简介，同一个帮手同一页只给一次）；没有、出错、超时都是空串，不挡派活。"""
    try:
        r = subprocess.run([HH, "learn", "helper", name, text[:500]], capture_output=True, text=True,
                           timeout=HELPER_NOTES_S, stdin=subprocess.DEVNULL)
    except Exception as e:  # 问笔记出什么错都不能挡派活
        note_failed(name, repr(e))
        return ""
    if r.returncode != 0:
        note_failed(name, (r.stderr or r.stdout or "").strip())
        return ""
    return r.stdout.strip()


def note_failed(name, why):
    """问不到笔记记一行在这个任务的 runner.log（维护的人查得到；记不下也不管）。"""
    try:
        runner_log(name, say("notesFailed", why=why[:300]))
    except Exception:
        pass


def tail_brief(brief):
    """附了哪几页接在最后一行后面（她常用 `| tail -1` 只看最后一行，单独一行会被截掉，11-02 18:04 就是）。"""
    return say("tailBrief", brief=brief) if brief else ""


def notes_brief(notes):
    """附了哪几页，给她看的一行（页名）。"""
    names = [os.path.basename(m.group(1))[:-3] for m in (re.match(r"- (.+?\.md)：", l) for l in notes.splitlines()) if m]
    return say("notesAttached", names=say("comma").join(names)) if names else ""


def guest_name(gid):
    try:
        with open(REGISTRY, encoding="utf-8") as f:
            return json.load(f).get(gid, {}).get("name") or gid
    except (OSError, ValueError):
        return gid


def pop_guest(rest):
    """从参数里拿出 --guest <id>（show / ls 用）。"""
    out, gid, i = [], None, 0
    while i < len(rest):
        if rest[i] == "--guest" and i + 1 < len(rest):
            gid = rest[i + 1]; i += 2
        elif rest[i].startswith("--guest="):
            gid = rest[i][8:]; i += 1
        else:
            out.append(rest[i]); i += 1
    return out, gid


def short(v, k):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        s = "\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in v)
    return s if k is None or len(s) <= k else say("shortened", s=s[:k], n=len(s))


def tool_brief(c):
    inp = c.get("input") or {}
    for key in ("command", "file_path", "pattern", "url", "query", "prompt", "description"):
        if inp.get(key):
            return str(inp[key])
    return json.dumps(inp, ensure_ascii=False)


def cmd_show(name, rest):
    rest, gid = pop_guest(rest)
    m = load(name)
    if gid and m.get("guest") != gid:
        die(say("showNoGuestTask", gid=gid, name=name))
    if not m:
        die(say("showNoSession", name=name))
    t = transcript(m)
    if not t:
        die(say("showNoRecord"))
    mode = ("full" if "--full" in rest else "steps" if "--steps" in rest
            else "brief" if "--process" in rest else "last")
    rest = [r for r in rest if not r.startswith("--")]
    want = rest[0] if rest else "1"
    rounds, cur = [], None  # 每轮是一串 (种类, 时间, 内容, 出错没有)
    for line in open(t, encoding="utf-8", errors="replace"):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ts = ""
        if e.get("timestamp"):  # UTC → 本地时间
            try:
                ts = datetime.datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).astimezone().strftime("%H:%M")
            except ValueError:
                ts = e["timestamp"][11:16]
        typ = e.get("type")
        if typ == "attachment":
            a = e.get("attachment") or {}
            if a.get("type") == "hook_additional_context" and cur is not None:
                txt = "\n".join(a.get("content") or []) if isinstance(a.get("content"), list) else str(a.get("content"))
                for l in txt.splitlines():
                    if l.startswith(say("interjectOpen")):
                        cur.append(("inter", ts, l.replace(say("interjectOpenSpace"), say("youCutIn")).replace(say("interjectClose"), say("parenClose"), 1), False))
            continue
        msg = e.get("message")
        if not isinstance(msg, dict) or e.get("isMeta") or e.get("isSidechain"):
            continue
        content = msg.get("content")
        if typ == "user" and isinstance(content, str):
            if not content.startswith("<"):
                cur = [("you", ts, content.strip(), False)]
                rounds.append(cur)
            continue
        if cur is None or not isinstance(content, list):
            continue
        for c in content:
            ct = c.get("type")
            if typ == "user" and ct == "text" and c.get("text", "").strip() and not c["text"].startswith("<"):
                cur = [("you", ts, c["text"].strip(), False)]
                rounds.append(cur)
            elif typ == "assistant" and ct == "text" and c.get("text", "").strip():
                cur.append(("say", ts, c["text"].strip(), False))
            elif typ == "assistant" and ct == "tool_use":
                cur.append(("tool", ts, f"{c.get('name')}: {tool_brief(c)}", False))
            elif typ == "user" and ct == "tool_result":
                cur.append(("res", ts, short(c.get("content") or "", None), bool(c.get("is_error"))))
    if not rounds:
        die(say("showNoTalk"))
    pick = rounds if want == "all" else rounds[-max(1, int(want)):]
    st = say("stateWorking") if busy(m) else {"idle": say("stateIdle"), "needs_input": say("stateNeedsInput"), "failed": say("stateFailed"), "quota": say("stateQuota"), "stopped": say("stateStopped")}.get(m.get("state"), m.get("state"))
    print(say("showHead", name=name, state=st, turns=len(rounds), dir=m['dir'], file=t))
    for r in pick:
        print("\n".join(render(r, mode)))
    if mode == "last":
        print(say("showLastOnly"))
    elif mode == "brief":
        print(say("showOutline"))
    if busy(m):
        print(say("showStillWorking", ago=ago(os.path.getmtime(t))))


def one_line(s, k):
    s = " ".join(s.split())
    return s if len(s) <= k else say("ellipsized", s=s[:k])


def render(items, mode):
    """brief（默认）：你的话开头 + 它说的全文 + 每一步一行（只标出错的）；steps：加上每一步的结果；full：全不截断。"""
    out, tools = [], []
    if mode == "last":
        you = next((x for x in items if x[0] == "you"), None)
        says = [x for x in items if x[0] == "say"]
        steps = sum(1 for x in items if x[0] == "tool")
        errs = sum(1 for x in items if x[0] == "res" and x[3])
        if you:
            out.append(say("renderYou", at=you[1], line=one_line(you[2], 60)))
        out.append(say("renderSteps", steps=steps, errors=say("renderErrors", errs=errs) if errs else ""))
        out.append(say("renderClaude", at=says[-1][1], text=says[-1][2]) if says else say("renderSilent"))
        return out

    def flush():
        if mode == "brief" and len(tools) > 12:
            out.extend(tools[:5] + [say("renderMore", n=len(tools) - 9)] + tools[-4:])
        else:
            out.extend(tools)
        tools.clear()

    for kind, ts, text, err in items:
        if kind == "you":
            flush()
            body = text if mode == "full" or len(text) <= 300 else say("renderShortened", text=text[:300], n=len(text))
            out.append(say("renderYouFull", ts=ts, body=body))
        elif kind == "say":
            flush()
            out.append(say("renderClaudeFull", ts=ts, text=text))
        elif kind == "inter":
            flush()
            out.append(f"> {text}")
        elif kind == "tool":
            tools.append(f"⏺ {text if mode == 'full' else one_line(text, 300 if mode == 'steps' else 110)}")
        elif kind == "res":
            if mode == "brief":
                if err:
                    tools.append(f"  ✗ {one_line(text, 160)}")
                continue
            lines = (text if mode == "full" else text[:600]).rstrip().splitlines() or [""]
            if mode != "full" and len(lines) > 8:
                lines = lines[:8] + [say("renderMoreLines", n=len(lines) - 8)]
            tools.append(("  ✗ " if err else "  ⎿ ") + "\n    ".join(lines))
    flush()
    return out


def ago(ts):
    s = int(time.time() - ts)
    return say("agoSeconds", s=s) if s < 60 else say("agoMinutes", m=s // 60) if s < 3600 else say("agoHours", h=s // 3600, m=s % 3600 // 60)


def sessions(gid=None):
    """Every session, newest first, as ls shows it: name, state ("working" while a turn runs, else the record's), label
    (the state in the role's language), turns, ago, dir, last (its last line; empty while it works). The board reads it too."""
    out = []
    for f in sorted(glob.glob(os.path.join(DB, "*.json")), key=os.path.getmtime, reverse=True):
        name = os.path.basename(f)[:-5]
        if name.endswith(".settings"):
            continue
        m = load(name)
        if not m.get("session_id") or (gid and m.get("guest") != gid):
            continue
        state = "working" if busy(m) else m.get("state")
        label = {"working": say("stateWorking"), "idle": say("stateIdle"), "needs_input": say("stateNeedsInput"), "failed": say("stateFailed"), "quota": say("stateQuota"),
                 "stopped": say("stateStopped"), "running": say("stateGone")}.get(state, state)
        t = transcript(m)
        last = ""
        try:
            last = first_line(open(p(name, "last.md"), encoding="utf-8").read())
        except OSError:
            pass
        out.append(dict(name=name, state=state, label=label, turns=m.get("turn", 0), ago=ago(os.path.getmtime(t)) if t else "-", dir=m["dir"],
                        last=last if state != "working" else ""))
    return out


def cmd_ls(gid=None):
    rows = [say("lsLine", name=s["name"], state=s["label"], turns=s["turns"], ago=s["ago"], dir=s["dir"], last=say("lsLast", last=s["last"][:80]) if s["last"] else "")
            for s in sessions(gid)]
    print("\n".join(rows) if rows else say("lsEmpty"))


def cmd_stop(name):
    m = load(name)
    if not m:
        die(say("noSession", name=name))
    pid = m.get("pid")
    m.update(state="stopped", pid=None)
    save(name, m)
    if m.get("mode") == "bg" and m.get("bg_id"):
        subprocess.run([CLAUDE, "stop", m["bg_id"]], capture_output=True, timeout=60, stdin=subprocess.DEVNULL,
                       env=claude_env())
    elif alive(pid):
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except OSError:
            pass
    print(say("stopped", name=name))


def cmd_allow(name, rule):
    m = load(name)
    if not m:
        die(say("noSession", name=name))
    if rule not in m.setdefault("allow", []):
        m["allow"].append(rule)
    save(name, m)
    print(say("allowed", rule=rule, name=name, allow=m['allow']))


IDLE_CLOSE_SEC = 15 * 60   # a helper done this long with nobody back to it: its background process is closed


def close_idle(name, m):
    """A background session done (idle) for IDLE_CLOSE_SEC: its process stopped, its record kept. Idle, the two of them
    (the daemon's pty host and the session) still hold about 300MB each pair, swapped out, slowing the whole machine (11-17:
    eight done helpers held 2.3GB); the next send to it resumes it from its record (launch_bg: its process is gone).
    One waiting for an answer (needs_input) is left open. True when closed."""
    ended = m.get("ended") or 0
    if m.get("state") != "idle" or m.get("mode") != "bg" or not m.get("bg_id") or not ended:
        return False
    if time.time() - ended < IDLE_CLOSE_SEC or m.get("closed", 0) >= ended:
        return False
    # only if it is still the idle turn this look saw (a send may have started another meanwhile)
    if not save(name, dict(m, closed=time.time()), expected={"state": "idle", "ended": ended, "bg_id": m["bg_id"]}):
        return False
    subprocess.run([CLAUDE, "stop", m["bg_id"]], capture_output=True, timeout=60, stdin=subprocess.DEVNULL, env=claude_env())
    runner_log(name, say("logIdleClosed", bid=m["bg_id"], minutes=IDLE_CLOSE_SEC // 60))
    return True


def cmd_events():
    for f in glob.glob(os.path.join(DB, "*.json")):
        name = os.path.basename(f)[:-5]
        m = load(name)
        if close_idle(name, m) or m.get("state") != "running":
            continue
        if m.get("mode") == "bg" and not m.get("pid"):
            if time.time() - m.get("started", time.time()) > 90:
                cur = bg_entry(m)
                job = read_job(m.get("bg_id") or "")
                if not cur and job and job.get("state") in ("working", "blocked"):
                    continue  # agents() 查询偶尔超时/出错返回空；job 文件说它还在，别误判成没了
                if not cur:
                    m.update(state="failed")
                    save(name, m)
                    event(name, "failed", say("eventBgGone"))
                    continue
                if cur.get("id") != m.get("bg_id") or cur.get("sessionId") != m.get("session_id"):
                    continue  # 同一历史可能被另一个后台 job 续跑，不能认领它的状态。
                if cur.get("status") == "idle" and cur.get("state") == "done":  # Stop hook 没跑成：按已收工处理
                    reply = last_reply(transcript(m) or "")
                    bg_notice(name, m, "idle", "done", say("eventDonePrefix"), reply)
                    continue
                reply = blocked_reply(m, cur)
                if reply is not None:
                    bg_notice(name, m, "needs_input", "needs_input", say("eventNeedsInput"), reply)
                    continue
                # 兜底：agents 里还挂着它，但 job 文件已经是 done / stopped（被中断、Stop 钩子没跑成……），
                # 再往下只会一直发「卡住了」而 state 永远是 running。只认 job 文件里见过的结束状态；没见过的状态名保持沉默
                if bg_job_ended(m):
                    m.update(state="failed", pid=None, ended=time.time())
                    if save(name, m, expected={"state": "running", "turn": m.get("turn"), "started": m.get("started")}):
                        event(name, "failed", say("eventBgEnded", status=cur.get('status'), state=cur.get('state')))
                    continue
        elif not alive(m.get("pid")):
            m.update(state="failed", pid=None)
            save(name, m)
            event(name, "failed", say("eventDied"))
            continue
        t = transcript(m)
        last = os.path.getmtime(t) if t else m.get("started", time.time())
        # 3 分钟没动就看一眼屏幕是不是停在确认框上（每 5 分钟最多看一次，每轮只报一次）
        if (m.get("mode") == "bg" and time.time() - last > 180 and m.get("dialog_turn") != m.get("turn")
                and time.time() - m.get("dialog_checked", 0) > 300):
            m["dialog_checked"] = time.time()
            dlg = pending_dialog(m.get("bg_id") or "")
            if dlg:
                m["dialog_turn"] = m.get("turn")
            save(name, m)
            if dlg:
                event(name, "needs_input", say("eventPermission"), dlg)
                continue
        if time.time() - last > STUCK_MIN * 60 and m.get("stuck_turn") != m.get("turn"):
            m["stuck_turn"] = m.get("turn")
            save(name, m)
            event(name, "stuck", say("eventStale", minutes=int((time.time() - last) // 60)))
    cutoff = time.time() - 48 * 3600
    try:
        lines = open(EVENTS, encoding="utf-8").read().splitlines()
    except OSError:
        return
    for l in lines:
        try:
            e = json.loads(l)
        except ValueError:
            continue
        if time.mktime(time.strptime(e["t"], "%Y-%m-%d %H:%M:%S")) >= cutoff:
            # 一行一个 JSON：text 是摘要（和以前的纯文字行一样，感官层按它去重），body 是它最后回你的消息全文
            print(json.dumps({"text": say("eventLine", t=e['t'][5:16], name=e['name'], text=e['text']),
                              "body": e.get("body", "")}, ensure_ascii=False))


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help", "help"):
        print(say("usage"))
        return
    c = a[0]
    if c == "_run":
        run_turn(a[1])
    elif c == "_hook" and len(a) > 1:
        cmd_hook(a[1])
    elif c == "untrusted":
        print(untrusted())
    elif c == "send" and any(x in ("-h", "--help") for x in a[1:]):
        print(say("usage"))   # send 后面带着 --help：只打用法，不派活、不把「--help」当话发出去（11-13）
        return
    elif c == "send" and len(a) > 2:
        opts, words, i = {"add_dirs": []}, [], 2
        while i < len(a):
            if a[i] == "--dir" and i + 1 < len(a):
                opts["dir"] = a[i + 1]; i += 2
            elif a[i] == "--model" and i + 1 < len(a):
                opts["model"] = "" if a[i + 1] in ("default", "opus5.5") else a[i + 1]; i += 2
            elif a[i] == "--add-dir" and i + 1 < len(a):
                opts["add_dirs"].append(os.path.abspath(os.path.expanduser(a[i + 1]))); i += 2
            elif a[i] == "--light":
                opts["light"] = True; i += 1
            elif a[i] == "--guest" and i + 1 < len(a):
                opts["guest"] = a[i + 1]; i += 2
            else:
                words.append(a[i]); i += 1
        if not " ".join(words).strip():
            die(say("sendNeedsWords"))
        cmd_send(a[1], " ".join(words), opts)
    elif c == "show" and len(a) > 1:
        cmd_show(a[1], a[2:])
    elif c == "ls":
        cmd_ls(pop_guest(a[1:])[1])
    elif c == "stop" and len(a) > 1:
        cmd_stop(a[1])
    elif c == "allow" and len(a) > 2:
        cmd_allow(a[1], a[2])
    elif c == "events":
        cmd_events()
    else:
        print(say("usage"))
        sys.exit(2)


if __name__ == "__main__":
    main()
