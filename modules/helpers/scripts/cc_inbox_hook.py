"""Claude Code 的 PostToolUse hook：她在它干活时 cc.py send 的话，在它下一个操作后塞进上下文。

按 hook 事件里的 session_id 找是哪个 cc 会话（查 ~/agent-tasks/.cc/<名字>.json 里的 session_id），不信环境变量 CC_SESSION：
claude --bg 的后台进程是预先起好的「备用进程」，环境变量在它起来那一刻就定了，之后被别的会话认领也不会更新
（2026-10-29 实测：zz-ack2、face-materials 和本会话的进程里 CC_SESSION 都是 avatar-motion，它们的钩子把 avatar-motion
的插话读走并推进了游标，话塞进了别的会话，avatar-motion 自己没收到）。"""
import glob
import json
import os
import sys
import time

# Claude Code runs this with python -I (no PYTHONPATH): find hh_env next to the modules
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_lib"))
from hh_env import hh, words  # noqa: E402

say = words(__file__)

DB = os.environ.get("CC_DB") or hh.config.get("sessionsDir") or os.path.join(hh.module_state, "sessions")
try:
    ev = json.load(sys.stdin)
except ValueError:
    ev = {}


def find_base():
    """-> (base, how)。base 是 <DB>/<名字>，找不到是 None。"""
    sid = ev.get("session_id")
    if sid:
        for f in sorted(glob.glob(os.path.join(DB, "*.json"))):
            if f.endswith(".settings.json"):
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    m = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(m, dict) and m.get("session_id") == sid:
                return f[:-5], "session_id"
        return None, say("hookNoSession")       # 不是 cc 开的会话，或刚起来 meta 里还没换成全称：不碰任何人的插话
    env = os.environ.get("CC_SESSION")                      # 事件里没带 session_id 时才退回环境变量
    return (env, "env") if env else (None, "no session_id, no env")


base, how = find_base()


def hlog(**kw):
    """每次触发记一行 <会话>.hooklog（10-29 插话「读掉但没生效」查不出有没有送到；记录里看不到钩子输出）。出任何错都不影响钩子。"""
    try:
        with open((base or os.path.join(DB, "_unmatched")) + ".hooklog", "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.strftime("%F %T"), "pid": os.getpid(), "tool": ev.get("tool_name"),
                                "agent": ev.get("agent_id"), "by": how, "env": os.environ.get("CC_SESSION", "").rsplit("/", 1)[-1],
                                "sid": (ev.get("session_id") or "")[:8], **kw}, ensure_ascii=False) + "\n")
    except OSError:
        pass


if not base:
    if os.environ.get("CC_SESSION") or ev.get("session_id"):
        hlog(skip="unmatched")
    sys.exit(0)
if ev.get("agent_id"):
    # 子代理的工具调用也会触发这个钩子；插话只给主会话，不然会被子代理吃掉（2026-10-22 修，实测子代理事件带 agent_id）
    hlog(skip="agent")
    sys.exit(0)
try:
    lines = [l for l in open(base + ".inbox.jsonl", encoding="utf-8").read().splitlines() if l.strip()]
except OSError:
    hlog(new=0, inbox="none")
    sys.exit(0)
try:
    done = int(open(base + ".cursor").read().strip() or 0)
except (OSError, ValueError):
    done = 0
new = lines[done:]
if not new:
    hlog(new=0, cursor=done)
    sys.exit(0)
with open(base + ".cursor", "w") as f:
    f.write(str(len(lines)))
def session_token():
    """cc.py 开会话/续上时给这个会话生成的口令（.cc/<名字>.json 的 token）。没有（访客任务、还没续上过的老会话）就不带。"""
    try:
        with open(base + ".json", encoding="utf-8") as f:
            t = json.load(f).get("token")
        return t if isinstance(t, str) and t else None
    except (OSError, ValueError, AttributeError):
        return None


token = session_token()
tag = f" #{token}" if token else ""      # 外部内容（网页、字幕、文件）也能写出「【她插话 HH:MM】」，口令只在这里和首句说明里有
text = "\n".join(say("interjectLine", t=json.loads(l)['t'][11:16], tag=tag, text=json.loads(l)['text']) for l in new)
text += say("interjectTail")
hlog(new=len(new), cursor=done, to=len(lines), chars=len(text), token=bool(token))
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}},
                 ensure_ascii=False))
