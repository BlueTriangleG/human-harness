"""登录：从{me}自己的浏览器（HH 直接连的那个 Chrome）同步 B站 cookie；查登录状态；扫码兜底。

为什么从浏览器同步：她的 {me}的浏览器本来就登着 B站，网页会自己续期 cookie。
插件这边**从不刷新 cookie**（B站 刷新会让旧 cookie 失效，浏览器那边就掉线了），
过期了就再同步一次。只取 *.bilibili.com 的 cookie，别的站一个都不碰。
"""
from __future__ import annotations

import asyncio
import json
import os

from bilibili_api import Api
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

from . import core
from .core import BiliError, bili_tool

_KEEP = {"SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4", "b_nut", "_uuid",
         "buvid_fp", "bili_ticket", "bili_ticket_expires", "sid", "rpdid", "ac_time_value"}

# 11-01 起经 HH 拿 cookie（hh browser cookies）：HH 直接连她的 Chrome，不再起命令行开浏览器（主人：不要走 OpenClaw）
HH_BIN = os.environ.get("HH_BIN") or "hh"


async def _browser_cookies(url: str, timeout: float = 90) -> dict:
    """打开一下 url（让网页自己续期）再拿 cookie；浏览器没开就临时无头开一下、用完关掉（都是 HH 那边做）。"""
    proc = await asyncio.create_subprocess_exec(
        HH_BIN, "browser", "cookies", url, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise BiliError(core.say("auth._browser_cookies.1"), core.say("auth._browser_cookies.2"))
    text = out.decode("utf-8", "replace").strip()
    try:
        return json.loads(text)
    except ValueError:
        raise BiliError(core.say("auth._browser_cookies.3"), core.cut(err.decode("utf-8", "replace").strip() or text, 200))


async def nav_info(cred) -> dict:
    """/x/web-interface/nav：登录态、昵称、等级、硬币。"""
    return await Api(url="https://api.bilibili.com/x/web-interface/nav", method="GET",
                     credential=cred, ignore_code=True).result


def _summary(nav: dict) -> dict:
    lv = (nav.get("level_info") or {}).get("current_level", 0)
    return {
        "logged_in": bool(nav.get("isLogin")),
        "uid": nav.get("mid"),
        "name": nav.get("uname"),
        "level": lv,
        "can_comment": lv >= 1,     # Lv0 = 注册会员（没答题转正）：发不了评论和弹幕
        "coins": nav.get("money"),
        "vip": bool((nav.get("vip") or {}).get("status")),
    }


@bili_tool(network=False)        # 冷却中也要能看（不然永远看不到冷却还剩多久）
async def auth_status() -> dict:
    d = core.load_cred_data()
    out = {"ok": True, "credential": bool(d), "cooldown_sec": core.cooldown_left(), "caps_today": core.caps_today()}
    if not d:
        out.update(logged_in=False, hint=core.say("auth.auth_status.1"))
        return out
    meta = d.get("_meta") or {}
    out["synced_at"] = meta.get("synced_at", "")
    out["sessdata_expires"] = meta.get("sessdata_expires", "")
    nav = await nav_info(core.get_cred())
    out.update(_summary(nav))
    if not out["logged_in"]:
        out["hint"] = core.say("auth.auth_status.2")
    elif not out["can_comment"]:
        out["hint"] = core.say("auth.auth_status.3")
    return out


_sync_lock = asyncio.Lock()


@bili_tool()
async def auth_sync() -> dict:
    async with _sync_lock:                      # 两个同时同步会互相关掉对方开的浏览器
        return await _auth_sync_locked()


async def _auth_sync_locked() -> dict:
    res = await _browser_cookies("https://www.bilibili.com/")
    jar: dict[str, dict] = {}
    for c in res.get("cookies") or []:
        dom = str(c.get("domain") or "")
        if not (dom == "bilibili.com" or dom.endswith(".bilibili.com")):
            continue
        name = c.get("name")
        if name not in _KEEP:
            continue
        # 同名的取 .bilibili.com 那份（站点级）
        if name in jar and jar[name]["domain"] == ".bilibili.com":
            continue
        jar[name] = c
    if "SESSDATA" not in jar:
        raise BiliError(core.say("auth._auth_sync_locked.1"), core.say("auth._auth_sync_locked.2"))
    cookies = {k: str(v.get("value") or "") for k, v in jar.items()}
    exp = jar["SESSDATA"].get("expires") or 0
    meta = {"synced_at": core.fmt_ts(core.now_ts()), "source": "{me}的浏览器（HH）",   # stored as it always was (the name never filled in)
            "sessdata_expires": core.fmt_ts(exp) if exp and exp > 0 else ""}
    cred = core.cred_from_data(cookies)
    nav = await nav_info(cred)
    s = _summary(nav)
    if not s["logged_in"]:
        raise BiliError(core.say("auth._auth_sync_locked.3"), core.say("auth._auth_sync_locked.4"))
    core.save_cred_data(cookies, meta)
    return {"ok": True, "synced": len(cookies), **s, **{k: meta[k] for k in ("synced_at", "sessdata_expires")}}


# ---------- 扫码登录（兜底：浏览器那条路走不通时） ----------

_qr: QrCodeLogin | None = None


@bili_tool()
async def login_qr() -> dict:
    global _qr
    _qr = QrCodeLogin()
    await _qr.generate_qrcode()
    pic = _qr.get_qrcode_picture()
    path = core.WS / "tmp" / "bili-login-qr.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pic.content)
    return {"ok": True, "qrcode_png": str(path), "expires_in_sec": 180,
            "next": core.say("auth.login_qr.1"),
            "size_kb": round(len(pic.content) / 1024, 1)}


@bili_tool()
async def login_check() -> dict:
    global _qr
    if _qr is None:
        return {"ok": False, "error": core.say("auth.login_check.1"), "hint": core.say("auth.login_check.2")}
    state = await _qr.check_state()
    if state == QrCodeLoginEvents.SCAN:
        return {"ok": True, "status": "waiting_scan", "next": core.say("auth.login_check.3")}
    if state == QrCodeLoginEvents.CONF:
        return {"ok": True, "status": "scanned_waiting_confirm", "next": core.say("auth.login_check.4")}
    if state == QrCodeLoginEvents.TIMEOUT:
        _qr = None
        return {"ok": True, "status": "timeout", "next": core.say("auth.login_check.5")}
    if state == QrCodeLoginEvents.DONE:
        c = _qr.get_credential()
        _qr = None
        cookies = {"SESSDATA": c.sessdata, "bili_jct": c.bili_jct, "buvid3": c.buvid3 or "",
                   "DedeUserID": c.dedeuserid, "ac_time_value": c.ac_time_value or ""}
        cookies = {k: v for k, v in cookies.items() if v}
        core.save_cred_data(cookies, {"synced_at": core.fmt_ts(core.now_ts()), "source": "qrcode"})
        nav = await nav_info(core.get_cred())
        return {"ok": True, "status": "done", **_summary(nav)}
    return {"ok": True, "status": str(state)}


TOOLS = [auth_status, auth_sync, login_qr, login_check]
