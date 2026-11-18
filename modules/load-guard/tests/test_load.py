import importlib.util, json, os, sys, tempfile, time, copy
# what HH hands the script (docs/contracts/modules.md), all inside a temp dir; made-up names
tmp = tempfile.mkdtemp()
os.environ.update({k: tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                  HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="UTC", HH_LANG="zh", HH_BIN=tmp + "/no-hh",
                  HH_MODULE_CONFIG=json.dumps({"ownerUser": "nobody-here"}), USER="aqing")   # the test's processes belong to the made-up role's user
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "_lib"))
spec = importlib.util.spec_from_file_location("L", sys.argv[1]); L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
REAL_SAMPLE = L.sample
L.D = tmp; L.STATUS = tmp + "/status.json"; L.HIST = tmp + "/h.jsonl"; L.EVENTS = tmp + "/e.jsonl"; L.CURSOR = tmp + "/c"; L.GUARD_LOG = tmp + "/g.log"
killed = []
L.kill_phone = lambda mine: killed.append("phone") or [1]
L.os.kill = lambda pid, sig: killed.append(pid)
def fake(level_vals, phone, mine):
    def sample(prev=None, **kw):
        s = dict(t=time.time(), at="x", pressure=1, avail_pct=60, comp_gb=1, swap_gb=0, swapins=0, swapin_mb_min=0,
                 total_mb=16384, load1=1, ncpu=10, mine_gb=5, mine_top=[], others_gb={}, phone_on=phone[0], headroom_mb=6000)
        s.update(level_vals)
        wd, wt = L.reasons(s, L.DANGER), L.reasons(s, L.TIGHT)
        s["level"] = "danger" if wd else "tight" if wt else "ok"; s["why"] = wd or wt
        return s, mine
    L.sample = sample
ff = dict(user="aqing", pid=4242, mb=3000, cmd="/opt/homebrew/bin/ffmpeg -i x.mp4")
gw = dict(user="aqing", pid=1, mb=2500, cmd="node /home/aqing/.nvm/x/openclaw/dist/index.js gateway")
# 1) 16:08 那种：压缩区 7.1GB、等级 1、可用 58% —— 旧检查放行，新的必须拒绝开手机
fake(dict(comp_gb=7.1, avail_pct=58, swap_gb=40, seg_pct=70), [False], [gw])  # 10-22 那天：交换区 42GB
ok, msg = L.gate("phone"); assert not ok, msg; print("gate 拒绝 OK:", msg[:60])
# 2) 危险前两分钟不动手，第三分钟先关手机（11-01 放宽）
fake(dict(seg_pct=95), [True], [gw, ff])
L.guard(); L.guard(); assert killed == [], killed
L.guard(); assert killed == ["phone"], killed
st = json.load(open(L.STATUS)); assert st["cooldown"]["phone"] > time.time() + 1500
# 3) 冷却中 gate phone 拒绝，即使内存正常
fake(dict(), [False], [gw])
ok, msg = L.gate("phone"); assert not ok and "冷却" in msg, msg
# 4) 手机已关、仍危险：杀最大的可杀进程（ffmpeg），绝不杀网关
fake(dict(seg_pct=95), [False], [gw, ff])
L.guard(); L.guard(); assert 4242 in killed and 1 not in killed, killed
# 5) 事件只报一次
out = []
import io, contextlib
b = io.StringIO()
with contextlib.redirect_stdout(b): L.events()
n1 = len(b.getvalue().splitlines())
b = io.StringIO()
with contextlib.redirect_stdout(b): L.events()
assert n1 >= 2 and b.getvalue() == "", (n1, b.getvalue())
# 6b) 10-23 的日常状态：压缩区 6GB、可用 46%、交换 4GB、换入 0 —— 必须是「正常」
fake(dict(comp_gb=6.0, seg_pct=21, avail_pct=46, swap_gb=4.0), [False], [gw])
s6, _ = L.sample(); assert s6["level"] == "ok", s6["why"]
# 6c) 偏紧（压缩区占上限 70%、交换 18GB）只提示，不拦 heavy/phone 放行
fake(dict(seg_pct=70, swap_gb=18, headroom_mb=5000), [False], [gw]); json.dump({}, open(L.STATUS, "w"))
assert L.gate("heavy")[0] and L.room("phone")[0]
# 6) 正常时 cc 放行
fake(dict(), [False], [gw]); json.dump({}, open(L.STATUS, "w"))
assert L.gate("cc")[0]
# 7) room：不够 → 自动腾（LibreTV；浏览器 11-02 起不自动关）→ 够了就放行
L.time.sleep = lambda x: None
seq = iter([dict(headroom_mb=3000), dict(headroom_mb=6000)])
def samp(prev=None, **kw):
    v = next(seq); s0 = dict(t=time.time(), at="x", pressure=1, avail_pct=60, comp_gb=1, swap_gb=0, swapins=0, swapin_mb_min=0,
        total_mb=16384, load1=1, ncpu=10, mine_gb=5, mine_top=[], others_gb={}, phone_on=False, level="ok", why=[]); s0.update(v); return s0, [gw, ff]
L.sample = samp; L.free_safe = lambda mine: ["你的浏览器（约 1.0GB）"]
ok, msg = L.room("phone"); assert ok and "腾了地方" in msg, msg
# 8) 腾完还不够 → 不放行，列出她占内存的东西（含 ffmpeg pid）和怎么关；网关标「别关」
seq = iter([dict(headroom_mb=1000), dict(headroom_mb=2000)])
ok, msg = L.room("phone"); assert not ok and "4242" in msg and "别关" in msg and "helper stop" in msg, msg
print(msg.splitlines()[0])
# 9) 危险线上：腾完还危险也不放行
seq = iter([dict(headroom_mb=9000, level="danger", why=["压缩区 6GB"]), dict(headroom_mb=9000, level="danger", why=["压缩区 6GB"])])
ok, msg = L.room("phone"); assert not ok and "危险线" in msg, msg
# 10) 冻结检测（用真实的 sample）：巡检隔了 200 秒（不算睡眠）→ 冻过 1 次＝偏紧；10 分钟内第 2 次＝危险
now_m = L.M.uptime()
prev = dict(t=time.time() - 200, mono=now_m - 200, boot=L.boot_sec(), swapins=0, freezes=[])
s1, _ = REAL_SAMPLE(prev, count_freeze=True); assert len(s1["freezes"]) == 1 and s1["level"] in ("tight", "danger"), s1["why"]
prev2 = dict(prev, freezes=s1["freezes"])
s2, _ = REAL_SAMPLE(prev2, count_freeze=True); assert s2["level"] == "danger" and any("冻住" in w for w in s2["why"]), s2["why"]
# 11) 睡眠不算冻住：墙上时间过了 2 小时，但不含睡眠的时钟只过了 60 秒
s3, _ = REAL_SAMPLE(dict(t=time.time() - 7200, mono=now_m - 60, boot=L.boot_sec(), swapins=0, freezes=[]), count_freeze=True)
assert s3["freezes"] == [], s3["freezes"]
# 12) 重启过（开机时间变了）不算冻住
s4, _ = REAL_SAMPLE(dict(t=time.time() - 900, mono=now_m - 900, boot=123, swapins=0, freezes=[]), count_freeze=True)
assert s4["freezes"] == []
# 13) gate/room 不记冻结（只有巡检记）
s5, _ = REAL_SAMPLE(prev, count_freeze=False); assert s5["freezes"] == []
# 14) 磁盘快满：<25GB 偏紧，<10GB 危险（别的读数取平静的：这台机器此刻本身可能就在危险线上）
calm = dict(s3, pressure=1, seg_pct=0, avail_pct=60, swap_gb=0, swapin_mb_min=0, freezes=[], unknown=[])
assert L.reasons(dict(calm, disk_gb=20), L.TIGHT) and not L.reasons(dict(calm, disk_gb=20), L.DANGER)
assert any("系统盘" in w for w in L.reasons(dict(calm, disk_gb=8), L.DANGER))
# 15) 危险 5 分钟、她没东西可关 → 通知 主人 一次（6 小时内不重复）
sent = []
L.notify_owner = lambda text: sent.append(text)
fake(dict(seg_pct=95, others_gb={"laolin": 9.0}), [False], [gw])
json.dump({}, open(L.STATUS, "w"))
for _ in range(7): L.guard()
assert len(sent) == 1 and "laolin 9.0GB" in sent[0], sent
print("ALL OK", killed)
# 16) 「你占」算 footprint（含被压缩的），读不到的退回 RSS；RSS 字段原样保留给减负判断；别人的仍按 RSS
L.footprint_mb = lambda pid: {77: 2500, 4242: 3500}.get(pid)
L.sh = lambda *a, **k: ("aqing 77 409600 node /x/openclaw/dist/index.js gateway\n"
                        "aqing 4242 307200 /opt/homebrew/bin/ffmpeg -i x\n"
                        "aqing 9 51200 /bin/zsh\n"
                        "laolin 5 2097152 /Applications/Xcode.app/x")
rows, mine, top, users, me = L.procs()
mine = [r for r in rows if r["user"] == "aqing"]
assert {r["pid"]: (r["mb"], r["fp"]) for r in mine} == {77: (400, 2500), 4242: (300, 3500), 9: (50, 50)}, mine
assert users["laolin"] == 2048, users
print("footprint 统计 OK:", top)
# 17) 10-31：whisper 大活在跑，自动开手机（gate phone）等它；小的 ffmpeg 不拦；她自己开（room phone）不受影响
L.cooldown_left = lambda kind: 0
json.dump({}, open(L.STATUS, "w"))
open(L.HIST, "w").write("\n".join(json.dumps({"level": "ok"}) for _ in range(3)) + "\n")
L.boot_sec = lambda: time.time() - 3600
wh = dict(user="aqing", pid=555, mb=900, fp=3900, cmd="/opt/homebrew/bin/whisper x.wav --model medium")
small = dict(user="aqing", pid=556, mb=300, cmd="/opt/homebrew/bin/ffmpeg -i x.mp4")
fake(dict(), [False], [gw, wh])
ok, msg = L.gate("phone"); assert not ok and "whisper 3.8GB" in msg, msg
assert L.room("phone")[0]
fake(dict(), [False], [gw, small])
ok, msg = L.gate("phone"); assert ok, msg
print("大活在跑时等着开手机 OK:", msg[:30])
# 18) 批处理两段 whisper 之间的空当：guard 记下 media_at，gate phone 等停够 5 分钟
fake(dict(), [False], [gw, wh]); json.dump({}, open(L.STATUS, "w"))
L.guard(); assert time.time() - json.load(open(L.STATUS))["media_at"] < 5
fake(dict(), [False], [gw])  # 空当：whisper 刚退出
ok, msg = L.gate("phone"); assert not ok and "停够" in msg, msg
st = json.load(open(L.STATUS)); st["media_at"] = time.time() - 400; json.dump(st, open(L.STATUS, "w"))
ok, msg = L.gate("phone"); assert ok, msg
L.guard(); assert json.load(open(L.STATUS))["media_at"] < time.time() - 300  # 没大活时不刷新
print("批处理空当不开手机 OK")
# 18b) #0017 11-05：帮手在渲染（python 脚本 1.3GB + 无头浏览器 0.9GB）也等；大脑（hhd node 1.5GB）不算重活
json.dump({}, open(L.STATUS, "w"))
render = dict(user="aqing", pid=601, mb=800, fp=1300, cmd="/opt/homebrew/bin/python3 visual/render.py --out out/k3")
headless = dict(user="aqing", pid=602, mb=600, fp=900, cmd="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=0")
brain = dict(user="aqing", pid=603, mb=1200, fp=1500, cmd="/home/aqing/.local/openclaw-node/bin/node /home/aqing/human-harness/src/hhd.ts")
fake(dict(), [False], [gw, render, headless, brain])
ok, msg = L.gate("phone"); assert not ok and "像是渲染" in msg and "无头浏览器" in msg, msg
assert L.room("phone")[0], "她自己开（room phone）不受影响"
L.guard(); assert time.time() - json.load(open(L.STATUS))["media_at"] < 5, "渲染也记下 media_at，停够 5 分钟再开"
json.dump({}, open(L.STATUS, "w"))
fake(dict(), [False], [gw, brain])
ok, msg = L.gate("phone"); assert ok, msg
print("帮手渲染时不自动开手机 OK")
# 19) 11-01 22:30 那种：换入尖峰 2075、912、360MB/分，压缩区 70%、交换区 27GB——不关手机；交换区 30.6GB 只算正常
killed.clear(); json.dump({}, open(L.STATUS, "w"))
for rate in (2075, 912, 360):
    fake(dict(swapin_mb_min=rate, seg_pct=70, swap_gb=27.0), [True], [gw]); L.guard()
assert killed == [], killed
assert json.load(open(L.STATUS))["level"] == "ok"
fake(dict(seg_pct=66, swap_gb=30.6), [True], [gw]); L.guard(); assert json.load(open(L.STATUS))["level"] == "ok"
# 11-01 晚放宽：危险（交换区 39GB、换入 1800）连着 6 分钟——拦新重活，但不关手机、不通知 主人
sent.clear()
for _ in range(6):
    fake(dict(swapin_mb_min=1800, swap_gb=39), [True], [gw]); L.guard()
assert killed == [] and sent == [], (killed, sent)
st = json.load(open(L.STATUS)); assert st["level"] == "danger" and st["shed_streak"] == 0, st
ok, msg = L.gate("phone"); assert not ok, msg
# 真抖起来（换入 ≥3000 连着 3 分钟）照样关
for _ in range(3):
    fake(dict(swapin_mb_min=3200), [True], [gw]); L.guard()
assert killed == ["phone"], killed
# 交换区到 42GB（10-22 冻死时的量）也关
killed.clear(); json.dump({}, open(L.STATUS, "w"))
for _ in range(3):
    fake(dict(swap_gb=42.5), [True], [gw]); L.guard()
assert killed == ["phone"], killed
print("尖峰不关、危险只拦新活、到自动关的线才关 OK")
# 只看的那个角色（shed false：一台机器只让一个角色减负）：危险再久也不关手机、不杀进程、不叫主人，状态照写
killed.clear(); sent.clear(); json.dump({}, open(L.STATUS, "w"))
L.hh.config["shed"] = False
for _ in range(7):
    fake(dict(seg_pct=95, others_gb={"laolin": 9.0}), [True], [gw, ff]); L.guard()
assert killed == [] and sent == [], (killed, sent)
assert json.load(open(L.STATUS))["level"] == "danger"
del L.hh.config["shed"]
print("只看不减负 OK")
# 20) 11-17: an ffmpeg nearly all compressed and swapped out (300MB resident, 9GB footprint) is the one shed, by footprint,
# not the process with more resident memory
killed.clear(); json.dump({}, open(L.STATUS, "w"))
swapped = dict(user="aqing", pid=4343, mb=300, fp=9000, cmd="/opt/homebrew/bin/ffmpeg -loop 1 -i a.png -i b.mp4 out.mp4")
resident = dict(user="aqing", pid=4344, mb=900, fp=1000, cmd="/opt/homebrew/bin/python3 render.py")
for _ in range(3):
    fake(dict(swapin_mb_min=7400), [False], [gw, swapped, resident]); L.guard()
assert killed == [4343], killed
# 21) HH's own processes (the daemon, the console, a direct bridge) are never shed, however big
brain_big = dict(brain, mb=1500, fp=12000)
console = dict(user="aqing", pid=604, mb=800, fp=5000, cmd="/x/bin/node /home/aqing/human-harness/src/console/main.ts")
bridge = dict(user="aqing", pid=605, mb=800, fp=5000, cmd="/x/bin/node /home/aqing/human-harness/bridge/qq/main.ts")
assert not any(L.label(p["cmd"])[1] for p in (brain_big, console, bridge))
killed.clear(); json.dump({}, open(L.STATUS, "w"))
for _ in range(3):
    fake(dict(swapin_mb_min=7400), [False], [gw, brain_big, console, bridge]); L.guard()
assert killed == [], killed
fake(dict(swapin_mb_min=7400), [False], [gw, brain_big, console, bridge, swapped]); L.guard()
assert killed == [4343], killed
# 22) one process bigger than the machine's memory (16GB) is stopped at the first look, before the phone, and she is told
# it was stopped, not finished
killed.clear(); json.dump({}, open(L.STATUS, "w"))
runaway = dict(swapped, pid=4545, fp=20000)
fake(dict(swapin_mb_min=7267, swap_gb=18.2), [True], [gw, runaway]); L.guard()
assert killed == [4545], killed
e = json.loads(open(L.EVENTS).read().splitlines()[-1])
assert "比整台电脑的内存（16GB）还大" in e["text"] and "没做完" in e["text"], e["text"]
killed.clear(); json.dump({}, open(L.STATUS, "w"))
fake(dict(), [False], [gw, dict(runaway, fp=15000)]); L.guard()
assert killed == [], killed
L.hh.config["shed"] = False
fake(dict(), [False], [gw, runaway]); L.guard(); assert killed == [], killed
del L.hh.config["shed"]
print("footprint, HH's own processes, bigger than the machine OK")
