"""看视频：信息、字幕（防串台）、弹幕（高能时刻）、评论、封面、画面帧（拼图）、转写、AI 总结、一次看全。

图片（封面/画面）存成文件放在 memory/videos/<BV>/（和 scripts/watch.py 同一个地方），返回路径——
code mode 里图片过不了桥，要用 view_image 打开那张图才算真看见。
"""
from __future__ import annotations

import asyncio
import base64
import collections
import io
import json
import os
import re
import subprocess
import sys
import time
import zlib

import aiohttp
from bilibili_api import comment, video

from . import core, ledger
from .core import BiliError, bili_tool

sys.path.insert(0, str(core.ROOT / "server" / "vendor"))
from bilibili_mcp import mcp_server as upstream  # noqa: E402  上游 MCP（MIT），复用它的故事板/封面辅助函数

_IMG_HEADERS = {"User-Agent": core.UA, "Referer": "https://www.bilibili.com/"}   # 图床不需要也不发 Cookie


def _vdir(bvid: str):
    d = core.VIDEOS / bvid
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _info(bvid: str, cred=None) -> dict:
    v = video.Video(bvid=bvid, credential=cred if cred is not None else core.get_cred(required=False))
    return await v.get_info()


def _page_cid(info: dict, page: int) -> tuple[int, float]:
    pages = info.get("pages") or []
    p = max(1, int(page or 1))
    if pages and p <= len(pages):
        return int(pages[p - 1]["cid"]), float(pages[p - 1].get("duration") or info.get("duration") or 0)
    if p > 1 and pages:
        raise BiliError(core.say("viewing._page_cid.1", a=len(pages)), "")
    return int(info.get("cid") or 0), float(info.get("duration") or 0)


def _brief(info: dict) -> dict:
    st = info.get("stat") or {}
    own = info.get("owner") or {}
    return {
        "bvid": info.get("bvid"), "title": info.get("title"), "author": own.get("name"), "mid": own.get("mid"),
        "pubdate": core.fmt_ts(info.get("pubdate")), "duration": info.get("duration"),
        "dur": core.fmt_dur(info.get("duration")), "pages": len(info.get("pages") or []) or 1,
        "zone": info.get("tname") or info.get("tname_v2") or info.get("tid"), "desc": core.cut(info.get("desc"), 400),
        "stat": {k: st.get(k, 0) for k in ("view", "like", "coin", "favorite", "share", "reply", "danmaku")},
        "url": core.video_url(info.get("bvid", "")),
    }


@bili_tool()
async def video_info(bvid: str) -> dict:
    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred(required=False)
    v = video.Video(bvid=bv, credential=cred)
    info = await v.get_info()
    out = _brief(info)
    try:
        tags = await v.get_tags()
        out["tags"] = [t.get("tag_name") for t in tags if t.get("tag_name")][:12]
    except Exception as e:  # noqa: BLE001
        core.note_error(e)
    if cred:
        try:
            rel = await v.get_relation()
            out["me"] = {"liked": bool(rel.get("like")), "coins": rel.get("coin", 0), "favorited": bool(rel.get("favorite")),
                         "following_up": bool(rel.get("attention"))}
        except Exception as e:  # noqa: BLE001
            core.note_error(e)
    return out


def _subtitle_belongs(url: str, aid: int, cid: int) -> bool | None:
    """AI 字幕的地址形如 …/ai_subtitle/prod/<aid><cid><hash>?auth_key=…；对不上就是串到别的视频了。
    不是 AI 字幕（UP 主自己传的）地址里没有这串，返回 None（不判）。"""
    m = re.search(r"/ai_subtitle/prod/(\d+)", url or "")
    if not m:
        return None
    return m.group(1).startswith(f"{aid}{cid}")


async def _fetch_subtitle(bvid: str, page: int = 1) -> dict:
    cred = core.get_cred()          # 不登录经常拿到别的视频的 AI 字幕，干脆要求登录
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = int(info["aid"])
    cid, dur = _page_cid(info, page)
    tried = []
    for attempt in range(2):
        sl = await v.get_subtitle(cid=cid) or {}
        subs = [x for x in (sl.get("subtitles") or []) if x.get("subtitle_url")]
        if not subs:
            return {"info": info, "has": False, "reason": core.say("viewing._fetch_subtitle.1")}
        # 中文优先；同是中文，UP 主上传的优先于 AI 生成的
        def rank_(s):
            code = str(s.get("lan") or "")   # Bilibili's field for the subtitle's language: ai-zh, zh-CN, en-US…
            human = 0 if not code.startswith("ai-") else 1
            zh = 0 if "zh" in code else 1
            return (zh, human)
        subs.sort(key=rank_)
        for s in subs:
            url = str(s.get("subtitle_url") or "")
            url = "https:" + url if url.startswith("//") else url
            belongs = _subtitle_belongs(url, aid, cid)
            if belongs is False:
                tried.append(core.say("viewing._fetch_subtitle.2", a=s.get('lan')))
                continue
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as ss:
                async with ss.get(url, headers=_IMG_HEADERS) as r:
                    data = await r.json(content_type=None)
            body = [b for b in (data.get("body") or []) if str(b.get("content") or "").strip()]
            last = float(body[-1].get("to") or 0) if body else 0.0
            if dur and last > dur * 1.15 + 10:
                tried.append(core.say("viewing._fetch_subtitle.3", a=s.get('lan'), b=core.fmt_dur(last), c=core.fmt_dur(dur)))
                continue
            return {"info": info, "has": True, "lan": s.get("lan"), "lan_doc": s.get("lan_doc"),
                    "kind": core.say("viewing._fetch_subtitle.4") if str(s.get("lan", "")).startswith("ai-") else core.say("viewing._fetch_subtitle.5"),
                    "body": body, "dur": dur, "checked": belongs is True}
        await asyncio.sleep(1.0)
    return {"info": info, "has": False, "reason": core.say("viewing._fetch_subtitle.6"), "tried": tried}


def _join_body(body: list[dict], with_time: bool, max_chars: int) -> tuple[str, bool]:
    lines = []
    for b in body:
        t = str(b.get("content") or "").strip()
        lines.append(f"[{core.fmt_dur(b.get('from'))}] {t}" if with_time else t)
    text = "\n".join(lines)
    if max_chars and len(text) > max_chars:
        return text[:max_chars] + core.say("viewing._join_body.1", a=len(text)), True
    return text, False


@bili_tool()
async def subtitle(bvid: str, page: int = 1, with_time: bool = False, max_chars: int = 12000,
                   offset_chars: int = 0) -> dict:
    return await _subtitle_impl(bvid, page, with_time, max_chars, offset_chars, touch=True)


async def _subtitle_impl(bvid, page=1, with_time=False, max_chars=12000, offset_chars=0, touch=True) -> dict:
    bv = await core.resolve_bvid(bvid)
    r = await _fetch_subtitle(bv, page)
    info = r["info"]
    if touch:
        ledger.touch(bv, info.get("title", ""), (info.get("owner") or {}).get("name", ""), "subtitle")
    if not r["has"]:
        out = {"bvid": bv, "title": info.get("title"), "has_subtitle": False, "reason": r["reason"],
               "dur": core.fmt_dur(info.get("duration"))}
        if r.get("tried"):
            out["tried"] = r["tried"]
        return out
    text, _ = _join_body(r["body"], with_time, 0)
    off = max(0, int(offset_chars or 0))
    chunk = text[off:]
    n = int(max_chars or 0)
    truncated = bool(n and len(chunk) > n)
    if truncated:
        chunk = chunk[:n]
    voice = len(text.strip()) > 40 or not re.fullmatch(r"\s*字幕\s*by.*", text.strip(), re.I)
    out = {"bvid": bv, "title": info.get("title"), "has_subtitle": True, "kind": r["kind"], "lang": r["lan_doc"],
           "verified_same_video": r["checked"], "segments": len(r["body"]), "total_chars": len(text),
           "dur": core.fmt_dur(r["dur"]), "text": chunk}
    if truncated:
        out["next_offset"] = off + n
    if not voice:
        out["note"] = core.say("viewing._subtitle_impl.1")
    return out


# ---------------- 弹幕 ----------------

def _parse_dm_xml(xml: str) -> list[tuple[float, str]]:
    out = []
    for m in re.finditer(r'<d p="([^"]+)">(.*?)</d>', xml, re.S):
        try:
            t = float(m.group(1).split(",")[0])
        except ValueError:
            continue
        txt = (m.group(2).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
               .replace("&quot;", '"').replace("&apos;", "'").strip())
        if txt:
            out.append((t, txt))
    out.sort()
    return out


async def _danmaku_xml(cid: int) -> str:
    url = f"https://comment.bilibili.com/{cid}.xml"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as s:
        async with s.get(url, headers=_IMG_HEADERS) as r:
            raw = await r.read()
    for wbits in (-15, 15, 31):
        try:
            return zlib.decompress(raw, wbits).decode("utf-8", "replace")
        except zlib.error:
            continue
    return raw.decode("utf-8", "replace")


def _norm_dm(t: str) -> str:
    t = re.sub(r"(.)\1{3,}", r"\1\1\1", t.strip())        # 哈哈哈哈哈哈 → 哈哈哈
    return t.lower()


def dm_digest(dms: list[tuple[float, str]], dur: float, top: int = 15, moments: int = 6, window: int = 10) -> dict:
    cnt = collections.Counter(_norm_dm(t) for _, t in dms)
    phrases = [{"text": k, "n": v} for k, v in cnt.most_common(top) if v >= 2]
    buckets: dict[int, list[str]] = collections.defaultdict(list)
    for t, txt in dms:
        buckets[int(t // window)].append(txt)
    avg = (len(dms) / max(1, len(buckets))) if buckets else 0
    peaks = sorted(buckets.items(), key=lambda kv: -len(kv[1]))[:moments]
    hot = []
    for b, txts in sorted(peaks):
        common = [k for k, _ in collections.Counter(_norm_dm(x) for x in txts).most_common(4)]
        hot.append({"at": core.fmt_dur(b * window), "at_sec": b * window, "n": len(txts),
                    "x_avg": round(len(txts) / avg, 1) if avg else None, "sample": common})
    return {"phrases": phrases, "moments": hot}


@bili_tool()
async def danmaku(bvid: str, page: int = 1, sample: int = 40) -> dict:
    bv = await core.resolve_bvid(bvid)
    info = await _info(bv)
    cid, dur = _page_cid(info, page)
    dms = _parse_dm_xml(await _danmaku_xml(cid))
    dig = dm_digest(dms, dur)
    n = max(0, min(int(sample or 0), 200))
    step = max(1, len(dms) // n) if n and dms else 1
    samp = [f"[{core.fmt_dur(t)}] {core.cut(x, 60)}" for t, x in dms[::step][:n]] if n else []
    return {"bvid": bv, "title": info.get("title"), "total": len(dms),
            "note": core.say("viewing.danmaku.1"), **dig, "sample": samp}


# ---------------- 评论 ----------------

def _norm_reply(r: dict, subs: int = 2) -> dict:
    m = r.get("member") or {}
    c = r.get("content") or {}
    row = {"rpid": r.get("rpid"), "user": m.get("uname"), "mid": int(m.get("mid") or 0),
           "text": core.cut(c.get("message"), 400), "like": r.get("like", 0), "replies": r.get("rcount", 0),
           "time": core.fmt_ts(r.get("ctime"))}
    if (r.get("up_action") or {}).get("like"):
        row["up_liked"] = True
    if r.get("root") and r.get("root") != r.get("rpid"):
        row["root"] = r.get("root")
    pics = c.get("pictures") or []
    if pics:
        row["pictures"] = len(pics)
    if subs:
        sr = [{"rpid": s.get("rpid"), "user": (s.get("member") or {}).get("uname"),
               "text": core.cut((s.get("content") or {}).get("message"), 200), "like": s.get("like", 0)}
              for s in (r.get("replies") or [])[:subs]]
        if sr:
            row["top_replies"] = sr
    return row


@bili_tool()
async def comments(bvid: str, num: int = 20, order: str = "hot", page: int = 1) -> dict:
    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred(required=False)
    info = await _info(bv, cred)
    aid = int(info["aid"])
    od = comment.OrderType.LIKE if order != "time" else comment.OrderType.TIME
    want = max(1, min(int(num or 20), 100))
    out, top, pg = [], None, max(1, int(page or 1))
    while len(out) < want:
        res = await comment.get_comments(oid=aid, type_=comment.CommentResourceType.VIDEO, page_index=pg,
                                         order=od, credential=cred)
        if top is None:
            t = (res.get("upper") or {}).get("top") or (res.get("top") or {}).get("upper")
            top = _norm_reply(t) if t else False
        reps = res.get("replies") or []
        if not reps:
            break
        out.extend(_norm_reply(r) for r in reps)
        pg += 1
        if len(reps) < 10:
            break
        await asyncio.sleep(0.4)
    total = ((res.get("page") or {}).get("count")) if isinstance(res, dict) else None
    return {"bvid": bv, "title": info.get("title"), "total": total, "top": top or None,
            "count": len(out[:want]), "comments": out[:want], "next_page": pg}


@bili_tool()
async def comment_thread(bvid: str, root: int, num: int = 20, page: int = 1) -> dict:
    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred(required=False)
    info = await _info(bv, cred)
    c = comment.Comment(oid=int(info["aid"]), type_=comment.CommentResourceType.VIDEO, rpid=int(root), credential=cred)
    res = await c.get_sub_comments(page_index=max(1, int(page or 1)), page_size=max(1, min(int(num or 20), 20)))
    reps = [_norm_reply(r, subs=0) for r in (res.get("replies") or [])]
    root_c = res.get("root")
    return {"bvid": bv, "root": _norm_reply(root_c, subs=0) if root_c else {"rpid": root},
            "total": (res.get("page") or {}).get("count"), "count": len(reps), "replies": reps}


# ---------------- 封面 / 画面 ----------------

async def _get_bytes(url: str) -> bytes:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25)) as s:
        async with s.get(upstream._https(url), headers=_IMG_HEADERS) as r:
            if r.status != 200:
                raise BiliError(core.say("viewing._get_bytes.1", a=r.status))
            data = await r.read()
    if len(data) > 8_000_000:
        raise BiliError(core.say("viewing._get_bytes.2"))
    return data


@bili_tool()
async def cover(bvid: str) -> dict:
    bv = await core.resolve_bvid(bvid)
    info = await _info(bv)
    pic = info.get("pic")
    if not pic:
        raise BiliError(core.say("viewing.cover.1"))
    data = await _get_bytes(upstream._cover_url(pic))
    path = _vdir(bv) / "cover.jpg"
    path.write_bytes(data)
    return {"bvid": bv, "title": info.get("title"), "image": str(path), "kb": round(len(data) / 1024, 1),
            "next": core.say("viewing.cover.2")}


def _label(img, text: str):
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    w = 8 * len(text) + 10
    d.rectangle([0, 0, w, 18], fill=(0, 0, 0))
    d.text((5, 3), text, fill=(255, 255, 0))


@bili_tool()
async def frames(bvid: str, num: int = 6, at: list[float] | None = None, page: int = 1) -> dict:
    from PIL import Image

    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred(required=False)
    v = video.Video(bvid=bv, credential=cred)
    info = await v.get_info()
    cid, covered = _page_cid(info, page)
    snap, entries = {}, []
    for attempt in range(2):
        snap = await v.get_video_snapshot(cid=cid, json_index=True, pvideo=False) or {}
        entries = upstream._snapshot_entries(snap, covered)
        if not entries:
            entries = await upstream._entries_from_pvdata(snap)
        if entries and snap.get("image"):
            break
        await asyncio.sleep(1.0)
    sheets = snap.get("image") or []
    if not entries or not sheets:
        raise BiliError(core.say("viewing.frames.1"), core.say("viewing.frames.2"))
    story_max = max(e[0] for e in entries)
    if story_max > 0:
        covered = min(covered, story_max) if covered else story_max
    if at:
        targets = [min(max(0.0, float(t)), max(0.0, covered - 0.1)) for t in at][:12]
    else:
        n = max(1, min(int(num or 6), 12))
        targets = [covered * (i + 1) / (n + 1) for i in range(n)]
    tw = int(snap.get("img_x_size") or 480)
    th = int(snap.get("img_y_size") or 270)
    cache: dict[int, bytes] = {}
    first = await _get_bytes(str(sheets[0]))
    cache[0] = first
    im0 = Image.open(io.BytesIO(first))
    cap = max(1, (im0.width // tw) * (im0.height // th))
    tiles, meta, failed = [], [], []
    for want in targets:
        got, tile = min(entries, key=lambda e: abs(e[0] - want))
        sheet_no, pos = tile // cap, tile % cap
        try:
            if sheet_no not in cache:
                if sheet_no >= len(sheets):
                    raise BiliError(core.say("viewing.frames.3"))
                cache[sheet_no] = await _get_bytes(str(sheets[sheet_no]))
            img = Image.open(io.BytesIO(upstream._crop_tile(cache[sheet_no], pos, tw, th)))
            _label(img, core.fmt_dur(got))
            tiles.append(img)
            meta.append({"want": core.fmt_dur(want), "got": core.fmt_dur(got), "got_sec": round(got, 1)})
        except Exception as e:  # noqa: BLE001
            failed.append({"want": core.fmt_dur(want), "error": core.explain_exc(e)[0]})
    if not tiles:
        raise BiliError(core.say("viewing.frames.4"), str(failed[:2]))
    cols = 1 if len(tiles) == 1 else 2 if len(tiles) <= 4 else 3
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th), (20, 20, 20))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * tw, (i // cols) * th))
    tag = "at" if at else f"n{len(tiles)}"
    vd = _vdir(bv)
    path = vd / f"frames-{tag}-{int(time.time())}.jpg"
    sheet.save(path, "JPEG", quality=82)
    for old in sorted(vd.glob("frames-*.jpg"), key=lambda q: q.stat().st_mtime)[:-6]:   # 每条视频只留最近 6 张
        old.unlink(missing_ok=True)
    ledger.touch(bv, info.get("title", ""), (info.get("owner") or {}).get("name", ""), "frames")
    return {"bvid": bv, "title": info.get("title"), "sheet": str(path), "frames": meta, "failed": failed,
            "covered": core.fmt_dur(covered), "next": core.say("viewing.frames.5")}


# ---------------- 转写（没字幕时） ----------------

JOBS = core.DATA / "jobs"


def _job_file(bvid: str, page: int):
    return JOBS / f"transcribe-{bvid}-p{page}.json"


def _transcript_path(bvid: str, page: int):
    return _vdir(bvid) / ("transcript.txt" if page == 1 else f"transcript-p{page}.txt")


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _job_state(jf) -> dict:
    try:
        st = json.loads(jf.read_text("utf-8") or "{}")
    except (OSError, ValueError):
        return {}
    if st.get("status") == "running":
        dead = (st.get("pid") and not _pid_alive(st["pid"])) or (not st.get("pid") and time.time() - st.get("ts", 0) > 120)
        if dead:
            st = {**st, "status": "failed", "error": core.say("viewing.st.1")}
    return st


@bili_tool()
async def transcribe(bvid: str, page: int = 1, minutes: int = 15, model: str = "base") -> dict:
    bv = await core.resolve_bvid(bvid)
    page = max(1, int(page or 1))
    minutes = max(1, min(int(minutes or 15), 90))
    model = model if model in ("base", "small", "tiny") else "base"
    tp = _transcript_path(bv, page)
    if tp.exists() and tp.stat().st_size > 0:
        return await _transcript_result(bv, page, 12000)
    jf = _job_file(bv, page)
    st = _job_state(jf)
    if st.get("status") == "running":
        return {"bvid": bv, "status": "running", "step": st.get("step"), "since": core.fmt_ts(st.get("ts")),
                "next": core.say("viewing.transcribe.1")}
    gate = core.WS / "scripts" / "load.py"
    if gate.exists():
        proc = await asyncio.create_subprocess_exec("/opt/homebrew/bin/python3", str(gate), "gate", "heavy",
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out_b, err_b = await asyncio.wait_for(proc.communicate(), 30)
        except asyncio.TimeoutError:
            proc.kill()
            raise BiliError(core.say("viewing.transcribe.2"), core.say("viewing.transcribe.3"))
        if proc.returncode != 0:
            raise BiliError(core.say("viewing.transcribe.4"), core.cut((out_b or err_b).decode("utf-8", "replace").strip(), 200))
    JOBS.mkdir(parents=True, exist_ok=True)
    job = core.ROOT / "server" / "transcribe_job.py"
    core.write_atomic(jf, json.dumps({"status": "running", "step": core.say("viewing.transcribe.5"), "ts": core.now_ts()}))   # 子进程之后自己写带 pid 的状态
    with open(JOBS / f"{bv}-p{page}.log", "w") as logf:
        subprocess.Popen([sys.executable, "-E", "-s", str(job), bv, str(page), str(minutes), model, str(jf), str(tp)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=logf,
                         start_new_session=True, cwd=str(core.ROOT / "server"))
    return {"bvid": bv, "status": "started", "minutes": minutes, "model": model,
            "next": core.say("viewing.transcribe.6")}


async def _transcript_result(bv: str, page: int, max_chars: int) -> dict:
    tp = _transcript_path(bv, page)
    text = tp.read_text("utf-8", errors="replace").strip()
    out = {"bvid": bv, "status": "done", "file": str(tp), "total_chars": len(text)}
    if not text or (len(text) <= 40 and re.search(r"字幕\s*by", text, re.I)):
        out.update(text="", note=core.say("viewing._transcript_result.1"))
        return out
    out["text"] = text[: max_chars] if max_chars else text
    if max_chars and len(text) > max_chars:
        out["truncated"] = True
    return out


@bili_tool(network=False)
async def transcribe_status(bvid: str, page: int = 1, max_chars: int = 12000) -> dict:
    bv = await core.resolve_bvid(bvid)
    page = max(1, int(page or 1))
    if _transcript_path(bv, page).exists():
        return await _transcript_result(bv, page, max_chars)
    jf = _job_file(bv, page)
    if not jf.exists():
        return {"bvid": bv, "status": "none", "next": core.say("viewing.transcribe_status.1")}
    st = _job_state(jf)
    st.pop("pid", None)
    st["bvid"] = bv
    if st.get("status") == "running":
        st["since"] = core.fmt_ts(st.get("ts"))
    return st


# ---------------- AI 总结 ----------------

@bili_tool()
async def ai_summary(bvid: str, page: int = 1) -> dict:
    bv = await core.resolve_bvid(bvid)
    cred = core.get_cred()
    v = video.Video(bvid=bv, credential=cred)
    info = await v.get_info()
    cid, _ = _page_cid(info, page)
    res = await v.get_ai_conclusion(cid=cid, up_mid=(info.get("owner") or {}).get("mid"))
    mr = (res or {}).get("model_result") or {}
    if not mr.get("summary") and not mr.get("outline"):
        return {"bvid": bv, "has_summary": False, "reason": core.say("viewing.ai_summary.1")}
    outline = []
    for sec in mr.get("outline") or []:
        outline.append({"at": core.fmt_dur(sec.get("timestamp")), "title": sec.get("title"),
                        "points": [core.cut(p.get("content"), 80) for p in (sec.get("part_outline") or [])][:4]})
    return {"bvid": bv, "title": info.get("title"), "has_summary": True, "summary": mr.get("summary"), "outline": outline}


# ---------------- 一次看全 ----------------

@bili_tool()
async def watch(bvid: str, subtitle_chars: int = 8000, comments_num: int = 8, frames_num: int = 0) -> dict:
    bv = await core.resolve_bvid(bvid)
    out: dict = {"bvid": bv}
    info_r = await video_info(bv)
    if not info_r.get("ok"):
        return info_r
    out["info"] = {k: v for k, v in info_r.items() if k != "ok"}
    sub = await subtitle(bv, max_chars=subtitle_chars)
    out["subtitle"] = {k: v for k, v in sub.items() if k not in ("ok", "bvid", "title")}
    dm = await danmaku(bv, sample=0)
    if dm.get("ok"):
        out["danmaku"] = {"total": dm.get("total"), "phrases": dm.get("phrases", [])[:10], "moments": dm.get("moments")}
    else:
        out["danmaku"] = {"error": dm.get("error")}
    if comments_num:
        cm = await comments(bv, num=comments_num)
        if cm.get("ok"):
            out["comments"] = {"total": cm.get("total"), "top": cm.get("top"),
                               "hot": [{k: c.get(k) for k in ("rpid", "user", "text", "like", "replies", "up_liked") if c.get(k)}
                                       for c in cm.get("comments", [])]}
        else:
            out["comments"] = {"error": cm.get("error")}
    if frames_num:
        fr = await frames(bv, num=frames_num)
        out["frames"] = {k: fr.get(k) for k in ("sheet", "frames", "error", "next") if fr.get(k)}
    ledger.touch(bv, out["info"].get("title", ""), out["info"].get("author", ""), "watch")
    return out


@bili_tool()
async def crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 10, with_subtitles: bool = True) -> dict:
    from .discover import search_videos
    sr = await search_videos(keyword, num=max(1, min(int(max_videos or 5), 10)))
    if not sr.get("ok"):
        return sr
    out = []
    for v in sr["videos"]:
        row = {"video": v}
        cm = await comments(v["bvid"], num=comments_per_video)
        row["comments"] = [{k: c.get(k) for k in ("user", "text", "like")} for c in cm.get("comments", [])] if cm.get("ok") else cm.get("error")
        if with_subtitles:
            try:
                sb = await _subtitle_impl(v["bvid"], max_chars=3000, touch=False)     # 调研不算「看过」
            except Exception as e:  # noqa: BLE001
                sb = {"error": core.note_error(e)}
            row["subtitle"] = sb.get("text") if sb.get("has_subtitle") else (sb.get("reason") or sb.get("error"))
        out.append(row)
        await asyncio.sleep(0.8)
    return {"keyword": keyword, "count": len(out), "results": out}


TOOLS = [video_info, subtitle, danmaku, comments, comment_thread, cover, frames, transcribe, transcribe_status,
         ai_summary, watch, crawl]
