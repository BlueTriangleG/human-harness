"""离线测试：不连 B站，只测纯逻辑。跑法：plugins/bili/tests/run.sh"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

# 用临时目录当数据目录和工作区，别碰真的
_tmp = tempfile.mkdtemp(prefix="bili-test-")
# the checks below compare the server's Chinese sentences: they choose Chinese whatever the environment says
os.environ["HH_LANG"] = "zh"
os.environ["BILI_DATA"] = os.path.join(_tmp, "data")
os.environ["BILI_WORKSPACE"] = os.path.join(_tmp, "ws")
os.environ["HH_MODULE_STATE"] = os.path.join(_tmp, "state")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from bilibili_api.exceptions import NetworkException, ResponseCodeException  # noqa: E402

import main  # noqa: E402
from bilitools import act, core, ledger, viewing  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f"  {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def run(coro):
    return asyncio.run(coro)


# ---- 数字 / 时间 ----
check("cn_num 万", core.cn_num("1.2万") == 12000)
check("cn_num 亿", core.cn_num("3亿") == 300_000_000)
check("cn_num 垃圾", core.cn_num("--") == 0 and core.cn_num(None) == 0)
check("parse_dur", core.parse_dur("1:02:03") == 3723 and core.parse_dur("12:34") == 754 and core.parse_dur(90) == 90)
check("fmt_dur", core.fmt_dur(754) == "12:34" and core.fmt_dur(3723) == "1:02:03")

# ---- BV 解析 ----
check("resolve BV", run(core.resolve_bvid("看这个 https://www.bilibili.com/video/BV1tGn46rE8r/?p=1")) == "BV1tGn46rE8r")
check("resolve av", run(core.resolve_bvid("av170001")).startswith("BV"))
try:
    run(core.resolve_bvid("rm -rf /"))
    check("resolve 拒绝垃圾", False)
except core.BiliError:
    check("resolve 拒绝垃圾", True)

# ---- 字幕防串台 ----
aid, cid = 1000000001, 1000000002
good = f"//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/{aid}{cid}57abbfa5768cb1c6?auth_key=1"
bad = "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/11744145152519242748546101b66acf?auth_key=1"
# the vendored upstream's login writes its credential and QR code to the module state, never beside its own code
check("上游的凭证和二维码进模块状态目录", viewing.upstream.CRED_FILE.parent == Path(os.environ["HH_MODULE_STATE"]), str(viewing.upstream.CRED_FILE.parent))
check("字幕地址对得上", viewing._subtitle_belongs(good, aid, cid) is True)
check("字幕地址串台", viewing._subtitle_belongs(bad, aid, cid) is False)
check("UP 主字幕不判", viewing._subtitle_belongs("//i0.hdslb.com/bfs/subtitle/abc.json", aid, cid) is None)

# ---- 弹幕 ----
xml = ('<i><d p="1.5,1,25,16777215,0,0,a,1,10">哈哈哈哈哈哈</d><d p="2.0,1,25,1,0,0,b,2,10">哈哈哈哈</d>'
       '<d p="65.2,1,25,1,0,0,c,3,10">前方高能&amp;</d><d p="66,1,25,1,0,0,c,4,10">前方高能&amp;</d>'
       '<d p="67,1,25,1,0,0,c,5,10">名场面</d></i>')
dms = viewing._parse_dm_xml(xml)
check("弹幕解析", len(dms) == 5 and dms[2][1] == "前方高能&", str(dms))
dig = viewing.dm_digest(dms, 120)
check("弹幕刷屏词", dig["phrases"][0]["text"] in ("哈哈哈", "前方高能&") and dig["phrases"][0]["n"] == 2, str(dig["phrases"]))
check("高能时刻", any(m["at"] == "1:00" and m["n"] == 3 for m in dig["moments"]), str(dig["moments"]))


# ---- 包装：异常不外抛、风控冷却、上限 ----
@core.bili_tool()
async def boom():
    raise ResponseCodeException(-101, "账号未登录")


@core.bili_tool()
async def boom412():
    raise NetworkException(412, "Precondition Failed")


@core.bili_tool(cap="dm_send")      # reply 已无每日上限（主人 10-27），用 dm_send（15）测上限机制
async def fake_reply(n=1):
    return {"done": True, "_cap_n": n}


@core.bili_tool(cap="post_dynamic")
async def fake_dry():
    return {"dry_run": True, "_cap_n": 0}


r = run(boom())
check("异常变 ok:false", r["ok"] is False and r["code"] == -101 and "auth_sync" in r["hint"], str(r))
r = run(boom412())
check("412 进冷却", r["ok"] is False and core.cooldown_left() > 500, str(r))
r = run(fake_reply())
check("冷却时挡住", r["ok"] is False and "冷却" in r["error"], str(r))
Path(os.environ["BILI_DATA"], "cooldown.json").unlink()
for _ in range(15):
    run(fake_reply())
r = run(fake_reply())
check("上限挡住第 16 条私信", r["ok"] is False and "上限" in r["error"], str(r))
run(fake_dry())
check("dry_run 不计数", core.caps_today().get("post_dynamic") is None, str(core.caps_today()))

# ---- 并发也冲不破上限；按参数计数；循环里撞风控要往外抛 ----
@core.bili_tool(cap="follow")
async def fake_follow():
    await asyncio.sleep(0.05)
    return {"followed": True}


async def _burst():
    return await asyncio.gather(*[fake_follow() for _ in range(12)])

res = run(_burst())
check("并发 12 次关注只成 8 次", sum(1 for r in res if r.get("ok")) == 8, str(core.caps_today()))


@core.bili_tool(cap="coin", cap_arg="num")
async def fake_coin(num=1):
    return {"coins": num, "_cap_n": num}

for _ in range(4):
    run(fake_coin(num=2))
r = run(fake_coin(num=1))
check("投到 9 个还行", r["ok"] is True and core.caps_today().get("coin") == "9/10", str(r))
r = run(fake_coin(num=2))
check("投币按币数算：9 个再投 2 个超上限", r["ok"] is False and core.caps_today().get("coin") == "9/10", str(r))
try:
    core.note_error(ResponseCodeException(-352, "风控"))
    check("note_error 撞风控往外抛", False)
except ResponseCodeException:
    check("note_error 撞风控往外抛", core.cooldown_left() > 0)
Path(os.environ["BILI_DATA"], "cooldown.json").unlink()
check("note_error 普通错误只返回人话", "稿件不可见" in core.note_error(ResponseCodeException(62002, "x")))

from bilitools import discover  # noqa: E402
check("时长按分钟分档", discover._DURS == {"any": -1, "short": 5, "mid": 20, "long": 45, "xlong": 90})
check("鬼畜榜名字对", discover._RANKS["kichiku"] == "Kichiku" and "anime" in discover._PGC_RANKS)
from bilibili_api import rank  # noqa: E402
check("榜单都在库里", all(hasattr(rank.RankType, v) for v in [*discover._RANKS.values(), *discover._PGC_RANKS.values()]))

# ---- 判重表 ----
ledger.touch("BV1tGn46rE8r", "罗小黑", "42手册", "watch")
ledger.touch("BV1tGn46rE8r", "罗小黑", "42手册", "watch")
check("自动记一次", len(core.jsonl_read(ledger.SEEN)) == 1)
r = run(ledger.seen_mark("BV1tGn46rE8r", "值得看", "讲透了"))
check("seen_mark", r["ok"] and sum("BV1tGn46rE8r" in ln for ln in Path(r["files"][1]).read_text("utf-8").splitlines()) == 1, str(r))
ledger.touch("BV1tGn46rE8r")
idx = ledger._index()
check("自动看过不覆盖结论", idx["BV1tGn46rE8r"]["verdict"] == "值得看", str(idx))
r = run(ledger.seen_check(["BV1tGn46rE8r", "https://b23.tv/x BV1d8pU6xEZX"]))
check("seen_check", "BV1tGn46rE8r" in r["seen"] and r["unseen"] == ["BV1d8pU6xEZX"], str(r))
items = ledger.annotate([{"bvid": "BV1tGn46rE8r"}, {"bvid": "BV1d8pU6xEZX"}])
check("annotate", "seen" in items[0] and "seen" not in items[1])


# ---- MCP 包装：structuredContent + 紧凑文本 + isError ----
async def _ok(x: int = 1) -> dict:
    """测试"""
    return {"ok": True, "x": x, "中文": "好"}

w = main.as_mcp(_ok)
res = run(w(x=2))
check("MCP structured", res.structuredContent == {"ok": True, "x": 2, "中文": "好"} and not res.isError)
check("MCP 紧凑文本", res.content[0].text == '{"ok":true,"x":2,"中文":"好"}', res.content[0].text)
res = run(main.as_mcp(boom)())
check("MCP isError", res.isError is True)
check("工具都注册了", len(main.TOOL_NAMES) >= 61 and "watch" in main.TOOL_NAMES and "reply" in main.TOOL_NAMES)
check("每个工具都有说明", all(core.text(f"tool.{fn.__name__}").strip() for m in main.MODULES for fn in m.TOOLS))

# ---- @ 解析 ----
check("@ 正则", act._AT_RE.findall("给 @LZ0001 看看，@小明：你好 @a@b") == ["LZ0001", "小明", "a", "b"],
      str(act._AT_RE.findall("给 @LZ0001 看看，@小明：你好 @a@b")))

# ---- 评论带图（只验参数拼装，不连 B站）----
import tempfile
from pathlib import Path as _P
_sd = act.STICKER_DIR
_ok_png = next((x for x in _sd.rglob("*") if x.suffix.lower() in act.IMG_EXTS and x.is_file()), None)
def _bad(imgs):
    try:
        act._check_images(imgs)
    except core.BiliError as e:
        return str(e)
    return None
check("图片：stickers 外拒绝", _bad(["/etc/hosts"]) is not None)
check("图片：../ 逃逸拒绝", _bad([str(_sd / ".." / "AGENTS.md")]) is not None)
check("图片：扩展名拒绝", _bad([str(_sd / "TASTE.md")]) is not None)
check("图片：不存在拒绝", _bad([str(_sd / "nope.png")]) is not None)
if _ok_png:
    check("图片：合法通过", act._check_images([str(_ok_png)]) == [_ok_png.resolve()])
    check("图片：4 张拒绝", _bad([str(_ok_png)] * 4) is not None)
_sent = {}
class _FakeApi:
    def __init__(self, **kw): _sent["url"] = kw.get("url")
    def update_data(self, **d): _sent["data"] = d; return self
    @property
    async def result(self): return {"rpid": 1}
_real_api = act.Api
act.Api = _FakeApi
pics = [{"img_src": "http://i0.hdslb.com/bfs/new_dyn/x.gif", "img_width": 10, "img_height": 20, "img_size": 3}]
run(act._send_reply(1, 1, "hi", 0, 0, {}, None, pics))
check("pictures 参数拼装", json.loads(_sent["data"]["pictures"]) == pics, str(_sent))
run(act._send_reply(1, 1, "hi", 0, 0, {}, None))
check("无图时不带 pictures", "pictures" not in _sent["data"])
act.Api = _real_api

# ---- #0053：reply 回别人视频时拒、自己视频下放行（11-11） ----
class _FakeVideo:
    owners = {}
    def __init__(self, bvid=None, aid=None, credential=None): self.key = bvid or aid
    async def get_info(self):
        return {"aid": 9001, "title": "t", "owner": {"mid": self.owners.get(self.key, 0), "name": "某UP"}}
class _FakeVideoMod: Video = _FakeVideo
_sends = []
async def _fake_send(*a, **k): _sends.append(a); return {"rpid": 5}
async def _fake_bv(b): return b
_saved = (act.video, act._send_reply, core.resolve_bvid, core.my_uid, core.get_cred)
act.video, act._send_reply, core.resolve_bvid = _FakeVideoMod, _fake_send, _fake_bv
core.my_uid, core.get_cred = (lambda: 111), (lambda write=False: None)
_FakeVideo.owners = {"BVmine": 111, "BVother": 222, 7001: 222, 7002: 111}
def _reply_err(**kw):                         # 工具不抛异常，拒了返回 {"ok": False, "error", "hint"}
    r = run(act.reply(text="你好", **kw))
    return None if r.get("ok", True) else (r.get("error", "") + " " + r.get("hint", ""))
_sends.clear(); e = _reply_err(bvid="BVother")
check("reply：别人视频拒", e is not None and "网页" in str(e) and not _sends, str(e))
_sends.clear(); e = _reply_err(bvid="BVother", rpid=33)
check("reply：别人视频下回楼也拒", e is not None and not _sends, str(e))
_sends.clear(); e = _reply_err(bvid="BVmine", rpid=33)
check("reply：自己视频下放行", e is None and len(_sends) == 1, str(e))
_sends.clear(); e = _reply_err(oid=7001, type=1)
check("reply：oid 指别人视频也拒", e is not None and not _sends, str(e))
_sends.clear(); e = _reply_err(oid=7002, type=1)
check("reply：oid 指自己视频放行", e is None and len(_sends) == 1, str(e))
_sends.clear(); e = _reply_err(oid=8001, type=11)
check("reply：动态下照旧放行", e is None and len(_sends) == 1, str(e))
core.my_uid = lambda: 0
_sends.clear(); e = _reply_err(bvid="BVmine")
check("reply：查不到自己 UID 就拒", e is not None and not _sends, str(e))
act.video, act._send_reply, core.resolve_bvid, core.my_uid, core.get_cred = _saved

print()
print("全部通过" if not FAILS else f"{len(FAILS)} 个失败：{FAILS}")
sys.exit(1 if FAILS else 0)
