"""找视频：搜索、首页推荐、热门、排行、每周必看、相关推荐、关注的人更新、UP 新片、多路选片、用户。

列表里每条视频都是同一个形状：
  {bvid, title, author, mid, duration(秒), dur("12:34"), pubdate("YYYY-MM-DD HH:MM"), play, danmaku, reply,
   like, reason(推荐理由，有才有), url, seen(看过才有)}
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import re
import time

from bilibili_api import Api, dynamic, hot, rank, search, user, video

from . import core, ledger
from .core import BiliError, bili_tool


def _num(x) -> int:
    return core.cn_num(x)


def norm_video(it: dict, source: str = "") -> dict | None:
    """把各种接口返回的视频条目统一成一个形状。"""
    if not isinstance(it, dict):
        return None
    bvid = it.get("bvid") or it.get("bv_id") or ""
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", str(bvid)):
        return None
    stat = it.get("stat") if isinstance(it.get("stat"), dict) else {}
    owner = it.get("owner") if isinstance(it.get("owner"), dict) else {}
    dur = it.get("duration")
    dur = core.parse_dur(dur if dur is not None else it.get("length"))
    pub = it.get("pubdate") or it.get("created") or it.get("ctime") or 0
    out = {
        "bvid": bvid,
        "title": core.cut(core.clean_html(it.get("title")), 120),
        "author": core.cut(owner.get("name") or it.get("author") or it.get("owner_name") or "", 40),
        "mid": owner.get("mid") or it.get("mid") or 0,
        "duration": dur,
        "dur": core.fmt_dur(dur),
        "pubdate": core.fmt_ts(pub),
        "play": _num(stat.get("view", it.get("play"))),
        "danmaku": _num(stat.get("danmaku", it.get("video_review", it.get("danmaku")))),
        "reply": _num(stat.get("reply", it.get("review", it.get("comment")))),
        "like": _num(stat.get("like", it.get("like"))),
        "url": core.video_url(bvid),
    }
    rr = it.get("rcmd_reason")
    reason = rr.get("content") if isinstance(rr, dict) else rr
    if reason:
        out["reason"] = core.cut(reason, 60)
    if source:
        out["source"] = source
    for k in ("play", "danmaku", "reply", "like", "mid"):
        if not out[k]:
            out.pop(k)
    return out


def _videos(items, source: str = "", limit: int = 50) -> list[dict]:
    seen, out = set(), []
    for it in items or []:
        v = norm_video(it, source)
        if v and v["bvid"] not in seen:
            seen.add(v["bvid"])
            out.append(v)
        if len(out) >= limit:
            break
    return ledger.annotate(out)


async def _resolve_uid(who) -> tuple[int, str]:
    """UID 或昵称 → (uid, 昵称)。昵称先精确匹配，没有就报错（别瞎猜人）。"""
    s = str(who or "").strip().lstrip("@")
    if not s:
        raise BiliError(core.say("discover._resolve_uid.1"), core.say("discover._resolve_uid.2"))
    if s.isdigit():
        return int(s), ""
    m = re.search(r"space\.bilibili\.com/(\d+)", s)
    if m:
        return int(m.group(1)), ""
    cache_f = core.DATA / "uid-cache.json"
    try:
        cache = json.loads(cache_f.read_text("utf-8"))
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(s)
    # 昵称会改、会被别人占用：缓存 3 天就重查（发私信/@/关注不能找错人）
    if isinstance(hit, dict) and time.time() - hit.get("ts", 0) < 3 * 86400:
        return int(hit["uid"]), s
    res = await search.search_by_type(s, search_type=search.SearchObjectType.USER, page=1)
    hits = res.get("result") or []
    exact = next((u for u in hits if str(u.get("uname")) == s), None)
    if not exact:
        names = core.say("listSep").join(str(u.get("uname")) for u in hits[:5])
        raise BiliError(core.say("discover._resolve_uid.3", a=s), core.say("discover._resolve_uid.4", a=names) if names else core.say("discover._resolve_uid.5"))
    cache = {k: v for k, v in cache.items() if isinstance(v, dict)}
    cache[s] = {"uid": int(exact["mid"]), "ts": int(time.time())}
    try:
        core.write_atomic(cache_f, json.dumps(cache, ensure_ascii=False))
    except OSError:
        pass
    return int(exact["mid"]), s


# ---------------- 搜索 ----------------

_ORDERS = {"totalrank": search.OrderVideo.TOTALRANK, "click": search.OrderVideo.CLICK,
           "pubdate": search.OrderVideo.PUBDATE, "dm": search.OrderVideo.DM, "stow": search.OrderVideo.STOW,
           "scores": search.OrderVideo.SCORES}
_DURS = {"any": -1, "short": 5, "mid": 20, "long": 45, "xlong": 90}    # 库按「分钟」分档：<10 / 10–30 / 30–60 / >60


@bili_tool()
async def search_videos(keyword: str, num: int = 20, order: str = "totalrank", page: int = 1,
                        days: int = 0, duration: str = "any") -> dict:
    kw = str(keyword or "").strip()
    if not kw:
        raise BiliError(core.say("discover.search_videos.1"))
    kwargs = dict(search_type=search.SearchObjectType.VIDEO, order_type=_ORDERS.get(order, search.OrderVideo.TOTALRANK),
                  page=max(1, int(page or 1)), time_range=_DURS.get(duration, -1))
    if days and int(days) > 0:
        start = dt.date.today() - dt.timedelta(days=int(days))
        end = dt.date.today() + dt.timedelta(days=1)          # time_end 是当天 0 点，不加一天就漏了今天发的
        kwargs.update(time_start=start.isoformat(), time_end=end.isoformat())
    res = await search.search_by_type(kw, **kwargs)
    vids = _videos(res.get("result"), "search", max(1, min(int(num or 20), 50)))
    return {"keyword": kw, "page": kwargs["page"], "total": res.get("numResults"), "count": len(vids), "videos": vids}


@bili_tool()
async def search_users(name: str, num: int = 8) -> dict:
    res = await search.search_by_type(str(name), search_type=search.SearchObjectType.USER, page=1)
    out = []
    for u in (res.get("result") or [])[: max(1, min(int(num or 8), 30))]:
        out.append({"uid": u.get("mid"), "name": u.get("uname"), "fans": u.get("fans"), "videos": u.get("videos"),
                    "level": u.get("level"), "sign": core.cut(u.get("usign"), 80),
                    "exact": str(u.get("uname")) == str(name)})
    out.sort(key=lambda x: not x["exact"])
    return {"count": len(out), "users": out}


# ---------------- 首页推荐 / 热门 / 排行 ----------------

_FEED_IDX = core.DATA / "feed-idx.json"


@bili_tool()
async def home_feed(num: int = 12) -> dict:
    cred = core.get_cred()
    try:
        idx = int(json.loads(_FEED_IDX.read_text("utf-8")).get("idx", 1)) + 1
    except (OSError, ValueError):
        idx = 1
    ps = max(1, min(int(num or 12), 30))
    params = {"fresh_type": 4, "ps": ps, "fresh_idx": idx, "fresh_idx_1h": idx, "brush": idx,
              "feed_version": "V8", "homepage_ver": 1, "web_location": 1430650, "y_num": 4}
    data = await Api(url="https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd", method="GET",
                     wbi=True, credential=cred).update_params(**params).result
    core.ensure_dirs()
    _FEED_IDX.write_text(json.dumps({"idx": idx}), "utf-8")
    items = [it for it in (data.get("item") or [])
             if it.get("goto") in (None, "", "av") and not it.get("is_ad") and not it.get("ad_info")
             and not it.get("business_info")]
    vids = _videos(items, "home", ps)
    return {"batch": idx, "count": len(vids), "videos": vids}


@bili_tool()
async def hot_videos(num: int = 20, page: int = 1) -> dict:
    res = await hot.get_hot_videos(pn=max(1, int(page or 1)), ps=max(1, min(int(num or 20), 50)))
    vids = _videos(res.get("list"), "hot", 50)
    return {"page": page, "count": len(vids), "videos": vids}


@bili_tool()
async def trending(num: int = 20) -> dict:
    res = await search.get_hot_search_keywords()
    words = []
    for x in (res.get("list") or res.get("trending", {}).get("list") or [])[: max(1, min(int(num or 20), 50))]:
        words.append({"rank": x.get("pos") or x.get("position"), "word": x.get("keyword") or x.get("show_name"),
                      "heat": x.get("heat_score") or x.get("hot_id")})
    return {"count": len(words), "words": words}


@bili_tool()
async def buzzwords(num: int = 20, page: int = 1) -> dict:
    res = await hot.get_hot_buzzwords(page_num=max(1, int(page or 1)), page_size=max(1, min(int(num or 20), 50)))
    words = [x.get("name") for x in (res or {}).get("buzzwords") or [] if x.get("name")]
    return {"total": ((res or {}).get("page") or {}).get("total"), "count": len(words), "words": words}


_RANKS = {"all": "All", "douga": "Douga", "guochuang": "Guochuang", "music": "Music", "dance": "Dance",
          "game": "Game", "knowledge": "Knowledge", "technology": "Technology", "sports": "Sports", "car": "Car",
          "life": "Life", "food": "Food", "animal": "Animal", "kichiku": "Kichiku", "fashion": "Fashion",
          "ent": "Ent", "cinephile": "Cinephile"}
# 番剧/影视这几个榜返回的是「剧集」（没有 BV 号），单独整理
_PGC_RANKS = {"anime": "Bangumi", "guochuang_anime": "GuochuangAnime", "movie": "Movie", "tv": "TV",
              "documentary": "Documentary", "variety": "Variety"}


@bili_tool()
async def ranking(category: str = "all", num: int = 30) -> dict:
    key = str(category or "all").lower()
    n = max(1, min(int(num or 30), 100))
    if key in _PGC_RANKS:
        res = await rank.get_rank(type_=getattr(rank.RankType, _PGC_RANKS[key]))
        shows = []
        for i, x in enumerate((res.get("list") or [])[:n], 1):
            ss = x.get("season_id")
            shows.append({k: v for k, v in {
                "rank": x.get("rank") or i, "title": x.get("title"), "season_id": ss, "rating": x.get("rating") or None,
                "play": (x.get("icon_font") or {}).get("text") or (x.get("stat") or {}).get("view"),
                "progress": (x.get("new_ep") or {}).get("index_show"), "badge": x.get("badge") or None,
                "url": x.get("url") or (f"https://www.bilibili.com/bangumi/play/ss{ss}" if ss else None)}.items() if v})
        return {"category": key, "kind": core.say("discover.ranking.1"), "count": len(shows), "shows": shows}
    if key not in _RANKS:
        raise BiliError(core.say("discover.ranking.2", a=category), core.say("discover.ranking.3") + " / ".join(_RANKS) + core.say("discover.ranking.4") + " / ".join(_PGC_RANKS))
    res = await rank.get_rank(type_=getattr(rank.RankType, _RANKS[key]))
    items = res.get("list") or []
    vids = _videos(items, "rank", n)
    for i, v in enumerate(vids, 1):
        v["rank"] = i
    return {"category": key, "count": len(vids), "videos": vids}


@bili_tool()
async def music_rank(week: int = 0, num: int = 30) -> dict:
    lst = await rank.get_music_rank_list()
    eps = []
    for yr, items in ((lst or {}).get("list") or {}).items():
        for e in items or []:
            eps.append({"id": e.get("ID"), "issue": e.get("priod"), "year": yr, "published": core.fmt_ts(e.get("publish_time"))})
    eps.sort(key=lambda e: -int(e["id"] or 0))
    if not eps:
        raise BiliError(core.say("discover.music_rank.1"))
    ep = eps[0] if int(week or 0) <= 0 else next((e for e in eps if e["id"] == int(week) or e["issue"] == int(week)), None)
    if not ep:
        raise BiliError(core.say("discover.music_rank.2", a=week), core.say("discover.music_rank.3"))
    res = await rank.get_music_rank_weekly_musics(week=int(ep["id"]))
    songs = []
    for x in ((res or {}).get("list") or [])[: max(1, min(int(num or 30), 100))]:
        row = {"rank": x.get("rank"), "last_rank": x.get("last_rank") or None, "title": x.get("music_title"),
               "singer": x.get("singer"), "heat": x.get("heat"), "achievements": x.get("achievements") or None}
        if x.get("creation_bvid"):
            row["video"] = {"bvid": x["creation_bvid"], "title": core.cut(x.get("creation_title"), 60),
                            "up": x.get("creation_nickname"), "play": x.get("creation_play"),
                            "url": core.video_url(x["creation_bvid"])}
        songs.append({k: v for k, v in row.items() if v is not None})
    return {"week": ep, "count": len(songs), "songs": songs, "recent_weeks": eps[:6]}


@bili_tool()
async def weekly(week: int = 0, num: int = 30) -> dict:
    if int(week or 0) <= 0:
        res = await hot.get_weekly_hot_videos_list()
        lst = (res.get("list") or [])[:8]
        return {"issues": [{"week": x.get("number"), "subject": x.get("subject"), "name": x.get("name")} for x in lst]}
    res = await hot.get_weekly_hot_videos(week=int(week))
    vids = _videos(res.get("list"), f"weekly{week}", max(1, min(int(num or 30), 60)))
    return {"week": week, "subject": (res.get("config") or {}).get("label"), "count": len(vids), "videos": vids}


@bili_tool()
async def related(bvid: str, num: int = 20) -> dict:
    bv = await core.resolve_bvid(bvid)
    res = await video.Video(bvid=bv, credential=core.get_cred(required=False)).get_related()
    vids = _videos(res if isinstance(res, list) else (res or {}).get("list"), "related", max(1, min(int(num or 20), 40)))
    return {"of": bv, "count": len(vids), "videos": vids}


# ---------------- 关注 / UP ----------------

@bili_tool()
async def following_feed(num: int = 20, videos_only: bool = True) -> dict:
    cred = core.get_cred()
    t = dynamic.DynamicType.VIDEO if videos_only else dynamic.DynamicType.ALL
    res = await dynamic.get_dynamic_page_info(credential=cred, _type=t)
    items = res.get("items") if isinstance(res, dict) else res
    out = []
    for it in items or []:
        mods = it.get("modules") or {}
        au = mods.get("module_author") or {}
        dyn = mods.get("module_dynamic") or {}
        major = dyn.get("major") or {}
        arc = major.get("archive")
        row = {"author": au.get("name"), "mid": au.get("mid"), "time": core.fmt_ts(au.get("pub_ts")),
               "id": it.get("id_str")}
        if arc:
            row.update({"bvid": arc.get("bvid"), "title": arc.get("title"), "dur": arc.get("duration_text"),
                        "duration": core.parse_dur(arc.get("duration_text")),
                        "play": _num((arc.get("stat") or {}).get("play")), "pubdate": row["time"],
                        "url": core.video_url(arc.get("bvid", ""))})
        else:
            desc = (dyn.get("desc") or {}).get("text") or ((major.get("opus") or {}).get("summary") or {}).get("text")
            row.update({"type": it.get("type"), "text": core.cut(desc, 200)})
        out.append(row)
        if len(out) >= max(1, min(int(num or 20), 50)):
            break
    ledger.annotate([r for r in out if r.get("bvid")])
    return {"count": len(out), "items": out}


@bili_tool()
async def up_videos(who: str, num: int = 20, page: int = 1, order: str = "pubdate", keyword: str = "") -> dict:
    uid, name = await _resolve_uid(who)
    om = {"pubdate": user.VideoOrder.PUBDATE, "click": user.VideoOrder.VIEW, "stow": user.VideoOrder.FAVORITE}
    res = await user.User(uid, credential=core.get_cred(required=False)).get_videos(
        pn=max(1, int(page or 1)), ps=max(1, min(int(num or 20), 50)), order=om.get(order, user.VideoOrder.PUBDATE),
        keyword=keyword or "")
    vl = (res.get("list") or {}).get("vlist") or []
    vids = _videos(vl, f"up:{uid}", 50)
    return {"uid": uid, "name": name or (vl[0].get("author") if vl else ""), "total": (res.get("page") or {}).get("count"),
            "count": len(vids), "videos": vids}


@bili_tool()
async def up_feed(ups: list[str], days: int = 7, limit: int = 30) -> dict:
    since = time.time() - max(1, min(int(days or 7), 90)) * 86400
    out, resolved, errors = [], [], []
    cred = core.get_cred(required=False)
    for who in (ups or [])[:20]:
        try:
            uid, name = await _resolve_uid(who)
            res = await user.User(uid, credential=cred).get_videos(pn=1, ps=30, order=user.VideoOrder.PUBDATE)
            vl = (res.get("list") or {}).get("vlist") or []
            resolved.append({"up": name or (vl[0].get("author") if vl else str(uid)), "uid": uid})
            for it in vl:
                if int(it.get("created") or 0) >= since:
                    out.append(it)
            await asyncio.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{who}: {core.note_error(e)}")      # 撞风控就整个停（note_error 会往外抛）
    out.sort(key=lambda x: -int(x.get("created") or 0))
    vids = _videos(out, "up_feed", max(1, min(int(limit or 30), 60)))
    return {"days": days, "ups": resolved, "count": len(vids), "videos": vids, "errors": errors}


@bili_tool()
async def user_info(who: str) -> dict:
    uid, _ = await _resolve_uid(who)
    cred = core.get_cred(required=False)
    u = user.User(uid, credential=cred)
    info = await u.get_user_info()
    out = {"uid": uid, "name": info.get("name"), "sign": core.cut(info.get("sign"), 200), "level": info.get("level"),
           "official": (info.get("official") or {}).get("title") or None,
           "space": f"https://space.bilibili.com/{uid}"}
    try:
        rel = await u.get_relation_info()
        out.update(fans=rel.get("follower"), following=rel.get("following"))
    except Exception as e:  # noqa: BLE001
        core.note_error(e)
    try:
        st = await u.get_up_stat()
        out.update(likes=st.get("likes"), views=(st.get("archive") or {}).get("view"))
    except Exception as e:  # noqa: BLE001
        core.note_error(e)
    if cred:
        try:
            r = await u.get_relation()
            attr = ((r or {}).get("relation") or {}).get("attribute", 0)
            out["i_follow"] = attr in (2, 6)
        except Exception as e:  # noqa: BLE001
            core.note_error(e)
    return {k: v for k, v in out.items() if v is not None}


@bili_tool()
async def my_history(num: int = 20) -> dict:
    res = await user.get_self_history_new(credential=core.get_cred(), ps=max(1, min(int(num or 20), 30)))
    out = []
    for it in res.get("list") or []:
        h = it.get("history") or {}
        bv = h.get("bvid")
        row = {"title": it.get("title"), "author": it.get("author_name"), "viewed": core.fmt_ts(it.get("view_at")),
               "progress": core.fmt_dur(it.get("progress")) if it.get("progress", -1) >= 0 else core.say("discover.row.1"),
               "dur": core.fmt_dur(it.get("duration"))}
        if bv:
            row.update(bvid=bv, url=core.video_url(bv))
        out.append(row)
    return {"count": len(out), "items": out}


# ---------------- 多路选片 ----------------

@bili_tool()
async def scout(keywords: list[str] | None = None, ups: list[str] | None = None, home: bool = True,
                hot: bool = True, following: bool = True, days: int = 7, limit: int = 20,
                include_seen: bool = False) -> dict:
    start = time.monotonic()
    budget = 40.0
    sem = asyncio.Semaphore(3)              # 并发再高容易吃 -412
    cand: dict[str, dict] = {}
    errors: list[str] = []

    def add(vs: list[dict], src: str):
        for v in vs:
            c = cand.get(v["bvid"])
            if c:
                c["sources"].append(src)
            else:
                cand[v["bvid"]] = {**v, "sources": [src]}

    async def run(label: str, coro):
        if time.monotonic() - start > budget:
            coro.close()
            return
        async with sem:
            try:
                r = await asyncio.wait_for(coro, max(1.0, budget - (time.monotonic() - start)))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{label}: {core.explain_exc(e)[0]}")
                return
        if isinstance(r, dict) and r.get("ok") is False:
            errors.append(f"{label}: {r.get('error')}")
            return
        add((r or {}).get("videos") or [v for v in (r or {}).get("items", []) if v.get("bvid")], label)

    tasks = []
    if home:
        tasks.append(run("home", home_feed(num=20)))
    if hot:
        tasks.append(run("hot", hot_videos(num=30)))
    if following:
        tasks.append(run("following", following_feed(num=20)))
    for kw in (keywords or [])[:6]:
        tasks.append(run(f"kw:{kw}", search_videos(kw, num=20, order="pubdate" if days else "totalrank", days=days)))
    if ups:
        tasks.append(run("ups", up_feed(list(ups), days=days or 7, limit=40)))
    await asyncio.gather(*tasks)

    now = time.time()
    items = list(cand.values())
    if not include_seen:
        items = [v for v in items if not v.get("seen")]

    def score(v: dict) -> float:
        s = 10.0 * (len(set(v["sources"])) - 1)
        try:
            age_d = (now - time.mktime(time.strptime(v.get("pubdate", ""), "%Y-%m-%d %H:%M"))) / 86400
            s += max(0.0, 7 - age_d)
        except ValueError:
            pass
        s += min(8.0, _num(v.get("play")) ** 0.25 / 4)
        if any(x.startswith("up") for x in v["sources"]):
            s += 6
        if "following" in v["sources"]:
            s += 4
        return s

    items.sort(key=score, reverse=True)
    n = max(1, min(int(limit or 20), 60))
    return {"count": min(n, len(items)), "pool": len(cand), "videos": items[:n], "errors": errors,
            "took_sec": round(time.monotonic() - start, 1)}


ZONES = {
    "动画": {1: "动画(总)", 24: "MAD·AMV", 25: "MMD·3D", 47: "短片·手书", 27: "综合", 210: "手办·模玩"},
    "番剧/国创": {13: "番剧", 167: "国创"},
    "音乐": {3: "音乐(总)", 28: "原创音乐", 31: "翻唱", 59: "演奏", 193: "MV", 130: "音乐综合"},
    "舞蹈": {129: "舞蹈(总)", 20: "宅舞"},
    "游戏": {4: "游戏(总)", 17: "单机游戏", 171: "电子竞技", 172: "手机游戏", 65: "网络游戏"},
    "知识": {36: "知识(总)", 201: "科学科普", 124: "社科·法律·心理", 228: "人文历史", 207: "财经商业"},
    "科技": {188: "科技(总)", 95: "数码", 230: "软件应用", 231: "计算机技术"},
    "生活": {160: "生活(总)", 138: "搞笑", 21: "日常", 76: "美食制作"},
    "鬼畜": {119: "鬼畜(总)", 22: "鬼畜调教", 26: "音MAD"},
    "影视": {181: "影视(总)", 182: "影视杂谈", 183: "影视剪辑", 85: "小剧场"},
    "娱乐": {5: "娱乐(总)", 71: "综艺", 241: "娱乐杂谈"},
}


@bili_tool(network=False)
async def zones() -> dict:
    return {"zones": ZONES}


TOOLS = [search_videos, search_users, home_feed, hot_videos, trending, buzzwords, ranking, music_rank, weekly, related,
         following_feed, up_videos, up_feed, user_info, my_history, scout, zones]
