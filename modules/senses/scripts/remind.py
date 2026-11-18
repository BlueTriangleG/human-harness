#!/opt/homebrew/bin/python3
"""remind — reminders: a scheduled job puts one in the queue when its time has come and has the senses look at once; the
senses' remind source lists the ones that came due in the last day. `remind help` prints the commands in the role's
language (the entry "remindUsage" of texts.*.json).
"""
import json
import os
import subprocess
import sys
import time
import uuid

from hh_env import hh, words

say = words(__file__)

WS = hh.workspace
LOG = os.path.join(hh.module_state, "remind.log")
TEST_DIR = os.environ.get("FOCUS_TEST_DIR")   # 测试用：不碰感官层


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as fh:
        fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def arg(args, name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default


# the queue the role's timers put reminders in: config remindersFile, relative to the workspace
REMINDERS = os.path.join(WS, hh.config["remindersFile"]) if hh.config.get("remindersFile") else os.path.join(hh.module_state, "reminders.jsonl")
SENSES = os.path.join(hh.module_dir, "scripts/senses.py")


def cmd_fire(args):
    """定时任务到时间时调：把提醒放进队列，叫感官层马上看一眼。"""
    text, stamp = arg(args, "--text", ""), arg(args, "--set", "")
    rec = {"id": uuid.uuid4().hex[:12], "text": text, "set_at": stamp, "fired": time.time()}
    os.makedirs(os.path.dirname(REMINDERS), exist_ok=True)
    with open(REMINDERS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    if not TEST_DIR:
        subprocess.Popen([sys.executable, SENSES, "--source", "remind"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, cwd=WS)
    log(say("remindFire") % text)
    print("NO_REPLY")


def cmd_due(_):
    """感官层的 remind 源：列出最近一天到时间的提醒（感官层按 id 去重，只有新的才叫醒她）。"""
    cutoff = time.time() - 86400
    try:
        lines = open(REMINDERS, encoding="utf-8").read().splitlines()
    except OSError:
        return
    keep = []
    for l in lines:
        try:
            r = json.loads(l)
        except ValueError:
            continue
        if r.get("fired", 0) < cutoff:
            continue
        keep.append(l)
        print(json.dumps({"id": "remind-" + r["id"],
                          "text": (say("remindOwn", text=r.get("text", "")))[:190],
                          "body": say("remindOwnBody") % (
                              (" " + r["set_at"] + " ") if r.get("set_at") else "", hh.owner, r.get("text", ""))},
                         ensure_ascii=False))
    if len(keep) < len(lines):   # 一天前的清掉
        tmp = REMINDERS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("".join(l + "\n" for l in keep))
        os.replace(tmp, REMINDERS)


def main():
    fn = {"fire": cmd_fire, "due": cmd_due}.get(sys.argv[1] if len(sys.argv) > 1 else "")
    if not fn:
        sys.exit(say("remindUsage"))
    fn(sys.argv[2:])


if __name__ == "__main__":
    main()
