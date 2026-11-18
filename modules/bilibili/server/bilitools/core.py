"""共用的底子：路径、凭证、节流、风控冷却、错误翻译、每日上限、记账。

所有工具都返回 dict：成功 {"ok": True, ...}，失败 {"ok": False, "error": "...", "hint": "..."}。
工具函数用 @bili_tool 包一层：统一捕获异常、查风控冷却、节流。
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import fcntl
import functools
import json
import os
import re
import tempfile
import time
from pathlib import Path

from bilibili_api import Credential
from bilibili_api.exceptions import (
    ApiException,
    ArgsException,
    CredentialNoBiliJctException,
    CredentialNoSessdataException,
    NetworkException,
    ResponseCodeException,
)

ROOT = Path(__file__).resolve().parents[2]                     # 插件目录
# The module environment (docs/contracts/modules.md); BILI_DATA / BILI_WORKSPACE are the tests' own
WS = Path(os.environ.get("BILI_WORKSPACE") or os.environ["HH_WORKSPACE"])
CONFIG = json.loads(os.environ.get("HH_MODULE_CONFIG") or "{}")
# the login and the records: config dataDir (relative to the workspace, or ~ / absolute), else the module's state
DATA = Path(os.environ.get("BILI_DATA") or (WS / os.path.expanduser(CONFIG["dataDir"]) if CONFIG.get("dataDir") else os.environ["HH_MODULE_STATE"]))
ME = os.environ.get("HH_ME") or "我"
OWNER = os.environ.get("HH_OWNER") or "主人"
_NAMES = (("{owner_handle}", CONFIG.get("ownerHandle") or OWNER), ("{me}", ME), ("{owner}", OWNER))


def named(text: str) -> str:
    """The plugin's own words name the role {me}, its owner {owner} and the owner's B站 name {owner_handle}: fill them in"""
    for a, b in _NAMES:
        text = text.replace(a, b)
    return text


def named_out(out: dict) -> dict:
    """A tool result with the plugin's own words (error, hint, next, status) in this role's names; the data is left as it is"""
    return {k: named(v) if k in ("error", "hint", "next", "status") and isinstance(v, str) else v for k, v in out.items()}


# The plugin's sentences in the role's language: texts.<lang>.json beside module.ts, else texts.json (English), as
# hh_env.words picks them; read as they are (they hold braces of their own) and named.
_TEXTS = json.loads(next(p for p in (ROOT / f"texts.{os.environ.get('HH_LANG', 'en')}.json", ROOT / "texts.json") if p.exists()).read_text(encoding="utf-8"))


def text(key: str) -> str:
    """One of the plugin's sentences (tool.<name>: a tool's description; instructions: the server's), with the names filled in"""
    return named(_TEXTS[key])


def say(key: str, **holes) -> str:
    """A sentence of the results (an error, a hint, a status), names and holes filled: what was a literal in this code"""
    return named(_TEXTS[key]).format(**holes)
LEDGER = WS / "memory" / "bili"                               # 判重表、归档、操作记录（进她的 git 和记忆搜索）
VIDEOS = WS / "memory" / "videos"                             # 和 scripts/watch.py 共用：memory/videos/<BV>/
CRED_FILE = DATA / "credential.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# 每天最多做几次（防止循环刷屏 / 被 B站 判骚扰）。按自然日、按动作计。
DAILY_CAPS = {
    "dm_send": 15, "send_danmaku": 20, "follow": 8, "coin": 10,
    "triple": 10, "post_dynamic": 3, "upload_video": 2, "comment_delete": 20,
    "like": 200, "comment_like": 100, "favorite": 100, "toview": 100,
}

COOLDOWN_SEC = 600          # 撞上风控（-412/-352）后整体歇 10 分钟
MIN_GAP_SEC = 0.35          # 两次工具调用之间最少隔多久（接口级）


def ensure_dirs() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(DATA, 0o700)
    except OSError:
        pass


def now_ts() -> int:
    return int(time.time())


def fmt_ts(ts) -> str:
    try:
        ts = int(ts or 0)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def fmt_dur(sec) -> str:
    try:
        s = int(float(sec or 0))
    except (TypeError, ValueError):
        return str(sec or "")
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_dur(text) -> int:
    """'12:34' / '1:02:03' / 754 → 秒。"""
    if isinstance(text, (int, float)):
        return int(text)
    try:
        parts = [int(x) for x in str(text or "").split(":") if x.strip() != ""]
    except ValueError:
        return 0
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def cn_num(x) -> int:
    """B站 的数字有时是「1.2万」「3亿」「--」这种字符串。"""
    if isinstance(x, (int, float)):
        return max(0, int(x))
    t = str(x or "").strip().replace(",", "")
    mult = 1
    if t.endswith("万"):
        mult, t = 10_000, t[:-1]
    elif t.endswith("亿"):
        mult, t = 100_000_000, t[:-1]
    try:
        return max(0, int(float(t) * mult))
    except ValueError:
        return 0


def clean_html(s) -> str:
    return re.sub(r"<[^>]+>", "", str(s or "")).replace("&amp;", "&").replace("&quot;", '"').strip()


def cut(s, n: int) -> str:
    s = str(s or "")
    return s if len(s) <= n else s[: n - 1] + "…"


def video_url(bvid: str) -> str:
    return f"https://www.bilibili.com/video/{bvid}"


# ---------------- 错误 ----------------

class BiliError(Exception):
    """给模型看的错误：error 一句话，hint 告诉她下一步。"""

    def __init__(self, error: str, hint: str = "", **extra):
        super().__init__(error)
        self.error = error
        self.hint = hint
        self.extra = extra


# B站 常见返回码 → 人话 + 下一步
CODE_HINTS = {
    -101: (say("core.CODE_HINTS.1"), say("core.CODE_HINTS.2")),
    -111: (say("core.CODE_HINTS.3"), say("core.CODE_HINTS.4")),
    -352: (say("core.CODE_HINTS.5"), say("core.CODE_HINTS.6")),
    -412: (say("core.CODE_HINTS.7"), say("core.CODE_HINTS.8")),
    -400: (say("core.CODE_HINTS.9"), say("core.CODE_HINTS.10")),
    -403: (say("core.CODE_HINTS.11"), ""),
    -404: (say("core.CODE_HINTS.12"), ""),
    -509: (say("core.CODE_HINTS.13"), say("core.CODE_HINTS.14")),
    62002: (say("core.CODE_HINTS.15"), say("core.CODE_HINTS.16")),
    62004: (say("core.CODE_HINTS.17"), say("core.CODE_HINTS.18")),
    62012: (say("core.CODE_HINTS.19"), say("core.CODE_HINTS.20")),
    12002: (say("core.CODE_HINTS.21"), say("core.CODE_HINTS.22")),
    12009: (say("core.CODE_HINTS.23"), ""),
    12015: (say("core.CODE_HINTS.24"), say("core.CODE_HINTS.25")),
    12025: (say("core.CODE_HINTS.26"), say("core.CODE_HINTS.27")),
    12051: (say("core.CODE_HINTS.28"), say("core.CODE_HINTS.29")),
    12052: (say("core.CODE_HINTS.30"), say("core.CODE_HINTS.31")),
    12053: (say("core.CODE_HINTS.32"), say("core.CODE_HINTS.33")),
    34004: (say("core.CODE_HINTS.34"), say("core.CODE_HINTS.35")),
    34005: (say("core.CODE_HINTS.36"), ""),
    34002: (say("core.CODE_HINTS.37"), ""),
    65004: (say("core.CODE_HINTS.38"), ""),
    65006: (say("core.CODE_HINTS.39"), ""),
    21007: (say("core.CODE_HINTS.40"), say("core.CODE_HINTS.41")),
    21015: (say("core.CODE_HINTS.42"), say("core.CODE_HINTS.43")),
    21020: (say("core.CODE_HINTS.44"), say("core.CODE_HINTS.45")),
    21026: (say("core.CODE_HINTS.46"), say("core.CODE_HINTS.47")),
    22001: (say("core.CODE_HINTS.48"), ""),
    22002: (say("core.CODE_HINTS.49"), ""),
    22003: (say("core.CODE_HINTS.50"), ""),
    22009: (say("core.CODE_HINTS.51"), say("core.CODE_HINTS.52")),
    22013: (say("core.CODE_HINTS.53"), ""),
    22014: (say("core.CODE_HINTS.54"), ""),
    11007: (say("core.CODE_HINTS.55"), ""),
    36701: (say("core.CODE_HINTS.56"), say("core.CODE_HINTS.57")),
    36703: (say("core.CODE_HINTS.58"), say("core.CODE_HINTS.59")),
    36704: (say("core.CODE_HINTS.60"), say("core.CODE_HINTS.61")),
    36714: (say("core.CODE_HINTS.62"), say("core.CODE_HINTS.63")),
}

ALREADY_CODES = {65006, 22014, 11007}         # 这些"失败"其实等于已经做过了


def explain_exc(e: Exception) -> tuple[str, str, int | None]:
    if isinstance(e, BiliError):
        return e.error, e.hint, e.extra.get("code")
    if isinstance(e, ResponseCodeException):
        code = getattr(e, "code", None)
        text, hint = CODE_HINTS.get(code, (say("core.explain_exc.1", a=code), ""))
        msg = str(getattr(e, "msg", "") or "")
        if msg and msg not in text:
            text = say("core.explain_exc.detail", a=text, b=cut(msg, 120))
        return text, hint, code
    if isinstance(e, CredentialNoSessdataException):
        return say("core.explain_exc.2"), say("core.explain_exc.3"), -101
    if isinstance(e, CredentialNoBiliJctException):
        return say("core.explain_exc.4"), say("core.explain_exc.5"), -111
    if isinstance(e, NetworkException):
        status = getattr(e, "status", None)
        if status == 412:
            return say("core.explain_exc.6"), say("core.explain_exc.7"), -412
        return say("core.explain_exc.8", a=status), say("core.explain_exc.9"), None
    if isinstance(e, ArgsException):
        return say("core.explain_exc.10", a=cut(e, 160)), "", None
    if isinstance(e, ApiException):
        return say("core.explain_exc.11", a=cut(e, 160)), "", None
    if isinstance(e, asyncio.TimeoutError):
        return say("core.explain_exc.12"), say("core.explain_exc.13"), None
    return f"{type(e).__name__}: {cut(e, 200)}", "", None


# ---------------- 状态文件（MCP 进程和 bin/bili 可能同时写：唯一临时名 + 文件锁）----------------

def write_atomic(path: Path, text: str, mode: int = 0o644) -> None:
    ensure_dirs()
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


@contextlib.contextmanager
def file_lock(name: str):
    ensure_dirs()
    with open(DATA / f".{name}.lock", "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


# ---------------- 风控冷却 ----------------

_COOL_FILE = DATA / "cooldown.json"
RISK_CODES = (-412, -352)


def cooldown_left() -> int:
    try:
        until = json.loads(_COOL_FILE.read_text("utf-8")).get("until", 0)
    except (OSError, ValueError):
        return 0
    return max(0, int(until - time.time()))


def start_cooldown(reason: str) -> None:
    try:
        write_atomic(_COOL_FILE, json.dumps({"until": now_ts() + COOLDOWN_SEC, "reason": reason,
                                             "at": fmt_ts(now_ts())}, ensure_ascii=False))
    except OSError:
        pass


def is_risk(e: Exception) -> bool:
    return explain_exc(e)[2] in RISK_CODES


def note_error(e: Exception) -> str:
    """循环里吞掉单个失败时用：撞上风控就开冷却并且往外抛（别接着撞），否则返回一句人话。"""
    err, _, code = explain_exc(e)
    if code in RISK_CODES:
        start_cooldown(err)
        raise e
    return err


# ---------------- 凭证 ----------------

def load_cred_data() -> dict | None:
    try:
        d = json.loads(CRED_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("SESSDATA") else None


def save_cred_data(cookies: dict, meta: dict) -> None:
    ensure_dirs()
    payload = {**cookies, "_meta": meta}
    write_atomic(CRED_FILE, json.dumps(payload, ensure_ascii=False), mode=0o600)


_CRED_FIELDS = {"SESSDATA": "sessdata", "bili_jct": "bili_jct", "buvid3": "buvid3",
                "buvid4": "buvid4", "DedeUserID": "dedeuserid", "ac_time_value": "ac_time_value"}
# 这些 cookie 也带上，请求更像浏览器（风控少一点）；值里不能有分号换行
_EXTRA_COOKIES = ("b_nut", "_uuid", "buvid_fp", "bili_ticket", "bili_ticket_expires", "DedeUserID__ckMd5", "sid", "rpdid")


def cred_from_data(d: dict | None) -> Credential | None:
    if not d:
        return None
    kw = {}
    for k, attr in _CRED_FIELDS.items():
        if d.get(k):
            kw[attr] = str(d[k])
    for k in _EXTRA_COOKIES:
        v = d.get(k)
        if v and not re.search(r"[;\r\n]", str(v)):
            kw[k] = str(v)
    return Credential(**kw)


def get_cred(required: bool = True, write: bool = False) -> Credential | None:
    c = cred_from_data(load_cred_data())
    if c is None and required:
        raise BiliError(say("core.get_cred.1"), say("core.get_cred.2"), code=-101)
    if write and c is not None and not c.bili_jct:
        raise BiliError(say("core.get_cred.3"), say("core.get_cred.4"), code=-111)
    return c


def my_uid() -> int:
    d = load_cred_data() or {}
    try:
        return int(d.get("DedeUserID") or 0)
    except ValueError:
        return 0


# ---------------- 每日上限 ----------------

_CAPS_FILE = DATA / "caps.json"


def _today() -> str:
    return dt.date.today().isoformat()


def cap_check(action: str, n: int = 1) -> None:
    cap = DAILY_CAPS.get(action)
    if not cap:
        return
    used = _caps_load().get(action, 0)
    if used + n > cap:
        raise BiliError(say("core.cap_check.1", a=action, b=used, c=cap), say("core.cap_check.2"))


def cap_add(action: str, n: int = 1) -> None:
    """记一次（失败也不能让已经做成的动作变成报错，所以吞掉写文件的错误）。"""
    if action not in DAILY_CAPS or not n:
        return
    try:
        with file_lock("caps"):
            d = _caps_load()
            d[action] = d.get(action, 0) + n
            write_atomic(_CAPS_FILE, json.dumps({"date": _today(), "counts": d}, ensure_ascii=False))
    except OSError:
        pass


def _caps_load() -> dict:
    try:
        raw = json.loads(_CAPS_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return raw.get("counts", {}) if raw.get("date") == _today() else {}


def caps_today() -> dict:
    used = _caps_load()
    return {k: f"{used.get(k, 0)}/{v}" for k, v in DAILY_CAPS.items() if used.get(k)}


# ---------------- 记账（memory/bili/actions.jsonl）----------------

def jsonl_append(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def jsonl_read(path: Path, limit: int | None = None) -> list[dict]:
    try:
        lines = path.read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return []
    if limit:
        lines = lines[-limit:]
    out = []
    for ln in lines:
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if isinstance(r, dict):
            out.append(r)
    return out


def log_action(action: str, ok: bool, **fields) -> None:
    row = {"ts": now_ts(), "time": fmt_ts(now_ts()), "action": action, "ok": ok}
    row.update({k: v for k, v in fields.items() if v not in (None, "")})
    try:
        jsonl_append(LEDGER / "actions.jsonl", row)
    except OSError:
        pass


# ---------------- BV 号 / 链接 ----------------

_BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")
_AV_RE = re.compile(r"(?:^|[^0-9A-Za-z])av(\d+)", re.I)


async def resolve_bvid(s: str) -> str:
    """BV 号 / 视频链接 / b23.tv 短链 / av 号 → BV 号。"""
    from bilibili_api import aid2bvid

    text = str(s or "").strip()
    m = _BV_RE.search(text)
    if m:
        return m.group(0)
    if re.fullmatch(r"\d{3,}", text):
        return aid2bvid(int(text))
    m = _AV_RE.search(text)
    if m:
        return aid2bvid(int(m.group(1)))
    m = re.search(r"(?:https?://)?((?:b23\.tv|bili2233\.cn)/[0-9A-Za-z]+)", text)
    if m:   # 分享文案里的短链：只取链接本身，只访问 b23.tv，不带 cookie
        import aiohttp
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s_:
            async with s_.get("https://" + m.group(1), allow_redirects=True, headers={"User-Agent": UA}) as r:
                m2 = _BV_RE.search(str(r.url))
                if m2:
                    return m2.group(0)
        raise BiliError(say("core.resolve_bvid.1", a=m.group(1)), say("core.resolve_bvid.2"))
    raise BiliError(say("core.resolve_bvid.3", a=cut(text, 60)), say("core.resolve_bvid.4"))


# ---------------- 节流 + 统一包装 ----------------

_gap_lock = asyncio.Lock()
_last_call = 0.0


async def _pace() -> None:
    global _last_call
    async with _gap_lock:
        wait = MIN_GAP_SEC - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()


_cap_locks: dict[str, asyncio.Lock] = {}


def bili_tool(*, network: bool = True, cap: str | None = None, cap_arg: str | None = None):
    """包装工具函数：查冷却 → 节流 → 跑 → 把异常翻成 {"ok": False, ...}。

    cap：这个动作按天计数（只在成功时加）。同一个动作的调用排队做（查上限 → 做 → 记数），并发也冲不破上限。
    cap_arg：按哪个参数计数（比如投币按 num）；工具也可以在返回里带 "_cap_n" 改实际计数，"_cap_extra" 给别的动作记数。
    """
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            if network:
                left = cooldown_left()
                if left:
                    return {"ok": False, "error": say("core.wrapper.1", a=left // 60 + 1),
                            "hint": say("core.wrapper.2")}
                await _pace()
            lock = _cap_locks.setdefault(cap, asyncio.Lock()) if cap else contextlib.nullcontext()
            async with lock:
                try:
                    if cap:
                        want = 1
                        if cap_arg and kwargs.get(cap_arg) is not None:
                            with contextlib.suppress(TypeError, ValueError):
                                want = max(1, int(kwargs[cap_arg]))
                        cap_check(cap, want)
                    out = await fn(*args, **kwargs)
                except Exception as e:  # noqa: BLE001 —— 工具不能把异常抛给宿主
                    err, hint, code = explain_exc(e)
                    if code in RISK_CODES:
                        start_cooldown(err)
                    res = {"ok": False, "error": err}
                    if hint:
                        res["hint"] = hint
                    if code is not None:
                        res["code"] = code
                    if isinstance(e, BiliError):
                        res.update({k: v for k, v in e.extra.items() if k != "code"})
                    return res
                if isinstance(out, dict):
                    n = out.pop("_cap_n", 1)
                    extra = out.pop("_cap_extra", None) or {}
                    if cap and out.get("ok", True) and not out.get("already") and n:
                        cap_add(cap, n)
                    for k, v in extra.items():
                        cap_add(k, v)
                    out.setdefault("ok", True)
            return out
        return wrapper
    return deco
