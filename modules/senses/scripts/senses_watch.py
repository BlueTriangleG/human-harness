#!/opt/homebrew/bin/python3
"""她的感官层·监听器：常驻，有动静立刻触发 senses.py 跑对应的事件源，不用等下一次轮询。

配置在 senses/senses.json 的 "watchers"，每个监听器：
  {"id": "xhs-logcat", "type": "logcat", "buffer": "events",
   "match": "notification_enqueue.*com\\.xingin\\.xhs", "source": "xhs"}
  type=logcat   盯安卓系统日志（新通知会实时出现在 events 缓冲区），匹配到就跑 senses.py --source <source>
  type=command  常驻跑一条命令，每输出一行匹配 match 的就触发（以后接别的事件流用）
  type=mac_badge 每 interval 秒（默认 5）看一次 Mac App 的未读数（scripts/mac_badge.py），变了且不为 0 就触发
手机关着 / 命令退出就隔 15 秒重连。
HH keeps it up (the senses module's process watch: started again 10 s after it ends). The table is the one HH writes
each round; when the watchers in it change, this ends and comes back up on the new ones.
"""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

from hh_env import hh

WS = hh.workspace
CFG = os.path.join(hh.module_state, "senses.json")
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
PY = sys.executable
SENSES = os.path.join(hh.module_dir, "scripts/senses.py")
MIN_TRIGGER_GAP = 2.0   # 同一个源 2 秒内的多次触发合成一次（senses.py 自己还会攒 15 秒再叫醒）

_last = {}
_lock = threading.Lock()
_streams = []   # the streams' processes, killed when this ends


def log(*a):
    print(time.strftime("%F %T"), *a, file=sys.stderr, flush=True)


def trigger(source):
    with _lock:
        now = time.time()
        if now - _last.get(source, 0) < MIN_TRIGGER_GAP:
            return False
        _last[source] = now
    with open(os.path.join(hh.module_state, "senses.log"), "a") as log:
        subprocess.Popen([PY, SENSES, "--source", source], stdout=log, stderr=log, start_new_session=True)
    return True


def emulator_serial():
    try:
        out = subprocess.run([ADB, "devices"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) == 2 and parts[1] == "device" and parts[0].startswith("emulator-"):
            return parts[0]
    return None


def stream(cmd, pattern, source, wid):
    rx = re.compile(pattern)
    pr = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                          encoding="utf-8", errors="replace")
    _streams.append(pr)
    log(wid, "listening")
    try:
        for line in pr.stdout:
            if rx.search(line) and trigger(source):
                log(wid, "triggered", source)
    finally:
        pr.kill()
        _streams.remove(pr)
    log(wid, "stream ended")


def watch_badge(w):
    log(w["id"], "watching badge", w.get("ax_label") or w.get("bundle_id"))
    last = mac_badge.read(w)
    while True:
        time.sleep(w.get("interval", 5))
        try:
            cur = mac_badge.read(w)
        except Exception as e:
            log(w["id"], "read error", str(e)[:120]); cur = None
        # 只要变了且不为 0 就交给 senses.py，由它判断是不是「变多了」
        if cur and cur != last and trigger(w["source"]):
            log(w["id"], "triggered", w["source"], cur)
        if cur is not None:
            last = cur


def run_watcher(w):
    while True:
        try:
            if w["type"] == "logcat":
                serial = emulator_serial()
                if not serial:
                    time.sleep(15)
                    continue
                # -T 1：只要从现在起的新日志，不回放旧的
                stream([ADB, "-s", serial, "logcat", "-b", w.get("buffer", "events"), "-T", "1"],
                       w["match"], w["source"], w["id"])
            elif w["type"] == "mac_badge":
                watch_badge(w)
            elif w["type"] == "command":
                stream(w["cmd"] if isinstance(w["cmd"], list) else ["/bin/sh", "-c", w["cmd"]],
                       w["match"], w["source"], w["id"])
            else:
                log(w["id"], "unknown watcher type", w["type"])
                return
        except Exception as e:
            log(w.get("id"), "error", str(e)[:200])
        time.sleep(15)


def enabled_watchers():
    try:
        return [w for w in json.load(open(CFG)).get("watchers", []) if w.get("enabled", True)]
    except Exception as e:
        log("config", e)
        return None


def stop_streams_and_exit(*_):
    """HH stops this by its record (TERM to this process only): the streams' processes (adb logcat …) go with it"""
    for pr in list(_streams):
        pr.kill()
    os._exit(0)


def main():
    signal.signal(signal.SIGTERM, stop_streams_and_exit)
    watchers = enabled_watchers() or []
    if not watchers:
        log("no watchers configured; idle")
    for w in watchers:
        threading.Thread(target=run_watcher, args=(w,), daemon=True).start()
    while True:
        time.sleep(20)
        now = enabled_watchers()
        if now is not None and now != watchers:
            log("watchers changed; ending to start again on them")
            for pr in list(_streams):
                pr.kill()
            return


if __name__ == "__main__":
    main()
