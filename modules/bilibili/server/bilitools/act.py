"""互动：点赞、投币、三连、收藏、稍后再看、关注、评论（可 @ 人）、评论点赞/删除、评论复核、弹幕。

所有写操作：
  - 按天有上限（core.DAILY_CAPS），防循环刷屏；
  - 记进 memory/bili/actions.jsonl（评论带 rpid/root，复核和回看都靠它）。
对外说话（评论、弹幕、私信、动态）照 AGENTS.md 的规矩：@{owner_handle} 可以直接发，对别人先问 {owner}。
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import time
from pathlib import Path

import aiohttp
from bilibili_api import Api, Danmaku, Picture, comment, dynamic, favorite_list, user, video
from bilibili_api.exceptions import ResponseCodeException

from . import core, ledger
from .core import BiliError, bili_tool
from .discover import _resolve_uid, norm_video

_last_coin = 0.0
_coin_lock = asyncio.Lock()


def _already(e: Exception) -> bool:
    return isinstance(e, ResponseCodeException) and getattr(e, "code", None) in core.ALREADY_CODES


async def _vid(bvid: str, write: bool = True):
    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred(write=write)
    v = video.Video(bvid=bv, credential=cred)
    info = await v.get_info()
    return bv, cred, v, info


def _title(info: dict) -> str:
    return core.cut(info.get("title"), 60)


# ---------------- 赞 / 币 / 三连 ----------------

@bili_tool(cap="like")
async def like(bvid: str, on: bool = True) -> dict:
    bv, cred, v, info = await _vid(bvid)
    try:
        await v.like(bool(on))
        already = False
    except ResponseCodeException as e:
        if e.code in (65004, 65006):
            already = True
        else:
            raise
    core.log_action("like" if on else "unlike", True, bvid=bv, title=_title(info))
    return {"bvid": bv, "title": info.get("title"), "liked": bool(on), "already": already}


async def _coin_pace():
    """投币/三连之间隔 8–15 秒（连着投最容易被要人机验证）。加锁：并发调用也会排队。"""
    global _last_coin
    async with _coin_lock:
        wait = random.uniform(8, 15) - (time.monotonic() - _last_coin)
        if _last_coin and wait > 0:
            await asyncio.sleep(wait)
        _last_coin = time.monotonic()


@bili_tool(cap="coin", cap_arg="num")
async def coin(bvid: str, num: int = 1, also_like: bool = True) -> dict:
    n = 2 if int(num or 1) >= 2 else 1
    bv, cred, v, info = await _vid(bvid)
    await _coin_pace()
    # 库里的 pay_coin 把「顺便点赞」的参数写成 like，接口要的是 select_like，这里自己发
    await Api(url="https://api.bilibili.com/x/web-interface/coin/add", method="POST", verify=True,
              credential=cred).update_data(aid=int(info["aid"]), bvid=bv, multiply=n,
                                           select_like=1 if also_like else 0).result
    core.log_action("coin", True, bvid=bv, title=_title(info), n=n)
    return {"bvid": bv, "title": info.get("title"), "coins": n, "liked": bool(also_like), "_cap_n": n}


@bili_tool(cap="triple")
async def triple(bvid: str) -> dict:
    core.cap_check("coin", 2)
    bv, cred, v, info = await _vid(bvid)
    await _coin_pace()
    r = await v.triple() or {}
    spent = int(r.get("multiply") or 0)
    core.log_action("triple", True, bvid=bv, title=_title(info), coins=spent)
    return {"bvid": bv, "title": info.get("title"), "like": r.get("like"), "coin": r.get("coin"),
            "favorite": r.get("fav"), "coins_spent": spent, "_cap_extra": {"coin": spent}}


# ---------------- 收藏 / 稍后再看 ----------------

async def _folders(cred) -> list[dict]:
    res = await favorite_list.get_video_favorite_list(uid=core.my_uid(), credential=cred)
    return [{"id": x.get("id"), "title": x.get("title"), "count": x.get("media_count", 0)}
            for x in (res or {}).get("list") or []]


@bili_tool()
async def fav_folders() -> dict:
    return {"folders": await _folders(core.get_cred())}


@bili_tool()
async def fav_create(title: str, intro: str = "", private: bool = False) -> dict:
    res = await favorite_list.create_video_favorite_list(title=str(title)[:20], introduction=intro or "",
                                                         private=bool(private), credential=core.get_cred(write=True))
    core.log_action("fav_create", True, title=title)
    return {"id": (res or {}).get("id"), "title": title}


@bili_tool(cap="favorite")
async def favorite(bvid: str, folder: str = "", remove: bool = False) -> dict:
    bv, cred, v, info = await _vid(bvid)
    fs = await _folders(cred)
    if not fs:
        raise BiliError(core.say("act.favorite.1"), core.say("act.favorite.2"))
    f = str(folder or "").strip()
    target = fs[0] if not f else next((x for x in fs if str(x["id"]) == f or x["title"] == f), None)
    if not target:
        raise BiliError(core.say("act.favorite.3", a=f), core.say("act.favorite.4") + core.say("listSep").join(x["title"] for x in fs))
    try:
        if remove:
            await v.set_favorite(del_media_ids=[int(target["id"])])
        else:
            await v.set_favorite(add_media_ids=[int(target["id"])])
        already = False
    except ResponseCodeException as e:
        if _already(e):
            already = True
        else:
            raise
    core.log_action("unfavorite" if remove else "favorite", True, bvid=bv, title=_title(info), folder=target["title"])
    return {"bvid": bv, "title": info.get("title"), "folder": target["title"], "removed": bool(remove), "already": already}


@bili_tool()
async def fav_content(folder: str = "", page: int = 1, keyword: str = "") -> dict:
    cred = core.get_cred()
    f = str(folder or "").strip()
    if f.isdigit() and len(f) > 6:
        mid = int(f)
    else:
        fs = await _folders(cred)
        t = fs[0] if not f else next((x for x in fs if x["title"] == f or str(x["id"]) == f), None)
        if not t:
            raise BiliError(core.say("act.fav_content.1", a=f))
        mid = int(t["id"])
    res = await favorite_list.get_video_favorite_list_content(media_id=mid, page=max(1, int(page or 1)),
                                                              keyword=keyword or None, credential=cred)
    vids = []
    for m in (res or {}).get("medias") or []:
        v = norm_video({**m, "author": (m.get("upper") or {}).get("name"), "play": (m.get("cnt_info") or {}).get("play")})
        if v:
            v["faved"] = core.fmt_ts(m.get("fav_time"))
            vids.append(v)
    return {"folder": ((res or {}).get("info") or {}).get("title"), "id": mid, "has_more": (res or {}).get("has_more"),
            "count": len(vids), "videos": ledger.annotate(vids)}


@bili_tool(cap="toview")
async def toview_add(bvid: str) -> dict:
    bv, cred, v, info = await _vid(bvid)
    await v.add_to_toview()
    core.log_action("toview_add", True, bvid=bv, title=_title(info))
    return {"bvid": bv, "title": info.get("title")}


@bili_tool()
async def toview_remove(bvid: str) -> dict:
    bv, cred, v, info = await _vid(bvid)
    await v.delete_from_toview()
    core.log_action("toview_remove", True, bvid=bv)
    return {"bvid": bv, "removed": True}


@bili_tool()
async def toview_list(num: int = 30) -> dict:
    res = await user.get_toview_list(credential=core.get_cred()) or {}
    vids = []
    for it in (res.get("list") or [])[: max(1, min(int(num or 30), 100))]:
        v = norm_video(it)
        if v:
            pg = it.get("progress", 0)
            v["progress"] = core.say("act.toview_list.1") if pg == -1 else core.fmt_dur(pg)
            v["added"] = core.fmt_ts(it.get("add_at"))
            vids.append(v)
    return {"total": res.get("count"), "count": len(vids), "videos": ledger.annotate(vids)}


# ---------------- 关注 ----------------

@bili_tool(cap="follow")
async def follow(who: str, on: bool = True) -> dict:
    uid, name = await _resolve_uid(who)
    u = user.User(uid, credential=core.get_cred(write=True))
    try:
        await u.modify_relation(user.RelationType.SUBSCRIBE if on else user.RelationType.UNSUBSCRIBE)
        already = False
    except ResponseCodeException as e:
        if e.code == 22014:
            already = True
        else:
            raise
    core.log_action("follow" if on else "unfollow", True, uid=uid, name=name)
    return {"uid": uid, "name": name, "following": bool(on), "already": already}


# ---------------- 评论 ----------------

_AT_RE = re.compile(r"@([^\s@:：,，。!！?？]{1,24})")


async def _at_map(text: str, at: list[str] | None) -> dict[str, int]:
    names = list(dict.fromkeys([*(a.lstrip("@") for a in (at or [])), *_AT_RE.findall(text)]))
    out = {}
    for n in names[:10]:
        try:
            uid, _ = await _resolve_uid(n)
        except BiliError:
            continue
        out[n] = uid
    return out


STICKER_DIR = core.WS / "stickers"
IMG_EXTS = {".gif", ".png", ".jpg", ".jpeg", ".webp"}
MAX_IMAGES, MAX_IMG_BYTES = 3, 20 * 1024 * 1024


def _check_images(images: list[str] | None) -> list[Path]:
    """只收 stickers/ 下的 gif/png/jpg/webp，最多 3 张。"""
    out = []
    for raw in images or []:
        p = Path(str(raw)).expanduser().resolve()
        if not p.is_relative_to(STICKER_DIR.resolve()):
            raise BiliError(core.say("act._check_images.1", a=raw))
        if p.suffix.lower() not in IMG_EXTS:
            raise BiliError(core.say("act._check_images.2", a=raw))
        if not p.is_file():
            raise BiliError(core.say("act._check_images.3", a=raw))
        if p.stat().st_size > MAX_IMG_BYTES:
            raise BiliError(core.say("act._check_images.4", a=raw))
        out.append(p)
    if len(out) > MAX_IMAGES:
        raise BiliError(core.say("act._check_images.5", a=MAX_IMAGES), core.say("act._check_images.6"))
    return out


async def _upload_pictures(paths: list[Path], cred) -> list[dict]:
    """传到 B站图床（x/dynamic/feed/draw/upload_bfs，category=daily），返回评论接口要的 pictures。"""
    pics = []
    for p in paths:
        res = await dynamic.upload_image(Picture.from_file(str(p)), cred)
        pics.append({"img_src": res["image_url"], "img_width": res["image_width"],
                     "img_height": res["image_height"], "img_size": res["img_size"]})
    return pics


async def _send_reply(oid: int, type_: int, text: str, root: int, parent: int, at_map: dict, cred,
                      pictures: list[dict] | None = None) -> dict:
    data = {"oid": oid, "type": type_, "message": text, "plat": 1, "gaia_source": "main_web",
            "statistics": json.dumps({"appId": 100, "platform": 5})}
    if root:
        data.update(root=root, parent=parent or root)
    if at_map:
        data["at_name_to_mid"] = json.dumps(at_map, ensure_ascii=False)
    if pictures:
        data["pictures"] = json.dumps(pictures, ensure_ascii=False)
    return await Api(url="https://api.bilibili.com/x/v2/reply/add", method="POST", verify=True, wbi=True, dm=True,
                     credential=cred).update_data(**data).result


def _only_own_video(info: dict) -> None:
    """#0053（11-09 两条评论白发）：MCP 在别人视频下发的评论会被藏成「只有自己看得见」，网页发的才公开。
    所以只放行自己视频下的评论/回楼；别人的视频直接拒，叫她走网页。查不到自己的 UID 也拒（宁可多走一次网页）。"""
    owner = int(((info or {}).get("owner") or {}).get("mid") or 0)
    me = core.my_uid()
    if not me or owner != me:
        who = ((info or {}).get("owner") or {}).get("name") or owner or "?"
        raise BiliError(core.say("act._only_own_video.1", a=who),
                        core.say("act._only_own_video.2"))


@bili_tool(cap="reply")
async def reply(text: str, bvid: str = "", rpid: int = 0, root: int = 0, at: list[str] | None = None,
                oid: int = 0, type: int = 1, images: list[str] | None = None) -> dict:  # noqa: A002
    msg = str(text or "").strip()
    if not msg:
        raise BiliError(core.say("act.reply.1"))
    if len(msg) > 1000:
        raise BiliError(core.say("act.reply.2"), core.say("act.reply.3"))
    img_paths = _check_images(images)          # 先校验，别等传完图才报错
    cred = core.get_cred(write=True)
    title, bv = "", ""
    if bvid:
        bv = await core.resolve_bvid(bvid)
        info = await video.Video(bvid=bv, credential=cred).get_info()
        oid, type_, title = int(info["aid"]), 1, info.get("title", "")
        _only_own_video(info)
    elif oid:
        type_ = int(type or 1)
        if type_ == 1:                         # oid+type=1 也是视频（aid），一样要看是谁的
            _only_own_video(await video.Video(aid=int(oid), credential=cred).get_info())
    else:
        raise BiliError(core.say("act.reply.4"))
    for name in [a.lstrip("@") for a in (at or []) if str(a).strip()]:
        if f"@{name}" not in msg:              # at_name_to_mid 只对正文里真有「@昵称」的生效
            msg = f"{msg} @{name} "
    msg = msg.strip()
    at_map = await _at_map(msg, None)
    root = int(root or 0)
    parent = int(rpid or 0)
    if parent and not root:
        root = parent
    pictures = await _upload_pictures(img_paths, cred) if img_paths else None
    res = await _send_reply(int(oid), type_, msg, root, parent, at_map, cred, pictures)
    r = (res or {}).get("reply") or {}
    new_rpid = (res or {}).get("rpid") or r.get("rpid")
    out = {"bvid": bv or None, "oid": oid, "rpid": new_rpid, "root": root or None, "parent": parent or None,
           "at": at_map or None, "images": len(pictures) if pictures else None, "title": title or None, "success_toast": (res or {}).get("success_toast"),
           "next": core.say("act.out.1")}
    core.log_action("reply", True, bvid=bv, oid=oid, type=type_, rpid=new_rpid, root=root, parent=parent,
                    title=core.cut(title, 60), text=core.cut(msg, 300), at=list(at_map) or None,
                    images=[p.name for p in img_paths] or None)
    return {k: v for k, v in out.items() if v is not None}


@bili_tool(cap="comment_like")
async def comment_like(bvid: str, rpid: int, on: bool = True) -> dict:
    bv, cred, v, info = await _vid(bvid)
    c = comment.Comment(oid=int(info["aid"]), type_=comment.CommentResourceType.VIDEO, rpid=int(rpid), credential=cred)
    await c.like(status=bool(on))
    core.log_action("comment_like", True, bvid=bv, rpid=rpid, on=on)
    return {"bvid": bv, "rpid": rpid, "liked": bool(on)}


@bili_tool(cap="comment_delete")
async def comment_delete(bvid: str, rpid: int) -> dict:
    bv, cred, v, info = await _vid(bvid)
    c = comment.Comment(oid=int(info["aid"]), type_=comment.CommentResourceType.VIDEO, rpid=int(rpid), credential=cred)
    await c.delete()
    core.log_action("comment_delete", True, bvid=bv, rpid=rpid)
    return {"bvid": bv, "rpid": rpid, "deleted": True}


async def _get_json(url: str, jar: dict) -> dict:
    """只发给 api.bilibili.com，不跟跳转（cookie 不会被带到别处）；接口报错就抛（别把「没查到」和「查不了」混在一起）。"""
    headers = {"User-Agent": core.UA, "Referer": "https://www.bilibili.com/",
               "Cookie": "; ".join(f"{k}={v}" for k, v in jar.items())}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
        async with s.get(url, headers=headers, allow_redirects=False) as r:
            if r.status == 412:
                raise BiliError(core.say("act._get_json.1"), core.say("act._get_json.2"), code=-412)
            d = await r.json(content_type=None)
    code = (d or {}).get("code")
    if code not in (0, None):
        raise ResponseCodeException(code, str((d or {}).get("message") or ""), d)
    return d


def _jar(login: bool) -> dict:
    d = core.load_cred_data() or {}
    keep = ("SESSDATA", "bili_jct", "buvid3", "buvid4", "DedeUserID") if login else ("buvid3", "buvid4", "b_nut")
    return {k: v for k, v in d.items() if k in keep}      # 匿名也带 buvid，不然 412


async def _find_reply(aid: int, rpid: int, root: int, login: bool) -> tuple[dict | None, list[dict]]:
    """找 rpid。返回 (找到的那条, 看到的列表)。
    顶层：/x/v2/reply/main?mode=2（按时间，匿名只给最新 3 条；登录给 20 条/页，翻 3 页）。
    楼中楼：/x/v2/reply/reply?root=…（匿名登录都给全）。
    ⚠️ 旧的 /x/v2/reply?sort=0 匿名返回空列表，会把公开评论误判成「只有自己看得见」，别用。"""
    jar = _jar(login)
    seen: list[dict] = []
    if root:
        urls = [f"https://api.bilibili.com/x/v2/reply/reply?type=1&oid={aid}&root={root}&ps=20&pn={pn}" for pn in (1, 2, 3)]
    else:
        pages = (0, 2, 3) if login else (0,)
        urls = [f"https://api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=2&next={n}&ps=20" for n in pages]
        urls.append(f"https://api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=3&next=0&ps=20")   # 热评第一页
    for i, url in enumerate(urls):
        d = await _get_json(url, jar)
        reps = ((d or {}).get("data") or {}).get("replies") or []
        if "mode=3" not in url:
            seen.extend(reps)
        hit = next((x for x in reps if int(x.get("rpid") or 0) == rpid), None)
        if hit:
            return hit, seen
        if root and len(reps) < 20:
            break
        await asyncio.sleep(0.4)
    return None, seen


async def _verify_one(bvid: str, rpid: int, root: int) -> dict:
    info = await video.Video(bvid=bvid, credential=core.get_cred(required=False)).get_info()
    aid = int(info["aid"])
    base = {"bvid": bvid, "rpid": rpid}
    pub, anon_list = await _find_reply(aid, rpid, root, login=False)
    if pub:
        return {**base, "status": core.say("act._verify_one.1"), "likes": pub.get("like")}
    mine, _ = await _find_reply(aid, rpid, root, login=True)
    if not mine:
        return {**base, "status": core.say("act._verify_one.2"), "hint": core.say("act._verify_one.3")}
    if root:
        return {**base, "status": core.say("act._verify_one.4"), "likes": mine.get("like"),
                "hint": core.say("act._verify_one.5")}
    # 顶层：匿名只看得到最新 3 条。要是我这条比匿名看到的最旧那条还新，却不在里面 → 别人看不见
    oldest_anon = min((int(x.get("ctime") or 0) for x in anon_list), default=0)
    if not anon_list or int(mine.get("ctime") or 0) >= oldest_anon:
        return {**base, "status": core.say("act._verify_one.6"), "likes": mine.get("like"),
                "hint": core.say("act._verify_one.7")}
    return {**base, "status": core.say("act._verify_one.8"), "likes": mine.get("like"),
            "hint": core.say("act._verify_one.9")}


@bili_tool()
async def comment_verify(bvid: str = "", rpid: int = 0, root: int = 0, recent: int = 0) -> dict:
    if recent:
        rows = [r for r in core.jsonl_read(core.LEDGER / "actions.jsonl") if r.get("action") == "reply" and r.get("bvid") and r.get("rpid")]
        rows = rows[-max(1, min(int(recent), 10)):]
        out = []
        for r in reversed(rows):
            try:
                res = await _verify_one(r["bvid"], int(r["rpid"]), int(r.get("root") or 0))
            except Exception as e:  # noqa: BLE001
                res = {"bvid": r["bvid"], "rpid": r["rpid"], "status": core.say("act.res.1"), "error": core.note_error(e)}
            res.update(time=r.get("time"), text=core.cut(r.get("text"), 40))
            out.append(res)
            await asyncio.sleep(0.6)
        return {"checked": out}
    if not (bvid and rpid):
        raise BiliError(core.say("act.comment_verify.1"))
    bv = await core.resolve_bvid(bvid)
    return await _verify_one(bv, int(rpid), int(root or 0))


@bili_tool(network=False)
async def my_comments(days: int = 7, num: int = 30) -> dict:
    since = time.time() - max(1, int(days or 7)) * 86400
    rows = [r for r in core.jsonl_read(core.LEDGER / "actions.jsonl")
            if r.get("action") == "reply" and int(r.get("ts") or 0) >= since]
    rows = rows[-max(1, min(int(num or 30), 200)):]
    return {"count": len(rows), "comments": [{k: r.get(k) for k in ("time", "bvid", "title", "rpid", "root", "text", "at") if r.get(k)}
                                             for r in reversed(rows)]}


# ---------------- 弹幕 ----------------

_DM_MODES = {"scroll": 1, "bottom": 4, "top": 5}


@bili_tool(cap="send_danmaku")
async def send_danmaku(bvid: str, text: str, at_sec: float, page: int = 1, mode: str = "scroll",
                       color: str = "ffffff") -> dict:
    msg = str(text or "").strip()
    if not msg or len(msg) > 100:
        raise BiliError(core.say("act.send_danmaku.1"))
    bv, cred, v, info = await _vid(bvid)
    from .viewing import _page_cid
    cid, dur = _page_cid(info, page)
    if dur and float(at_sec) > dur:
        raise BiliError(core.say("act.send_danmaku.2", a=core.fmt_dur(dur)))
    dm = Danmaku(text=msg, dm_time=float(at_sec), color=str(color or "ffffff").lstrip("#"),
                 mode=_DM_MODES.get(mode, 1))
    res = await v.send_danmaku(danmaku=dm, cid=cid)
    core.log_action("danmaku", True, bvid=bv, title=_title(info), at=core.fmt_dur(at_sec), text=msg)
    return {"bvid": bv, "at": core.fmt_dur(at_sec), "text": msg, "dmid": (res or {}).get("dmid_str") or (res or {}).get("dmid")}


TOOLS = [like, coin, triple, fav_folders, fav_create, favorite, fav_content, toview_add, toview_remove, toview_list,
         follow, reply, comment_like, comment_delete, comment_verify, my_comments, send_danmaku]
