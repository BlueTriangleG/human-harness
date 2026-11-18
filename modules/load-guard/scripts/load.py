#!/usr/bin/env python3
"""这台电脑的负载：看一眼、开重活前过闸、每分钟巡检并在危险时自动减负。

为什么有它（2026-10-22 事故）：16GB 的电脑上同时跑着 主人 的程序、Docker（Honcho）5.5GB、
网关 2.5GB，手机模拟器一开就吃到 8.7GB；10:35 起内存压缩区塞满、交换区涨到 42GB，
电脑每隔几分钟冻住一分钟；16:08 感知层又把模拟器自动开了一次，系统一次杀掉 3400 个进程、
WindowServer 卡死，整台电脑冻了 7 个半小时，最后 主人 只能强制关机。
旧的检查只看「压力等级」和「可用百分比」，那时候它们显示正常（等级 1、可用 58%），
真正满了的是压缩区。所以这里把压缩区、交换区、换入速度一起看。

用法：
  load                    人看的一段（你自己随时可以跑）
  load json               同上，JSON
  load room <种类>         你自己要开东西：够就放行；不够先关能放心关的（LibreTV；浏览器可能正在传东西，不自动关），还不够列出你占内存的，你自己腾
  load gate <种类>         自动开机（感知层，没人看着）用的严格闸：通过退出码 0；不通过退出码 1 并说原因
                          种类：phone（手机模拟器）、cc（新开/续一轮 Claude Code）、heavy（ffmpeg/whisper/批处理）
  load guard              launchd 每 60 秒跑一次：记录、写状态，危险时自动减负（先关手机，再关你最大的重活进程）
  load events             感知层用：打印还没报过的减负事件（JSON 行）
"""
import importlib, json, os, re, signal, subprocess, sys, time
from hh_env import hh, words

M = importlib.import_module("machine_darwin" if sys.platform == "darwin" else "machine_linux")   # this machine's readings
boot_sec, footprint_mb = M.boot_sec, M.footprint_mb

say = words(__file__)

HOME = os.path.expanduser("~")
D = hh.module_state
STATUS = os.path.join(D, "status.json")
HIST = os.path.join(D, "history.jsonl")
EVENTS = os.path.join(D, "events.jsonl")
CURSOR = os.path.join(D, "events.cursor")
GUARD_LOG = os.path.join(D, "guard.log")

GB = 1024 ** 3
RESERVE_MB = 1536          # 永远给系统和 主人 留的余量
# 阈值（16GB 机器）。2026-10-24 改（主人：别为了稳定把效率压太低）：
# 压缩区存 5–7GB 在这台 Mac 上是正常工作状态——10-23 全天如此，换入速度 0，什么都没卡，
# 而那时压缩区只用了它上限的约 21%。v1 拿压缩区 GB 当危险信号，98% 的时间显示偏紧/危险，还误杀了 whisper。
# 真正的危险看：压缩区占上限的比例（vm.compressor.segment）、交换区（10-22 死机前涨到 42GB）、
# 从硬盘换回内存的速度（在抖）、系统自己的压力等级 4、可用内存。
# 10-24 晚 主人：只防死机重启，其余她想怎么用怎么用。所以「危险」只留真正快冻住电脑的线；
# 「偏紧」只是提示，不拦任何事、不触发任何自动动作。
# 10-24 review 后加：电脑 10 分钟内冻过 2 次（最直接的信号）、磁盘快满（交换区要靠磁盘扩）。
# 11-01 主人 嫌太保守（「风扇都没转」）：当天系统压力等级没超过 2、没冻过、可用 ≥34%，手机却因为交换区 30.6GB
# 和一两分钟的换入尖峰（900–2000MB/分）被关了两次。放宽成：交换区 38GB（死机那天 42）、换入 1500MB/分且连着 3 分钟才动手；
# 偏紧也抬高（压缩区 75%、交换区 32GB、换入 600），平常 66% / 26GB 的状态算正常，别整天挂着偏紧让她只敢一件件来。
DANGER = dict(pressure=4, seg_pct=85, avail_pct=8, swap_gb=38, swapin_mb_min=1500, freezes=2, disk_gb=10)
TIGHT = dict(pressure=99, seg_pct=75, avail_pct=15, swap_gb=32, swapin_mb_min=600, freezes=1, disk_gb=25)
# 11-01 晚 主人：「自动关闭的线还是太死了…往极限再 push 一点」。所以「危险」只管不开新重活（含感知层自动开手机——
# 10-22 就是交换区 40 多 GB 时又开手机才冻死的，开新东西要比关东西保守）；已经在跑的东西要碰到下面这组更靠近死机的线、
# 连着 3 分钟才自动关：交换区 42GB（10-22 冻死时的量）、压缩区 92%、可用 5%、每分钟换入 3000MB、冻住 2 次、磁盘剩 8GB。
# 系统压力 4 级且压缩区 ≥70% 照旧立刻关。
SHED = dict(pressure=4, seg_pct=92, avail_pct=5, swap_gb=42, swapin_mb_min=3000, freezes=2, disk_gb=8)
KINDS = {  # 需要的内存(MB)、是否必须「正常」才放行、被减负后冷却多久(分钟)
    "phone": (3072, False, 30),
    "heavy": (1024, False, 0),
    "cc": (1200, False, 0),
}


def sh(*a, timeout=10):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def load_json(p, d):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return d


def save_json(p, v):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(v, f, ensure_ascii=False)
    os.replace(tmp, p)


LABELS = [  # (正则, 名字, 能不能被自动关)
    (r"qemu-system", say("labelPhone"), True),
    (r"com\.apple\.Virtualization", say("labelDocker"), False),
    (r"openclaw.*gateway|dist/index\.js.*gateway", say("labelGateway"), False),
    (r"\bffmpeg\b", "ffmpeg", True),
    (r"whisper", "whisper", True),
    (r"(^|/)claude( |$)|/claude/versions/|\.local/share/claude", "Claude Code", False),
    (r"Google Chrome", say("labelBrowser"), True),
    (r"python", say("labelPython"), True),
    (r"\bnode\b", say("labelNode"), True),
]
# the role's own processes that are never shed and never count as heavy work (module config neverKill: names, matched as text)
OWN = [re.escape(p) for p in hh.config.get("neverKill", [])]
# HH's own processes (the daemon, the console, the direct bridges) are node scripts too, and are never shed
HH_OWN = r"hhd\.ts|console/main\.ts|bridge/\w+/main\.ts"
NEVER_KILL = re.compile("|".join([r"openclaw.*gateway|openclaw-node-worker|load\.py|senses|com\.docker|Virtualization|launchd|loginwindow|WindowServer", HH_OWN, *OWN]))


def label(cmd):
    for pat, name, killable in LABELS:
        if re.search(pat, cmd):
            return name, killable and not NEVER_KILL.search(cmd)
    return os.path.basename(cmd.split(" ")[0]) or "?", False


def procs():
    me = os.environ.get("USER") or sh("id", "-un").strip()
    rows = []
    for line in sh(*M.PS, timeout=15).splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not parts[2].isdigit():
            continue
        rows.append(dict(user=parts[0], pid=int(parts[1]), mb=int(parts[2]) // 1024, cmd=parts[3]))
    mine = [r for r in rows if r["user"] == me]
    # fp (footprint: resident plus compressed and swapped out) is what she takes and what shedding goes by; mb (RSS) is kept as read
    for r in mine:
        fp = footprint_mb(r["pid"])
        r["fp"] = fp if fp is not None else r["mb"]
    by = {}
    for r in mine:
        n, _ = label(r["cmd"])
        by[n] = by.get(n, 0) + r["fp"]
    users = {}
    for r in rows:
        users[r["user"]] = users.get(r["user"], 0) + r["mb"]
    return rows, mine, sorted(by.items(), key=lambda x: -x[1]), users, me


def sample(prev=None, count_freeze=False):
    total_mb = M.total_mb()
    v = M.vm()
    swap_gb = M.swap_used_gb()
    now = time.time()
    mono = M.uptime()  # 系统级、不含睡眠时间：睡眠不会被当成「冻住」
    swapin_rate = 0.0
    if prev and prev.get("swapins") and v["swapins"] and 20 < now - prev.get("t", 0) < 600:
        swapin_rate = max(0, v["swapins"] - prev["swapins"]) * v["page"] / 1024 / 1024 / ((now - prev["t"]) / 60)
    rows, mine, top, users, me = procs()
    comp_b = M.compressed_bytes()
    seg_t, seg_l = M.segments()
    try:
        st_ = os.statvfs(M.DISK)
        disk_gb = round(st_.f_bavail * st_.f_frsize / GB, 1)
    except OSError:
        disk_gb = None
    unknown = [n for n, x in ((say("readPressure"), M.pressure()), (say("readAvail"), M.avail_pct()),
                              (say("readSwap"), swap_gb), (say("readDisk"), disk_gb)) if x is None]
    # 冻结检测：巡检应该每 60 秒一次，两次之间（不算睡眠）隔了 150 秒以上，说明电脑刚冻住过
    freezes = [f for f in (prev or {}).get("freezes", []) if now - f < 600]
    gap = mono - prev["mono"] if prev and prev.get("mono") and prev.get("boot") == boot_sec() else 0
    if count_freeze and gap > 150:
        freezes.append(now)
    s = dict(
        t=now, at=time.strftime("%F %T"), mono=mono, boot=boot_sec(),
        pressure=M.pressure() or 1,
        avail_pct=M.avail_pct() if M.avail_pct() is not None else 50,
        comp_gb=round((comp_b if comp_b is not None else v["comp_pages"] * v["page"]) / GB, 2),
        seg_pct=round(100 * (seg_t or 0) / max(1, seg_l or 1)),
        swap_gb=round(swap_gb or 0, 1),
        disk_gb=disk_gb if disk_gb is not None else 999,
        freezes=freezes, last_gap_s=round(gap), unknown=unknown,
        swapins=v["swapins"],
        swapin_mb_min=round(swapin_rate),
        total_mb=total_mb,
        load1=round(os.getloadavg()[0], 1), ncpu=M.ncpu(),
        mine_gb=round(sum(r.get("fp", r["mb"]) for r in mine) / 1024, 1),  # 含被压缩/换出的部分
        mine_top=[[n, round(mb / 1024, 1)] for n, mb in top[:5] if mb >= 100],
        # 别人的按 RSS 加总（读不到别人的 footprint），共享内存会重复算、压缩掉的不算，只当个大概
        others_gb={(hh.owner if u == hh.config.get("ownerUser") else say("userSystem") if u == "root" else u): round(mb / 1024, 1)
                   for u, mb in users.items() if u != me and mb > 1024},
        phone_on=any("qemu-system" in r["cmd"] for r in mine),
    )
    s["headroom_mb"] = int(s["avail_pct"] / 100 * total_mb) - RESERVE_MB
    why_d = reasons(s, DANGER)
    why_t = reasons(s, TIGHT)
    s["level"] = "danger" if why_d else "tight" if why_t else "ok"
    s["why"] = why_d or why_t
    return s, mine


def reasons(s, th):
    r = []
    if s["pressure"] >= th["pressure"]: r.append(say("whyPressure", pressure=s['pressure']))
    if s.get("seg_pct", 0) >= th["seg_pct"]: r.append(say("whyCompressor", seg_pct=s['seg_pct']))
    if s["avail_pct"] < th["avail_pct"]: r.append(say("whyAvail", avail_pct=s['avail_pct']))
    if s["swap_gb"] >= th["swap_gb"]: r.append(say("whySwap", swap_gb=s['swap_gb']))
    if s["swapin_mb_min"] >= th["swapin_mb_min"]: r.append(say("whySwapin", swapin_mb_min=s['swapin_mb_min']))
    if len(s.get("freezes", [])) >= th["freezes"]: r.append(say("whyFroze", times=len(s['freezes']), gap=s.get('last_gap_s', 0)))
    if s.get("disk_gb", 999) < th["disk_gb"]: r.append(say("whyDisk", disk_gb=s['disk_gb']))
    if th is TIGHT and s.get("unknown"): r.append(say("whyUnknown", list=say("comma").join(s["unknown"])))
    return r


LEVEL_NAME = {"ok": say("levelOk"), "tight": say("levelTight"), "danger": say("levelDanger")}


def brief(s):
    top = say("comma").join(f"{n}{g}" for n, g in s["mine_top"][:4])
    others = say("comma").join(f"{u} {g}GB" for u, g in s["others_gb"].items())
    line = (say("brief", level=LEVEL_NAME[s['level']], avail_pct=s['avail_pct'], comp_gb=s['comp_gb'], seg_pct=s.get('seg_pct', 0), swap_gb=s['swap_gb'], disk_gb=s.get('disk_gb', '?'), load1=s['load1'], ncpu=s['ncpu'], mine_gb=s['mine_gb'], top=say("briefTop", top=top) if top else ""))
    if others: line += say("briefOthers", others=others)
    line += say("briefPhone", state=say("phoneOn") if s["phone_on"] else say("phoneOff"))
    if s["why"]: line += say("briefWhy", list=say("semicolon").join(s["why"]))
    return line


HEAVY_SCRIPT_MB = 1024   # 帮手渲染这类脚本（python/node）吃到这么多就算重活
NOT_HEAVY = re.compile("|".join([r"hhd\.ts|console/main\.ts|load\.py|senses|openclaw", *OWN]))


def media(mine):
    """她正在跑的重活：[(名字, MB)]，MB 按 footprint（含被压缩的）。whisper/ffmpeg 全算；帮手渲染也算：python/node 脚本
    吃到 1GB 以上、无头浏览器（#0017 11-03：自动开手机只等 whisper/ffmpeg，跟帮手的渲染撞到危险线，交换区涨到 36G）。
    大脑、网关、手机、平常开着的浏览器不算。"""
    out = []
    for r in mine:
        name, _ = label(r["cmd"])
        mb = r.get("fp", r["mb"])
        if name in ("whisper", "ffmpeg"):
            out.append((name, mb))
        elif name in (say("labelPython"), say("labelNode")) and mb >= HEAVY_SCRIPT_MB and not NOT_HEAVY.search(r["cmd"]):
            out.append((say("labelRender", name=name), mb))
        elif name == say("labelBrowser") and "--headless" in r["cmd"]:
            out.append((say("labelHeadless"), mb))
    return out


MEDIA_QUIET_SEC = 300  # 大活停了这么久才算跑完（批处理两段之间只空十来秒）


def cooldown_left(kind):
    until = load_json(STATUS, {}).get("cooldown", {}).get(kind, 0)
    return max(0, int((until - time.time()) / 60))


def gate(kind):
    if kind == "cc-light":
        # 用户2026-10-23明确要求资源紧时换轻量做法继续。仅代码/小fixture，
        # 不放行媒体重活；保留原heavy/phone阈值和自动减负。
        s, _ = sample(load_json(STATUS, {}))
        bad = s["level"] == "danger" or s["headroom_mb"] < 1200  # 10-24：跟着新的危险判定走
        return not bad, (say("lightRefused") if bad else say("lightAllowed")) + brief(s)
    need, must_ok, _ = KINDS.get(kind, KINDS["heavy"])
    prev = load_json(STATUS, {})
    s, mine = sample(prev if time.time() - prev.get("t", 0) < 600 else None)
    left = cooldown_left(kind)
    if left:
        return False, say("gateCooldown", kind=kind, left=left, brief=brief(s))
    if s["level"] == "danger":
        return False, say("gateDanger", brief=brief(s))
    if kind == "phone":
        # 00:20 10-23 实测：登录后几分钟各服务同时启动，那一刻看着正常、一分钟后压缩区冲到 6.4GB。
        # 所以开手机要求开机满 15 分钟、而且巡检最近 3 次都是正常。
        b = boot_sec()
        up_min = (time.time() - b) / 60 if b else 999
        if up_min < 15:
            return False, say("gateJustBooted", minutes=int(up_min), brief=brief(s))
        try:
            recent = [json.loads(l) for l in open(HIST).read().splitlines()[-3:]]
        except Exception:
            recent = []
        if len(recent) < 3 or any(r.get("level") == "danger" for r in recent):
            return False, say("gateUnsteady", brief=brief(s))
        # 10-31 主人 要手机常开、稳定回小红书私信。whisper（medium 模型 CPU 跑，约 4GB）和手机（约 4GB）一起开，
        # 当天 16:18 实测每分钟换入 1.5GB、进了危险。所以自动开机先等这类大活跑完；她自己 phone.py start 走 room，不受这条限制。
        m = media(mine)
        if sum(mb for _, mb in m) >= 2048:
            what = say("comma").join(f"{n} {mb / 1024:.1f}GB" for n, mb in m if mb >= 100)
            return False, say("gateMediaRunning", what=what, brief=brief(s))
        # 16:47 那次：配音检查一段段跑 whisper，自动开机挑在两段之间的空当开了，下一段一起来就进危险、手机被关。
        quiet = time.time() - prev.get("media_at", 0)
        if quiet < MEDIA_QUIET_SEC:
            return False, say("gateMediaQuiet", seconds=int(quiet), minutes=MEDIA_QUIET_SEC // 60, brief=brief(s))
    if must_ok and s["level"] != "ok":
        return False, say("gateTight", kind=kind, need=need // 1024, brief=brief(s))
    if s["headroom_mb"] < need:
        return False, say("gateNoRoom", reserve=RESERVE_MB / 1024, left=max(0, s['headroom_mb']) // 1024, kind=kind, need=need // 1024, brief=brief(s))
    warn = say("gateWarn", list=say("semicolon").join(s['why'])) if s["level"] == "tight" else ""
    return True, say("gateOk", warn=warn, brief=brief(s))


DOCKER = "/Applications/Docker.app/Contents/Resources/bin/docker"
ROOM_NEED = {"phone": 3072, "heavy": 1024, "cc": 1024}
NAMES = {"phone": say("kindPhone"), "heavy": say("kindHeavy"), "cc": say("kindCc")}


def free_safe(mine):
    """关掉能放心关的：LibreTV。返回做了什么。
    浏览器不再自动关（11-02）：帮手可能正用它投稿、填表，关了就白干（11-01 晚开手机时就把正在用的浏览器关了）。
    不够时它会出现在下面的清单里，你自己看它闲着再关。"""
    done = []
    env = dict(os.environ, DOCKER_HOST=f"unix://{HOME}/.docker/run/docker.sock")
    try:
        names = subprocess.run([DOCKER, "ps", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=10, env=env).stdout.split()
        if "libretv" in names:
            subprocess.run([DOCKER, "stop", "libretv"], capture_output=True, timeout=30, env=env)
            done.append(say("freeLibretv"))
    except Exception:
        pass
    return done


def your_list(mine):
    rows = []
    for r in sorted(mine, key=lambda r: -r.get("fp", r["mb"])):
        mb = r.get("fp", r["mb"])
        if mb < 200: continue
        n, _ = label(r["cmd"])
        core = re.search(r"openclaw.*gateway|openclaw-node-worker|Virtualization|com\.docker", r["cmd"])
        rows.append(f"  pid {r['pid']:>6}  {mb / 1024:4.1f}GB  {n}{say('listResident') if core else ''}  {r['cmd'][:90]}")
    return "\n".join(rows[:12]) or say("listNone")


def room(kind):
    """你自己要开东西：够就开；不够先关能放心关的；还不够就列出你占内存的东西，你自己决定关哪个。"""
    need = ROOM_NEED.get(kind, 2048)
    prev = load_json(STATUS, {})
    s, mine = sample(prev if time.time() - prev.get("t", 0) < 600 else None)
    if s["level"] != "danger" and s["headroom_mb"] >= need:
        return True, say("roomOk", brief=brief(s))
    freed = free_safe(mine)
    if freed:
        time.sleep(6)
        s, mine = sample(None)
        if s["level"] != "danger" and s["headroom_mb"] >= need:
            return True, say("roomFreed", list=say("comma").join(freed), brief=brief(s))
    short = max(0, need - s["headroom_mb"])
    why = say("roomDanger", list=say("semicolon").join(s['why'])) if s["level"] == "danger" \
        else say("roomShort", short=short / 1024, kind=NAMES.get(kind, kind), need=need // 1024, reserve=RESERVE_MB / 1024)
    msg = say("roomFirst", kind=NAMES.get(kind, kind), why=why)
    if freed: msg += say("roomAlready", list=say("comma").join(freed))
    msg += say("roomYours", list=your_list(mine))
    msg += say("roomHow")
    msg += f"\n{brief(s)}"
    return False, msg


def log(msg):
    os.makedirs(os.path.dirname(GUARD_LOG), exist_ok=True)
    with open(GUARD_LOG, "a") as f:
        f.write(f"{time.strftime('%F %T')} {msg}\n")


def event(text, body):
    os.makedirs(D, exist_ok=True)
    with open(EVENTS, "a") as f:
        f.write(json.dumps({"t": time.strftime("%F %T"), "text": text, "body": body}, ensure_ascii=False) + "\n")


def kill_phone(mine):
    pids = [r["pid"] for r in mine if "qemu-system" in r["cmd"]]
    sh("phone", "stop", "--force", timeout=8)   # the role's phone command; sh() skips it when there is none
    time.sleep(3)
    for pid in pids:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    return pids


def sheddable(mine):
    """Her processes that may be shed, [(MB, pid, name, command)], MB by footprint: on 11-17 an ffmpeg grew to 47GB nearly all
    compressed and swapped out, under 700MB resident, so going by RSS found no one and the kernel killed it."""
    out = []
    for r in mine:
        n, killable = label(r["cmd"])
        mb = r.get("fp", r["mb"])
        if killable and mb >= 700:
            out.append((mb, r["pid"], n, r["cmd"][:160]))
    return out


def runaways(s, mine):
    """one process bigger than the whole machine's memory: the machine is about to freeze, so it is stopped at once"""
    return [c for c in sheddable(mine) if c[0] >= s["total_mb"]]


def shed(s, mine, st):
    """危险时每次只做一步，下一分钟再看。返回做了什么（没做返回空）。"""
    big = runaways(s, mine)   # a process bigger than the machine's memory goes first, before the phone
    if s["phone_on"] and not big:
        kill_phone(mine)
        st.setdefault("cooldown", {})["phone"] = time.time() + KINDS["phone"][2] * 60
        return say("shedPhone")
    cands = big or sheddable(mine)
    if not cands:
        return ""
    mb, pid, n, cmd = max(cands)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return ""
    st.setdefault("cooldown", {})["heavy"] = time.time() + KINDS["heavy"][2] * 60
    return say("shedRunaway" if big else "shedBiggest", name=n, pid=pid, gb=mb // 1024, tenth=mb % 1024 * 10 // 1024,
               total=s["total_mb"] // 1024, cmd=cmd)


def notify_owner(text):
    """A Mac notification, and hh send to the owner by name (HH finds the owner's address)."""
    title = say("notifyTitle")
    sh("osascript", "-e", f'display notification {json.dumps(text)} with title "{title}"')
    try:
        subprocess.Popen([hh.hh_bin, "send", hh.owner, f"[{title}] " + text],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        log(f"notify_owner failed: {e}")


def guard():
    st = load_json(STATUS, {})
    s, mine = sample(st, count_freeze=True)
    s["cooldown"] = {k: v for k, v in st.get("cooldown", {}).items() if v > time.time()}
    streak = st.get("danger_streak", 0) + 1 if s["level"] == "danger" else 0
    tstreak = st.get("tight_streak", 0) + 1 if s["level"] != "ok" else 0
    s["danger_streak"], s["tight_streak"] = streak, tstreak
    s["shed_why"] = reasons(s, SHED)
    sstreak = s["shed_streak"] = st.get("shed_streak", 0) + 1 if s["shed_why"] else 0
    s["media_at"] = time.time() if sum(mb for _, mb in media(mine)) >= 1024 else st.get("media_at", 0)  # 给 gate phone 看
    did = ""
    # 碰到「自动关」的线（SHED，比危险更靠近死机）连着三分钟才动手，一两分钟的尖峰不动；压力等级已经到 4 且压缩区快满就立刻动手
    # one of her processes bigger than the machine's memory is stopped at once too (11-17: an ffmpeg reached 47GB in three minutes)
    sheds = hh.config.get("shed", True) is not False   # 一台机器只让一个角色减负、叫主人；别的角色的巡检只看
    if sheds and (sstreak >= 3 or (s["pressure"] >= 4 and s.get("seg_pct", 0) >= 70) or runaways(s, mine)):
        did = shed(s, mine, s)
    s["notified_owner"] = st.get("notified_owner", 0)
    if sheds and not did and sstreak >= 5 and time.time() - s["notified_owner"] > 6 * 3600:
        notify_owner(say("notifyOwner", streak=streak, others=', '.join(f'{u} {g}GB' for u, g in s['others_gb'].items()), why=say("semicolon").join(s['why'])))
        s["notified_owner"] = time.time()
        log(say("logNotified", brief=brief(s)))
    if did:
        s["last_action"] = f"{s['at']} {did}"
        log(f"[{s['level']}] {did} | {brief(s)}")
        event(say("shedEvent", level=LEVEL_NAME[s['level']], did=did, at=s['at']),
              say("shedBody", did=did, brief=brief(s)))
    else:
        s["last_action"] = st.get("last_action")
        if s["level"] != st.get("level"):
            log(f"[{s['level']}] {brief(s)}")
    save_json(STATUS, s)
    # 历史：每分钟一行，保留约一天
    with open(HIST, "a") as f:
        f.write(json.dumps({k: s.get(k) for k in ("at", "level", "pressure", "avail_pct", "comp_gb", "seg_pct", "swap_gb", "disk_gb", "last_gap_s", "swapin_mb_min", "mine_gb", "phone_on")}, ensure_ascii=False) + "\n")
    try:
        if os.path.getsize(HIST) > 400_000:
            lines = open(HIST).readlines()[-1440:]
            open(HIST, "w").writelines(lines)
    except OSError:
        pass


def events():
    try:
        lines = open(EVENTS).read().splitlines()
    except FileNotFoundError:
        return
    n = int(open(CURSOR).read().strip() or 0) if os.path.exists(CURSOR) else 0
    for l in lines[n:]:
        try:
            e = json.loads(l)
            print(json.dumps({"text": e["text"], "body": e.get("body", "")}, ensure_ascii=False))
        except Exception:
            pass
    with open(CURSOR, "w") as f:
        f.write(str(len(lines)))


def main():
    a = sys.argv[1:]
    cmd = a[0] if a else "show"
    if cmd == "guard":
        guard()
    elif cmd == "events":
        events()
    elif cmd == "room":
        ok, msg = room(a[1] if len(a) > 1 else "heavy")
        print(msg)
        sys.exit(0 if ok else 1)
    elif cmd == "gate":
        ok, msg = gate(a[1] if len(a) > 1 else "heavy")
        print(msg)
        sys.exit(0 if ok else 1)
    elif cmd == "json":
        s, _ = sample(load_json(STATUS, None))
        print(json.dumps(s, ensure_ascii=False, indent=1))
    else:
        st = load_json(STATUS, {})
        s, _ = sample(st if time.time() - st.get("t", 0) < 600 else None)
        print(brief(s))
        print(say("showRoom", room=max(0, s['headroom_mb']) // 1024, reserve=RESERVE_MB / 1024))
        if st.get("last_action"):
            print(say("showLast", what=st["last_action"]))


if __name__ == "__main__":
    main()
