"""消息：未读数、回复我的 / @我的 / 收到的赞 / 系统通知、私信（会话列表、读、发）。

私信接口（2026-10 实测，来自 dsh-bili-scroll 的 lib/dm.mjs）：
  会话：api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions（GET）
  消息：api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs（GET，倒序）
  发送：session.send_msg（有 msg_key 才算真送到；500 字以内，超了 code 21007）
"""
from __future__ import annotations

import json
import re

from bilibili_api import Api, session

from . import core
from .core import BiliError, bili_tool
from .discover import _resolve_uid

_BV = re.compile(r"BV[0-9A-Za-z]{10}")


@bili_tool()
async def unread() -> dict:
    cred = core.get_cred()
    res = await session.get_unread_messages(credential=cred) or {}
    out = {"reply": res.get("reply", 0), "at": res.get("at", 0), "like": res.get("like", 0),
           "system": res.get("sys_msg", 0), "up_assistant": res.get("up", 0)}
    try:
        dm = await Api(url="https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread", method="GET",
                       credential=cred).update_params(unread_type=0, show_unfollow_list=1, show_dustbin=1,
                                                      build=0, mobi_app="web").result
        out["dm"] = (dm or {}).get("follow_unread", 0) + (dm or {}).get("unfollow_unread", 0)
        out["dm_from_strangers"] = (dm or {}).get("unfollow_unread", 0)
    except Exception:  # noqa: BLE001
        pass
    out["any"] = any(v for k, v in out.items() if isinstance(v, int) and k != "dm_from_strangers")
    return out


def _where(item: dict) -> dict:
    uri = str(item.get("uri") or item.get("native_uri") or "")
    m = _BV.search(uri)
    w = {"on": core.cut(item.get("title"), 60), "url": uri or None}
    if m:
        w["bvid"] = m.group(0)
    if item.get("business"):
        w["kind"] = item.get("business")
    return w


@bili_tool()
async def notifications(kind: str = "reply", num: int = 20) -> dict:
    cred = core.get_cred()
    n = max(1, min(int(num or 20), 50))
    out = []
    if kind == "reply":
        res = await session.get_replies(credential=cred) or {}
        for it in (res.get("items") or [])[:n]:
            u, i = it.get("user") or {}, it.get("item") or {}
            row = {"user": u.get("nickname"), "mid": u.get("mid"), "time": core.fmt_ts(it.get("reply_time")),
                   "text": core.cut(i.get("source_content"), 300), "my_text": core.cut(i.get("target_reply_content") or i.get("title"), 120),
                   "rpid": i.get("source_id"), "root": i.get("root_id") or i.get("source_id"), "parent": i.get("target_id"),
                   "oid": i.get("subject_id"), "type": i.get("business_id"), **_where(i)}
            out.append(row)
    elif kind == "at":
        res = await session.get_at(credential=cred) or {}
        for it in (res.get("items") or [])[:n]:
            u, i = it.get("user") or {}, it.get("item") or {}
            out.append({"user": u.get("nickname"), "mid": u.get("mid"), "time": core.fmt_ts(it.get("at_time")),
                        "text": core.cut(i.get("source_content"), 300), "rpid": i.get("source_id"),
                        "root": i.get("root_id") or i.get("source_id"), "oid": i.get("subject_id"),
                        "type": i.get("business_id"), **_where(i)})
    elif kind == "like":
        res = await session.get_likes(credential=cred) or {}
        total = (res.get("total") or {}).get("items") or []
        for it in total[:n]:
            i = it.get("item") or {}
            us = [x.get("nickname") for x in (it.get("users") or [])[:5]]
            out.append({"who": us, "count": it.get("counts"), "time": core.fmt_ts(it.get("like_time")),
                        "my_text": core.cut(i.get("title") or i.get("desc"), 100), **_where(i)})
    elif kind == "system":
        res = await Api(url="https://message.bilibili.com/x/sys-msg/query_user_notify", method="GET",
                        credential=cred).update_params(csrf=cred.bili_jct or "", page_size=n, build=0,
                                                       mobi_app="web").result
        for it in ((res or {}).get("system_notify_list") or [])[:n]:
            out.append({"time": it.get("time_at"), "title": it.get("title"), "text": core.cut(it.get("content"), 300)})
    else:
        raise BiliError(core.say("inbox.notifications.1"))
    return {"kind": kind, "count": len(out), "items": out}


# ---------------- 私信 ----------------

async def _names(uids: list[int], cred) -> dict[int, str]:
    if not uids:
        return {}
    try:
        res = await Api(url="https://api.vc.bilibili.com/account/v1/user/cards", method="GET",
                        credential=cred).update_params(uids=",".join(map(str, uids[:50]))).result
        return {int(x.get("mid")): x.get("name") for x in (res or []) if x.get("mid")}
    except Exception:  # noqa: BLE001
        return {}


def _msg_text(m: dict) -> str:
    mt = int(m.get("msg_type") or 1)
    try:
        c = json.loads(m.get("content") or "{}")
    except ValueError:
        return str(m.get("content") or "")[:500]
    if not isinstance(c, dict):
        return str(c)[:500]
    if mt in (7, 8) or c.get("jump_url") or c.get("bvid"):
        bv = str(c.get("bvid") or "")
        if not bv:
            m2 = _BV.search(str(c.get("jump_url") or ""))
            bv = m2.group(0) if m2 else ""
        title = c.get("title") or c.get("headline") or ""
        if bv or title:
            return core.say("inbox._msg_text.1", a=core.cut(title, 60), b=c.get('author') or '', c=bv or c.get('jump_url') or '').strip()
    if mt == 2:
        return core.say("inbox._msg_text.2", a=c.get('url', ''))
    if mt == 6:
        return core.say("inbox._msg_text.3")
    return str(c.get("content") or c.get("text") or c.get("title") or "")[:500] or core.say("inbox._msg_text.4", a=mt)


@bili_tool()
async def dm_sessions(num: int = 20, unread_only: bool = False) -> dict:
    cred = core.get_cred()
    res = await Api(url="https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions", method="GET",
                    credential=cred).update_params(session_type=1, group_id=0, build=0, mobi_app="web").result
    rows = []
    for s in (res or {}).get("session_list") or []:
        uid = int(s.get("talker_id") or 0)
        if not uid:
            continue
        lm = s.get("last_msg") or {}
        rows.append({"uid": uid, "unread": int(s.get("unread_count") or 0), "time": core.fmt_ts(lm.get("timestamp") or s.get("session_ts", 0) // 1_000_000),
                     "last": core.cut(_msg_text(lm), 80) if lm else "", "last_from_me": int(lm.get("sender_uid") or 0) == core.my_uid(),
                     "follow": bool(s.get("is_follow")),
                     # 给感官层去重/过滤用（bili_events.py dm 模式）；msg_key 超过 2^53，按字符串给
                     "last_msg_key": str(lm.get("msg_key") or ""), "last_seq": str(lm.get("msg_seqno") or ""),
                     "last_ts": int(lm.get("timestamp") or 0), "official": bool(lm.get("notify_code") or lm.get("account_info"))})
    if unread_only:
        rows = [r for r in rows if r["unread"]]
    rows = rows[: max(1, min(int(num or 20), 50))]
    names = await _names([r["uid"] for r in rows], cred)
    for r in rows:
        r["name"] = names.get(r["uid"])
    return {"count": len(rows), "sessions": rows}


@bili_tool()
async def dm_read(who: str, num: int = 20) -> dict:
    uid, name = await _resolve_uid(who)
    cred = core.get_cred()
    res = await Api(url="https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs", method="GET",
                    credential=cred).update_params(talker_id=uid, session_type=1, size=max(1, min(int(num or 20), 50)),
                                                   build=0, mobi_app="web").result
    me = core.my_uid()
    msgs = []
    for m in reversed((res or {}).get("messages") or []):
        msgs.append({"time": core.fmt_ts(m.get("timestamp")), "from_me": int(m.get("sender_uid") or 0) == me,
                     "text": _msg_text(m)})
    try:   # 标已读
        last = max((int(m.get("msg_seqno") or 0) for m in (res or {}).get("messages") or []), default=0)
        if last:
            await Api(url="https://api.vc.bilibili.com/session_svr/v1/session_svr/update_ack", method="POST",
                      credential=cred).update_data(talker_id=uid, session_type=1, ack_seqno=last, build=0,
                                                   mobi_app="web", csrf_token=cred.bili_jct, csrf=cred.bili_jct).result
    except Exception:  # noqa: BLE001
        pass
    if not name:
        name = (await _names([uid], cred)).get(uid, "")
    return {"uid": uid, "name": name, "count": len(msgs), "messages": msgs}


@bili_tool(cap="dm_send")
async def dm_send(who: str, text: str) -> dict:
    msg = str(text or "").strip()
    if not msg:
        raise BiliError(core.say("inbox.dm_send.1"))
    if len(msg) > 500:
        raise BiliError(core.say("inbox.dm_send.2", a=len(msg)), core.say("inbox.dm_send.3"))
    uid, name = await _resolve_uid(who)
    cred = core.get_cred(write=True)
    res = await session.send_msg(credential=cred, receiver_id=uid, msg_type=session.EventType.TEXT, content=msg)
    data = res if isinstance(res, dict) else {}
    key = data.get("msg_key") or ((data.get("data") or {}).get("msg_key") if isinstance(data.get("data"), dict) else None)
    if not key:
        core.log_action("dm_send", False, uid=uid, name=name, text=core.cut(msg, 200))
        raise BiliError(core.say("inbox.dm_send.4"), core.say("inbox.dm_send.5"))
    core.log_action("dm_send", True, uid=uid, name=name, text=core.cut(msg, 200))
    return {"uid": uid, "name": name, "delivered": True, "msg_key": str(key)[:16]}


TOOLS = [unread, notifications, dm_sessions, dm_read, dm_send]
