#!/opt/homebrew/bin/python3
"""她的感官层：不用模型，定时看各种事件源，有新动静就叫醒我。

源表：<模块状态目录>/senses.json（感官模块每轮从各模块的配置合成）
状态：<模块状态目录>/state.json（看过的东西、上次叫醒时间）
记录：<模块状态目录>/events.jsonl（每个事件一行）
感官模块每 20 秒跑一轮；常驻的 senses_watch.py 有通知立刻触发。手动：
  senses          # 跑一轮
  senses --dry    # 只看会触发啥，不叫醒、不记
  senses --list   # 列出事件源

交给 HH：新事件写进一个文件，hh sense --file 交给 HH 的闸门；HH 收下（返回 ok）就算确认。
事件的字段和交法是一份约定，和 HH 的解析共用：docs/contracts/senses.md。
同一条事件没确认按 3/10/30 分钟重试，最多叫 3 次。
测试：scripts/test_senses.py

事件源类型：
  xhs_notify   小红书通知（手机开着才查；dumpsys notification 里 com.xingin.xhs 的标题+正文）
  phone_net    手机断网（手机开着就每轮 phone.py net 查一次；连着两轮没网就后台 phone.py net --fix；断过就报）
  web          抓网页，用 pattern（正则，第一个分组当条目）找新条目
  command      跑一条 shell 命令，每行输出算一个条目，新行就是新事件
  mac_badge    Mac App 的未读数（scripts/mac_badge.py：bundle_id 读 Dock 角标，或 ax_process+ax_label 读窗口里的数字），变大就是新事件
"""
import contextlib, fcntl, hashlib, json, os, re, subprocess, sys, tempfile, time, urllib.request
from hh_env import forms, hh, words

say = words(__file__)
form = forms(__file__)

WS = hh.workspace
D = hh.module_state   # the table HH writes each round, and the logs
# what the rounds keep (state, events, the lock, the wake-up handed over): config dataDir, relative to the workspace
DATA = os.path.join(WS, hh.config["dataDir"]) if hh.config.get("dataDir") else D
CFG = os.path.join(D, "senses.json")
STATE, LOG = os.path.join(DATA, "state.json"), os.path.join(DATA, "events.jsonl")
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
WAKE_MSG, WAKE_OUT = os.path.join(DATA, ".wake-msg.txt"), os.path.join(DATA, "last_wake.json")
WAKE_LOG = os.path.join(D, "wake.log")
SENSES_LOG = os.path.join(D, "senses.log")

def clean_env():
    """干净的环境：只带系统那几样、PATH，和 HH 给的（HH_*、PYTHONPATH）。别人调起我时会带着自己的变量
    （OPENCLAW_*、XPC_SERVICE_NAME 等），10-25 查到这时第一次叫醒不生效，所以叫醒、补查、探测都用干净环境。"""
    env = {k: os.environ[k] for k in ("USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "PATH", "PYTHONPATH") if k in os.environ}
    env.update({k: v for k, v in os.environ.items() if k.startswith("HH_")})
    env["HOME"] = os.path.expanduser("~")
    return env

def wake_log(rec):
    """每次叫醒记一行：派了哪些事件、丢掉了哪些继承来的变量、结果如何。只记 id 和状态，不记内容。"""
    try:
        with open(WAKE_LOG, "a") as f: f.write(json.dumps(dict(t=time.strftime("%Y-%m-%d %H:%M:%S"), **rec), ensure_ascii=False) + "\n")
    except OSError:
        pass
RETRY_GAPS = (180, 600, 1800)   # 同一条事件没确认时的重试间隔；叫满 3 次就不再单独为它叫醒

def load(p, d):
    try: return json.load(open(p))
    except Exception: return d

def h(s): return hashlib.sha1(s.encode()).hexdigest()[:16]

def save_state(st):
    os.makedirs(DATA, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".state-", dir=DATA)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, STATE)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

@contextlib.contextmanager
def state_lock(wait_sec=0):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, ".poll.lock"), "a") as f:
        deadline = time.time() + wait_sec
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); break
            except BlockingIOError:
                if time.time() >= deadline:
                    yield False
                    return
                time.sleep(0.5)
        try: yield True
        finally: fcntl.flock(f, fcntl.LOCK_UN)

def report_error(source, error):
    # Commands/dumps can contain private messages: never log their output here.
    print(time.strftime("%F %T"), source, "ERROR", str(error)[:300], file=sys.stderr, flush=True)

PHONE_IDLE_HOME_SEC = 120   # 手机多久没碰、又停在小红书里，就按 Home（10-14 主人：2 分钟）
PHONE_IN_USE_SEC = 60       # 叫醒交接完顺手按 Home 前，手机这么久内被 phone.py 碰过就算「有人正在用」，先不按（11-11）

PHONE_PATTERN = "[q]emu-system-aarch64.*-avd " + hh.config.get("phoneAvd", "")  # 10-31：只认真的模拟器程序，别的 pgrep/awk 的命令行不会被当成手机（见 phone.py EMU_PATTERN）

def phone_on():
    return subprocess.run(["pgrep", "-f", PHONE_PATTERN], capture_output=True).returncode == 0

def phone_pid():
    r = subprocess.run(["pgrep", "-f", PHONE_PATTERN], capture_output=True, text=True)
    return (r.stdout.split() or [""])[0]

# 手机关了超过这么久再开，就叫我去消息页补看一眼。11-02 从 10 分钟降到 4 分钟：11-01 22:31 被关了 6 分钟，
# 那几分钟来的微信没人补看（感知层两分钟一轮，重启一下手机算出来也就两三分钟，不会误报）
PHONE_CATCHUP_SEC = 240

def phone_catchup(src):
    """10-31：手机关着时来的小红书私信，开机后不一定补发通知（主人 妈妈周一、周四两条就这么漏的，他来问才知道）。
    所以手机关了 10 分钟以上再开（模拟器进程换了），多给一条「去消息页看一眼」。"""
    st = src["_st"].setdefault("xhs_phone", {})
    pid, now = phone_pid(), time.time()
    if not pid: return []
    out = []
    off = now - st.get("last_on", 0)
    if pid != st.get("pid") and off > PHONE_CATCHUP_SEC:
        how = say("phoneOffLong") if not st.get("last_on") else say("phoneOffHours", hours=off / 3600) if off >= 3600 else say("phoneOffMinutes", minutes=int(off // 60))
        # system：这条是脚本自己生成的系统提示，不是谁发来的消息（控制台见了它、又没有会话名和发话人才不当私聊遮；11-12 闸门）
        out.append({"id": h(f"phone-boot:{pid}:{int(now)}"), "system": True,
                    "text": say("phoneJustOn", how=how)})
    if not src.get("_dry"): st.update(pid=pid, last_on=now)
    return out

def phone_idle_sec():
    # 只看 .last_used（phone.py 每条命令开始和结束都会碰它），和 phone_idle_stop.sh 一样。
    # 10-14 以前取的是整个 memory/phone 目录里最新的文件，包括模拟器自己写的 emulator.log：
    # 这里每 2 分钟 adb 一次，模拟器就往里写一行 "adb protocol fault"，闲置时间永远到不了阈值，
    # 小红书一直停在聊天页，私信不弹通知。
    try:
        return time.time() - os.path.getmtime(os.path.join(WS, "memory/phone/.last_used"))
    except Exception: return 1e9

def life_active():
    return bool(load(os.path.join(WS, "memory/life/session.json"), {}).get("active"))

_SERIAL = []
def emulator_serial():
    """第一台在线的模拟器（以前写死 emulator-5584，换了端口就瞎了）。"""
    if not _SERIAL:
        out = subprocess.run([ADB, "devices"], capture_output=True, text=True, timeout=10).stdout
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) == 2 and parts[1] == "device" and parts[0].startswith("emulator-"):
                _SERIAL.append(parts[0]); break
    return _SERIAL[0] if _SERIAL else "emulator-5584"

def adb(*a, timeout=6):
    r = subprocess.run([ADB, "-s", emulator_serial(), *a], capture_output=True, timeout=timeout)
    if r.returncode: raise RuntimeError(f"adb exited {r.returncode}; device unavailable or command failed")
    return r.stdout.decode("utf-8", "replace")

def home_if_idle_in(pkg, src):
    # 聊天 app 在前台时，新消息只在 app 里冒红点，不发系统通知（10-13 主人 发「哈咯」我没收到就是这个；微信停在聊天页也一样）。
    # 所以：我 2 分钟没碰手机、也不在自由时间里，又停在这个 app 里，就按 Home 把它放到后台，通知才会弹。
    # （10-13 曾改成 10 分钟，嫌回完私信想一想就被按回桌面；10-14 主人 定回 2 分钟，并让我用完手机自己回 Home。）
    top = adb("shell", "dumpsys", "activity", "activities")
    if "topResumedActivity=ActivityRecord" in top and f"{pkg}/" in top.split("topResumedActivity=", 1)[1].split("\n", 1)[0]:
        if not src.get("_dry") and phone_idle_sec() > PHONE_IDLE_HOME_SEC and not life_active():
            adb("shell", "input", "keyevent", "KEYCODE_HOME")

def src_xhs(src):
    if not phone_on(): return None  # None = 这轮没法看，不算「没东西」
    home_if_idle_in("com.xingin.xhs", src)
    return parse_xhs(adb("shell", "dumpsys", "notification", "--noredact")) + phone_catchup(src)

def src_wx(src):
    if not phone_on(): return None
    home_if_idle_in("com.tencent.mm", src)
    return parse_wx(adb("shell", "dumpsys", "notification", "--noredact"))

PHONE_NET_RETRY_SEC = 1800  # 派出去的修理（phone.py net --fix）最多半小时一次；重启手机也最多半小时一次
PHONE_NET_STALE_SEC = 300   # 上次查到有网是两轮多以前，就不拿它当断网起点
PHONE_NET_LONG_SEC = 1800   # 断网超过半小时，修好了也叫醒本人；修理跑了一刻钟还没好就先报（主人和一个帮手会话 11-03）
NET_CATCHUP = say("netCatchup")

def phone_starting():
    """phone.py start 正在开机：它自己会等网、修网（ensure_net），这时别再派一个修理去抢。"""
    return subprocess.run(["pgrep", "-f", "[p]hone.py start"], capture_output=True).returncode == 0

def _hm(t): return time.strftime("%H:%M", time.localtime(t))

def net_back_event(st, fix, now):
    mins = max(1, round((now - st["bad_since"]) / 60))
    alarm = now - st["bad_since"] >= PHONE_NET_LONG_SEC or st.get("told_fail")
    tag = say("netTagAlarm") if alarm else say("netTagFixed")
    how = {"wifi": say("netFixedWifi"), "reboot": say("netFixedReboot")}.get(fix.get("how"), say("netFixedNow"))
    ev = {"id": h(f"phone-net:{int(st['bad_since'])}:back"),
          "text": say("netBack", tag=tag, mins=mins, hm=_hm(st['bad_since']), why=st.get('why') or say("netWhyUnknown"), how=how, catchup=NET_CATCHUP)}
    if alarm: ev["alarm"] = True
    return ev

def net_fail_event(st, fix, now):
    mins = max(1, round((now - st["bad_since"]) / 60))
    if not fix:
        tried, todo = say("netTriedAuto"), say("netTodoAuto")
    elif st.get("fix_reboot"):
        tried, todo = say("netTriedBoth"), say("netTodoBoth")
    else:
        tried, todo = say("netTriedWifi"), say("netTodoWifi")
    return {"id": h(f"phone-net:{int(st['bad_since'])}:fail"),
            "text": say("netFail", hm=_hm(st['bad_since']), mins=mins, why=st.get('why'), tried=tried, todo=todo),
            "alarm": True}

def src_phone_net(src):
    """11-03：手机 03:28 开机就没网，一直到 10:59 才被她自己看见（11-02 09:4x 群里 @ 她没回，也是 主人 先发现的）；
    开机那次检查修不好时，报错进了 /dev/null。现在手机开着就每轮查一次（phone.py net），连着两轮没网就在后台修
    （phone.py net --fix：先关开 wifi，不行重启手机；她两分钟内碰过手机就不重启）。断过就报一条：断了多久、要补看什么。
    修好了的走分拣（[手机断网·已修好]）；断了半小时以上、或者修不好，叫醒本人（[手机断网·要你处理]）。"""
    st = src["_st"].setdefault("phone_net", {})
    if src.get("_dry"): st = dict(st)
    now = time.time()
    if not phone_on():
        st.update(last_ok=0, bad_since=0, bad_n=0, fix_at=0, told_fail=0)  # 关机不算断网，下次开机重新算
        return []
    if phone_starting(): return []
    r = subprocess.run(["phone", "net"],
                       capture_output=True, text=True, timeout=90, env=clean_env())
    if r.returncode == 3: return []  # 正在开机、重启（比如修理正在重启手机）
    fix = load(os.path.join(WS, "memory/phone/.net_fix.json"), {})
    fixed = bool(st.get("fix_at")) and fix.get("at", 0) >= st["fix_at"]  # 派出去的修理跑完了
    if r.returncode == 0:
        out = [net_back_event(st, fix if fixed else {}, now)] if st.get("bad_since") else []
        st.update(last_ok=now, bad_since=0, bad_n=0, fix_at=0, told_fail=0)
        return out
    # 从上次确认有网的时候起算；那次太久以前（感官层停过一阵、电脑睡过）就从这次算，免得断两分钟报成断了几十分钟（复核时定的）
    last_ok = st.get("last_ok") or 0
    st["bad_since"] = st.get("bad_since") or (last_ok if now - last_ok <= PHONE_NET_STALE_SEC else now)
    st["bad_n"] = st.get("bad_n", 0) + 1
    st["why"] = (r.stdout.strip().splitlines() or [r.stderr.strip()])[0].removeprefix("没网：")[:150]
    out = []
    if not st.get("told_fail") and (fixed or now - st["bad_since"] >= PHONE_NET_LONG_SEC / 2):
        out.append(net_fail_event(st, fix if fixed else {}, now)); st["told_fail"] = 1
    if st["bad_n"] >= 2 and (not st.get("fix_at") or now - st["fix_at"] >= PHONE_NET_RETRY_SEC):
        reboot = phone_idle_sec() > PHONE_IDLE_HOME_SEC and (not st.get("last_reboot") or now - st["last_reboot"] >= PHONE_NET_RETRY_SEC)
        st.update(fix_at=now, fix_reboot=reboot)
        if reboot: st["last_reboot"] = now
        if not src.get("_dry"):
            log = open(os.path.join(WS, "memory/phone/net_fix.log"), "a")
            subprocess.Popen(["phone", "net", "--fix"] + ([] if reboot else ["--no-reboot"]),
                             stdout=log, stderr=log, start_new_session=True, env=clean_env())
            log.close()
    return out

# 小红书内容推送的标题：「<我的昵称>，你好」「@作者 [你点赞过]」「你的关注：@作者」「@某人 [可能认识]」。
# 私信是「某某 私信你」，评论/@ 另有格式，都不会撞上这几个。
XHS_NAME = hh.config.get("xhsName", "")   # 角色自己在小红书上的昵称：内容推送的标题是「<昵称>，你好」
XHS_PUSH_RE = re.compile(r"^(" + (re.escape(XHS_NAME) + r"(，你好)?$|" if XHS_NAME else "")
                         + r"你的关注([:：]|$)|@.*\[(你点赞过|可能认识|你收藏过|你可能感兴趣)\]$)")

def notifications(out, pkg):
    """dumpsys notification --noredact 里 pkg 发的通知：[{channel, title, text, id, legacy_id}]。
    id = key+标题+正文 再加发出时间（同一条通知内容更新了也算新的）；小红书 10-16 起就是这么算的，改了 seen 就对不上。"""
    if "Notification Manager State" not in out and "NotificationRecord(" not in out:
        raise RuntimeError("notification dump unavailable or unrecognized; not an empty notification list")
    recs = []
    for blk in re.split(r"\n\s*NotificationRecord\(", out)[1:]:
        head = blk.split("\n", 1)[0]
        if f"pkg={pkg} " not in head: continue
        t = re.search(r"android\.title=String \((.*)\)", blk)
        x = re.search(r"android\.text=String \((.*)\)", blk)
        if not t: continue
        k = re.search(r"key=(\S+)", blk)
        post = re.search(r"\bpostTime=(\d+)", blk)
        ch = re.search(r"channel=(\S+)", head)
        title, text = t.group(1), (x.group(1) if x else "")
        legacy = h((k.group(1) if k else "") + title + text)
        recs.append({"channel": ch.group(1) if ch else "", "title": title, "text": text,
                     "id": h(legacy + ":" + post.group(1)) if post else legacy, "legacy_id": legacy})
    return recs

_UNREAD_RE = re.compile(r"^\[(\d+)条\]")
_NOTICE_AT_ME = "[有人@我]"
_SENDER_RE = re.compile(r"^([^:：\n]{1,30}): ")

NOT_ME = [x.strip() for x in hh.config.get("notMe", []) if x.strip()]

def at_me(text):
    return any(not any(text.startswith(n, m.start() + 1) for n in NOT_ME) for m in re.finditer("@" + re.escape(hh.me), text))

def notify_item(title, text, id, **extra):
    """通知 → 事件条目。text 必须保持 f"{title}：{text}"（事件 id 不能变）；
    另外解析出 conv/sender/isGroup/mentionsMe/unread，HH 的闸门直接用。
    mentionsMe 与 HH 同规则（src/gate/parse.ts）：「@<我的名字>」处的文字不以 notMe 里的哪一个开头，或正文（去掉 [N条]）以 [有人@我] 开头。"""
    m = _UNREAD_RE.match(text)
    unread, body = (int(m.group(1)), text[m.end():]) if m else (1, text)
    notice = body.startswith(_NOTICE_AT_ME)
    sm = _SENDER_RE.match(body[len(_NOTICE_AT_ME):] if notice else body)
    it = {"id": id, "text": f"{title}：{text}", "conv": title, "sender": sm.group(1) if sm else title,
          "isGroup": bool(sm), "mentionsMe": notice or at_me(text), "unread": unread}
    it.update(extra)
    return it

def wx_item(title, text, id, **extra): return notify_item(title, text, id, **extra)
_XHS_DM_TAIL = re.compile(r" ?私信你$")

def xhs_item(title, text, id, **extra):
    """小红书私信的通知标题是「某某 私信你」：会话名/发话人只留「某某」，HH 的闸门才认得出人（11-03）。
    text 照旧用原标题拼（事件 id 不能变）。"""
    it = notify_item(title, text, id, **extra)
    name = _XHS_DM_TAIL.sub("", title).strip()
    if name and name != title:
        it["conv"] = name
        if it["sender"] == title: it["sender"] = name
    return it

def parse_xhs(out):
    # 内容推送/好友推荐不是私信，不叫醒（10-15/16 连着被这种叫醒四次）
    return [xhs_item(r["title"], r["text"], r["id"], legacy_id=r["legacy_id"])
            for r in notifications(out, "com.xingin.xhs") if not XHS_PUSH_RE.search(r["title"].strip())]

# 微信的通知渠道：新消息 message_channel_new_id、语音视频来电 voip_…；「其他通知」reminder_channel_id（登录提醒之类）不叫醒
WX_WAKE_CHANNELS = ("message_channel", "voip")

def parse_wx(out):
    return [wx_item(r["title"], r["text"], r["id"], legacy_id=r["legacy_id"])
            for r in notifications(out, "com.tencent.mm") if not r["channel"] or r["channel"].startswith(WX_WAKE_CHANNELS)]

def src_web(src):
    req = urllib.request.Request(src["url"], headers={"User-Agent": "Mozilla/5.0"})
    body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    found = re.findall(src["pattern"], body)
    return [{"id": h(f if isinstance(f, str) else "|".join(f)), "text": (f if isinstance(f, str) else " ".join(f))[:200]} for f in found[:50]]

BODY_MAX = 8000  # 事件正文（比如 Claude Code 最后回她的消息）直接放进叫醒提示，最多这么长

def src_command(src):
    """每行一个条目。普通文字行：整行就是条目。JSON 行 {"text", "body"?, "id"?}：text 是一行摘要，
    body 是要直接给她看的正文（主人 10-21：Claude Code 最后那条消息直接塞进提示，不用她再去翻）。"""
    r = subprocess.run(src["cmd"], shell=True, capture_output=True, timeout=60)
    if r.returncode: raise RuntimeError(f"command exited {r.returncode}")
    out = r.stdout.decode("utf-8", "replace")
    items = []
    for l in out.splitlines():
        if not l.strip(): continue
        o = None
        if l.lstrip().startswith("{"):
            try: o = json.loads(l)
            except ValueError: o = None
        if isinstance(o, dict) and o.get("text"):
            it = {"id": h(str(o.get("id") or o["text"])), "text": str(o["text"])[:200]}
            if o.get("body"): it["body"] = str(o["body"])[:BODY_MAX]
            items.append(it)
        else:
            items.append({"id": h(l), "text": l[:200]})
    return items

def src_mac_badge(src):
    sys.path.insert(0, os.path.join(WS, "scripts")); import mac_badge  # 角色自己的小工具（只有这种源用）
    # 角标从无到有、或者数字变大 = 有新消息（10-14 主人 要抖音 Mac 客户端的私信也叫醒我）。
    # 角标本身没有内容，醒来要自己打开 App 看。
    n = mac_badge.read(src)
    if n is None: return None
    badges = src["_st"].setdefault("badges", {})
    last = badges.get(src["id"])
    if not src.get("_dry"): badges[src["id"]] = n
    if last is None or n <= last: return []
    return [{"id": h(f"{src['id']}:{n}:{time.time()}"), "text": say("badgeUnread", name=src.get('note') or src['id'], n=n, last=last)}]

TYPES = {"xhs_notify": src_xhs, "wx_notify": src_wx, "phone_net": src_phone_net, "web": src_web, "command": src_command, "mac_badge": src_mac_badge}

def keep_phone(cfg, st):
    if not cfg.get("keep_phone_on"): return
    os.makedirs(os.path.join(WS, "memory/phone"), exist_ok=True)
    open(os.path.join(WS, "memory/phone/.senses_keepalive"), "w").write(str(time.time()))  # 防 idle-stop 关机
    if phone_on(): return
    if time.time() - st.get("last_phone_boot", 0) < 1800: return  # 半小时内最多开一次机（可能是内存紧张被关的）
    # 2026-10-23：统一过 load.py 的闸（看压缩区/交换区/冷却），10-22 16:08 就是这里在压缩区已满时自动开机把电脑冻死的
    try: g = subprocess.run(["load", "gate", "phone"], capture_output=True, text=True)
    except FileNotFoundError: g = subprocess.CompletedProcess([], 127, "", say("noLoadCommand"))
    if g.returncode != 0:
        # 没开的原因记一笔（#0017 11-05：有重活在跑时不开，要看得到是不是真这么做的）；原因变了或隔 10 分钟才记
        why = (g.stdout or g.stderr).strip().splitlines()[0][:200] if (g.stdout or g.stderr).strip() else "?"
        key = why.split("。")[0][:40]
        if key != st.get("keep_phone_why") or time.time() - st.get("keep_phone_why_at", 0) > 600:
            st["keep_phone_why"], st["keep_phone_why_at"] = key, time.time(); save_state(st)
            with open(os.path.join(WS, "memory/phone/keep_phone.log"), "a") as f:
                f.write(say("phoneNotStarted", at=time.strftime("%F %T"), why=why))
        return
    st["last_phone_boot"] = time.time(); save_state(st)
    env = dict(os.environ, PHONE_GRPC="1", PHONE_AUDIO="none")
    subprocess.Popen(["phone", "start"], env=env,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def wake_inflight(st):
    pid = st.get("wake_pid")
    if not pid: return False
    try: os.kill(pid, 0); return True
    except OSError: return False

_JSON = json.JSONDecoder()

def wake_result(body):
    """hh sense 的结果：(status, 错误文字)。只看 status/error，不看别的正文
    （她回复里提到「额度」「429」不能当成额度用完）。
    10-28：命令行会在 JSON 前后多打几行字（版本提醒、「The CLI command failed」），整段 json.loads 会失败，
    以前就把整段输出（含她的回复和工具清单）当错误去搜 quota，误判额度用完、切去了 Codex。
    现在从每个行首的 { 试着解析，取第一个解析得出来的对象，后面多出来的字不管；都解析不了返回 unknown。"""
    for m in re.finditer(r"(?m)^\{", body):
        try:
            r, _ = _JSON.raw_decode(body, m.start())
        except ValueError:
            continue
        if isinstance(r, dict):
            err = r.get("error") or r.get("message") or ""
            return str(r.get("status") or ("ok" if r.get("ok") else "error")), json.dumps(err, ensure_ascii=False)
    return "unknown", body[-2000:]

def check_last_wake(st):
    """上一次交给 HH 的跑完了：HH 收下了就确认这些事件。"""
    w = st.get("wake")
    if not w or w.get("checked") or wake_inflight(st) or not os.path.exists(WAKE_OUT): return
    w["checked"] = True
    try:
        with open(WAKE_OUT, encoding="utf-8", errors="replace") as f: body = f.read()
    except OSError: return
    status, err = wake_result(body)
    wake_log({"ev": "result", "status": status, "err": err[:300]})
    # HH 接手即确认：hh sense 返回 ok = 事件已交到 HH 手里，由它的闸门/大脑负责，不再等 --ack
    if status == "ok" and w.get("ids"): acknowledge(st, w["ids"])
    home_if_xhs_foreground()

def home_if_xhs_foreground():
    """她处理完私信这一轮就把小红书/微信放回后台：它们在前台时新消息不发系统通知，我就看不到。
    11-11：接 HH 以后，叫醒是「hh sense 交到 HH 手里」就返回，几秒就完，不再等她这一轮做完；
    微信消息一密，每来一条就按一次 Home，正在小红书里连着操作的人（她自己、运维扫码登录 #0059）会被一直按回桌面。
    所以手机 PHONE_IN_USE_SEC 内有人用过就先不按，留给 home_if_idle_in 闲够 2 分钟再按。"""
    if not phone_on() or life_active() or phone_idle_sec() < PHONE_IN_USE_SEC: return
    try:
        top = adb("shell", "dumpsys", "activity", "activities")
        line = top.split("topResumedActivity=", 1)[1].split("\n", 1)[0] if "topResumedActivity=" in top else ""
        if "com.xingin.xhs/" in line or "com.tencent.mm/" in line: adb("shell", "input", "keyevent", "KEYCODE_HOME")
    except Exception as e:
        report_error("home", e)

HH_CLI = [hh.hh_bin]

def wake(st, text):
    """交给 HH（hh sense），后台跑，不挡每 10 秒的检查。"""
    with open(WAKE_MSG, "w", encoding="utf-8") as f: f.write(text)
    env = clean_env()
    dropped = sorted(k for k in os.environ if k.startswith(("OPENCLAW_", "CLAUDE_", "XPC_")) or k == "__PYVENV_LAUNCHER__")
    # 这一轮跑完马上再检查一次：她忙的时候攒下的事件（比如几个 Claude Code 先后回完话）不用等 2 分钟的轮询
    # （主人 10-21）。补查在 sh 退出后才跑，那时 wake_pid 已经不在了，不会被当成「还在叫醒中」。
    import shlex
    q = shlex.quote
    agent = " ".join(map(q, HH_CLI + ["sense", "--file", WAKE_MSG]))
    after = f"(sleep 3; exec {q(sys.executable)} {q(os.path.abspath(__file__))} --source none) >>{q(SENSES_LOG)} 2>&1 </dev/null &"
    with open(WAKE_OUT, "w") as out:
        pr = subprocess.Popen(["/bin/sh", "-c", f"{agent}; {after}"], stdout=out, stderr=subprocess.STDOUT, env=env,
                              start_new_session=True)
    st["wake_pid"] = pr.pid
    st["wake"] = {"at": time.time(), "checked": False}
    wake_log({"ev": "spawn", "pid": pr.pid, "dropped_env": dropped})
    return True

def acknowledge(st, ids):
    matched = set(ids)
    st["pending"] = [e for e in st.get("pending", []) if e.get("id") not in matched]

DEFAULT_HOOKS = [{"type": "wake_main", "on": "*", "debounce_sec": 15}]

def hook_matches(hook, src_id):
    on = hook.get("on", "*")
    return on == "*" or src_id == on or (isinstance(on, list) and src_id in on)

def hook_command(hook, ev):
    """把事件 JSON 从 stdin 交给一条命令（后台跑，不等结果）。想加新动作就写个脚本挂在这里。"""
    pr = subprocess.Popen(hook["cmd"], shell=True, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, start_new_session=True)
    pr.stdin.write(json.dumps(ev, ensure_ascii=False).encode()); pr.stdin.close()

def hook_wake_main(hook, ev, st):
    """要叫醒主会话处理、处理完要 --ack 的事件，进 pending。"""
    deb = (hook.get("debounce_by_src") or {}).get(ev.get("src"), hook.get("debounce_sec", 15))
    st.setdefault("pending", []).append(dict(ev, debounce=deb))

HOOKS = {"wake_main": hook_wake_main, "command": hook_command}

def collect(cfg, st, dry, only=None, now=None):
    """跑一遍事件源，返回新事件（已写进 seen 和 events.jsonl）。only=只跑这个源（监听器触发时用，不受 every_sec 限制）。
    源可选 every_sec：离上次真跑不到这么久就跳过这一轮（不算出错）。"""
    seen = st.setdefault("seen", {})
    now = time.time() if now is None else now
    fresh = []
    for src in cfg["sources"]:
        if not src.get("enabled", True) or (only and src["id"] != only): continue
        last_run = st.setdefault("last_run", {})
        if not only and not dry and src.get("every_sec") and now - last_run.get(src["id"], 0) < src["every_sec"]: continue
        if not dry: last_run[src["id"]] = now
        try: items = TYPES[src["type"]](dict(src, _dry=dry, _st=st))
        except Exception as e:
            report_error(src["id"], e); continue
        if items is None:
            report_error(src["id"], "source unavailable; existing state preserved"); continue
        old = set(seen.get(src["id"], []))
        first = src["id"] not in seen
        new = [i for i in items if i["id"] not in old]
        # Deterministic oldest-first eviction; a set slice previously evicted randomly.
        seen[src["id"]] = list(dict.fromkeys(seen.get(src["id"], []) + [i["id"] for i in items]))[-500:]
        if first and not src.get("fire_on_first", False):
            print(say("firstRound", id=src['id'], n=len(items))); continue
        for i in new:
            ev = {"id": i["id"], "t": time.strftime("%F %T"), "ts": time.time(), "src": src["id"],
                  "text": i["text"], "do": src.get("do", "")}
            if i.get("body"): ev["body"] = i["body"]
            for k in ("conv", "sender", "isGroup", "mentionsMe", "unread", "alarm", "system"):
                if k in i: ev[k] = i[k]
            print("NEW", src["id"], ev["id"], flush=True)
            if not dry:
                with open(LOG, "a") as f: f.write(json.dumps(ev, ensure_ascii=False) + "\n")
            fresh.append(ev)
    return fresh

def run_hooks(cfg, st, events):
    for ev in events:
        for hook in cfg.get("hooks") or DEFAULT_HOOKS:
            if not hook.get("enabled", True) or not hook_matches(hook, ev["src"]): continue
            try:
                if hook["type"] == "wake_main": hook_wake_main(hook, ev, st)
                else: HOOKS[hook["type"]](hook, ev)
            except Exception as e:
                report_error(f"hook:{hook.get('type')}", e)

def due_events(pending, now):
    """该叫醒处理的事件：连发的消息先攒一会儿（debounce），没确认的按 3/10/30 分钟重试，最多 3 次。"""
    newest = {}
    for e in pending:
        if not e.get("dispatches"): newest[e["src"]] = max(newest.get(e["src"], 0), e.get("ts", 0))
    def due(e):
        n = e.get("dispatches", 0)
        if n >= len(RETRY_GAPS): return False
        if n: return now - e.get("dispatched_at", 0) >= RETRY_GAPS[n - 1]
        quiet = now - newest.get(e["src"], 0) >= e.get("debounce", 0)
        return quiet or now - e.get("ts", 0) >= 60  # 一直有新消息也最多攒 1 分钟
    return [e for e in pending if due(e)][:15]

def dispatch(cfg, st, now):
    pending = st.setdefault("pending", [])
    check_last_wake(st)
    due = due_events(pending, now)
    gap = cfg.get("min_wake_gap_sec", 10)
    if not due or now - st.get("last_wake", 0) < gap or wake_inflight(st): return
    def line(e):
        s = f"- [{e['src']} id={e['id']}] {e['text']}" + (f"（{e['do']}）" if e.get('do') else "")
        if e.get("body"):
            cut = say("lineCut") if len(e["body"]) >= BODY_MAX else ""
            s += "\n  " + form("bodyOpen") + "\n" + "\n".join("  " + x for x in e["body"].splitlines()) + cut + "\n  ┄┄┄┄┄┄┄┄┄┄┄┄"
        return s
    lines = [line(e) for e in due]
    text = (say("dispatch", lines="\n".join(lines), ids=" ".join(e["id"] for e in due)))
    wake_log({"ev": "dispatch", "ids": [e["id"] for e in due], "src": sorted({e["src"] for e in due}),
              "tries": [e.get("dispatches", 0) for e in due]})
    # senses.json 里 hh_json=true：WAKE_MSG 写 JSON（text + 结构化 events），HH 的闸门读它
    payload = text
    if cfg.get("hh_json"):
        keys = ("src", "id", "text", "do", "body", "conv", "sender", "isGroup", "mentionsMe", "unread", "alarm", "system")
        payload = json.dumps({"text": text, "events": [{k: e[k] for k in keys if k in e} for e in due]}, ensure_ascii=False)
    try:
        wake(st, payload)
        st.setdefault("wake", {})["ids"] = [e["id"] for e in due]
        st["last_wake"] = time.time()
        for e in due:
            e["dispatched_at"] = st["last_wake"]; e["dispatches"] = e.get("dispatches", 0) + 1
    except Exception as e:
        report_error("wake", e)

def next_due_at(pending, now):
    """还在攒（debounce）的事件最早什么时候到点；没有就 None。"""
    newest, oldest = {}, {}
    for e in pending:
        if e.get("dispatches"): continue
        newest[e["src"]] = max(newest.get(e["src"], 0), e.get("ts", 0) + e.get("debounce", 0))
        oldest[e["src"]] = min(oldest.get(e["src"], 1e18), e.get("ts", 0) + 60)
    times = [min(newest[s], oldest[s]) for s in newest]
    return min(times) if times else None

def schedule_followup(st, now):
    """攒够了就自己再跑一次去叫醒，不用等 2 分钟一次的轮询。"""
    at = next_due_at(st.get("pending", []), now)
    if at is None or at <= now or st.get("followup_at", 0) > now: return
    st["followup_at"] = at + 1
    log = open(SENSES_LOG, "a")
    subprocess.Popen(["/bin/sh", "-c", f"sleep {int(at - now) + 1}; '{sys.executable}' '{__file__}' --source none"],
                     stdout=log, stderr=log, start_new_session=True, env=clean_env())
    log.close()

def poll(cfg, st, dry, only=None):
    for e in st.setdefault("pending", []):
        e.setdefault("id", h(e.get("src", "") + e.get("t", "") + e.get("text", "")))
    events = collect(cfg, st, dry, only)
    if dry: return
    run_hooks(cfg, st, events)
    # Persist before delivery: crashes/timeouts cannot lose freshly observed events.
    save_state(st)
    dispatch(cfg, st, time.time())
    schedule_followup(st, time.time())
    save_state(st)

def main():
    dry = "--dry" in sys.argv
    cfg = load(CFG, {"sources": []})
    if "--list" in sys.argv:
        for s in cfg["sources"]: print(("✓ " if s.get("enabled", True) else "✗ ") + s["id"], s["type"], s.get("note", ""))
        return
    if dry:
        poll(cfg, load(STATE, {}), True)
        return
    if "--drop-stale" in sys.argv:
        with state_lock(wait_sec=30) as acquired:
            if not acquired: sys.exit(say("busyDropStale"))
            import shutil
            if os.path.exists(STATE): shutil.copy2(STATE, f"{STATE}.bak-{time.strftime('%Y%m%d')}-stale")
            st = load(STATE, {})
            before = st.get("pending", [])
            st["pending"] = [e for e in before if e.get("dispatches", 0) < len(RETRY_GAPS)]
            save_state(st)
            print(say("droppedStale", n=len(before) - len(st['pending']), times=len(RETRY_GAPS)))
        return
    acking = "--ack" in sys.argv
    src_arg = sys.argv[sys.argv.index("--source") + 1] if "--source" in sys.argv else None
    # cc.py 收工时调我：别因为撞上定时轮询的锁就丢掉这次立即检查（10-25）
    with state_lock(wait_sec=30 if acking else 15 if src_arg == "cc" else 0) as acquired:
        if not acquired:
            report_error("state", "another poll/ack owns the lock; retry next tick")
            if acking: sys.exit(say("ackBusy"))
            return
        st = load(STATE, {})
        if "--ack" in sys.argv:
            acknowledge(st, sys.argv[sys.argv.index("--ack") + 1:]); save_state(st); return
        keep_phone(cfg, st)
        only = sys.argv[sys.argv.index("--source") + 1] if "--source" in sys.argv else None
        poll(cfg, st, False, only)

if __name__ == "__main__":
    main()
