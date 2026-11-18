#!/usr/bin/env python3
"""表情包库管理脚本。

库目录：<工作区>/stickers/（模块配置 library 可以换）
  index.json      每张表情的描述、情绪、标签、使用记录
  img/            已收藏的图片
  inbox/          刚下载、还没决定要不要收藏的候选
  trash/          删除的表情（可恢复）

所有输出都是 JSON，方便 agent 读取。
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from hh_env import hh, words

say = words(__file__)

ROOT = os.path.join(hh.workspace, hh.config.get("library", "stickers"))
IMG = os.path.join(ROOT, "img")
INBOX = os.path.join(ROOT, "inbox")
TRASH = os.path.join(ROOT, "trash")
INDEX = os.path.join(ROOT, "index.json")

NEKOS = "https://nekos.best/api/v2"
UA = "openclaw-stickers/1.0"
MAX_BYTES = 5 * 1024 * 1024  # QQ 5MB 以上要分片上传，表情包没必要这么大
MAGIC = {b"\x89PNG": "png", b"GIF8": "gif", b"\xff\xd8\xff": "jpg", b"RIFF": "webp"}


def out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, indent=1))
    sys.exit(code)


def fail(msg):
    out({"ok": False, "error": msg}, 1)


def load():
    if not os.path.exists(INDEX):
        return {"version": 1, "stickers": {}}
    with open(INDEX, encoding="utf-8") as f:
        return json.load(f)


def save(db):
    tmp = "%s.%d.tmp" % (INDEX, os.getpid())  # 每个进程自己的临时文件，并发时不会互相写坏
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, INDEX)


@contextlib.contextmanager
def locked():
    """跨进程互斥锁：两个对话同时发表情时，读-改-写索引不会互相覆盖。"""
    os.makedirs(ROOT, exist_ok=True)
    with open(INDEX + ".lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def next_sid(db):
    """新 id 永远比用过的都大（包括已删除、进了 trash 的），旧 id 不会被复用。"""
    used = [int(k[1:]) for k in db["stickers"] if k[1:].isdigit()]
    if os.path.isdir(TRASH):
        used += [int(f[1:-5]) for f in os.listdir(TRASH)
                 if f.startswith("s") and f.endswith(".json") and f[1:-5].isdigit()]
    try:
        floor = int(db.get("next_id", 1)) - 1
    except (TypeError, ValueError):
        floor = 0
    n = max(used + [floor, 0]) + 1
    return "s%03d" % n, n


def ensure_dirs():
    for d in (IMG, INBOX, TRASH):
        os.makedirs(d, exist_ok=True)


def sniff(data):
    for sig, ext in MAGIC.items():
        if data.startswith(sig):
            if ext == "webp" and data[8:12] != b"WEBP":
                continue
            return ext
    return None


def http_get(url, limit=MAX_BYTES + 1):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(limit)


def download(url, dest_dir, stem):
    data = http_get(url)
    if len(data) > MAX_BYTES:
        raise ValueError(say("tooBig"))
    ext = sniff(data)
    if not ext:
        raise ValueError(say("notImage"))
    path = os.path.join(dest_dir, "%s.%s" % (stem, ext))
    with open(path, "wb") as f:
        f.write(data)
    return path


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def rel(path):
    """相对 workspace 的路径（./stickers/img/...），只用来标识文件；发图要用 send/react，MEDIA: 内联会被拦掉。"""
    ws = os.path.dirname(ROOT)
    return "./" + os.path.relpath(path, ws)


def split_list(s):
    return [x.strip() for x in (s or "").replace("，", ",").split(",") if x.strip()]


def view(sid, s):
    return {
        "id": sid,
        "path": os.path.join(IMG, s["file"]),
        "media": rel(os.path.join(IMG, s["file"])),
        "name": s["name"],
        "desc": s["desc"],
        "moods": s["moods"],
        "tags": s["tags"],
        "for": s["for"],
        "rating": s.get("rating", 3),
        "uses": s.get("uses", 0),
        "liked": s.get("liked", 0),
        "disliked": s.get("disliked", 0),
    }


# ---------- 找素材 ----------

def cmd_categories(a):
    data = json.loads(http_get(NEKOS + "/endpoints"))
    out({"ok": True, "source": "nekos.best", "categories": sorted(data.keys())})


def fetch_into_inbox(results, source):
    ensure_dirs()
    db = load()
    known = {s["sha256"] for s in db["stickers"].values()}
    got = []
    for r in results:
        url = r.get("url")
        if not url:
            continue
        stem = "c%d%04d" % (int(time.time()), random.randint(0, 9999))
        try:
            p = download(url, INBOX, stem)
        except Exception as e:
            got.append({"url": url, "error": str(e)})
            continue
        if sha(p) in known:
            os.remove(p)
            got.append({"url": url, "skipped": say("alreadyHave")})
            continue
        got.append({"candidate": p, "url": url, "anime": r.get("anime_name") or r.get("artist_name"), "source": source})
    return got


def cmd_browse(a):
    """按情绪分类拉候选图到 inbox。"""
    n = max(1, min(a.n, 8))
    data = json.loads(http_get("%s/%s?amount=%d" % (NEKOS, urllib.parse.quote(a.category), n)))
    out({"ok": True, "candidates": fetch_into_inbox(data.get("results", []), "nekos.best/" + a.category)})


def cmd_search(a):
    """按番名/角色名搜索候选图（GIF）。"""
    if len(a.query.strip()) < 3:   # 接口不收少于 3 个字的词，回的是 HTTP 400，看着像网络坏了
        fail(say("searchTooShort"))
    n = max(1, min(a.n, 8))
    q = urllib.parse.urlencode({"query": a.query, "type": 2, "amount": n})
    data = json.loads(http_get("%s/search?%s" % (NEKOS, q)))
    out({"ok": True, "candidates": fetch_into_inbox(data.get("results", []), "nekos.best/search:" + a.query)})


def cmd_grab(a):
    """从任意图片 URL 下载一张候选图（网上搜到的图用这个）。"""
    ensure_dirs()
    stem = "c%d%04d" % (int(time.time()), random.randint(0, 9999))
    try:
        p = download(a.url, INBOX, stem)
    except Exception as e:
        fail(say("grabFailed") % e)
    out({"ok": True, "candidates": [{"candidate": p, "url": a.url, "source": a.url}]})


def cmd_inbox(a):
    ensure_dirs()
    files = sorted(os.listdir(INBOX))
    out({"ok": True, "inbox": [os.path.join(INBOX, f) for f in files]})


def cmd_reject(a):
    """丢掉不喜欢的候选（直接删除，候选还没进库）。"""
    removed = []
    for p in a.paths:
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.dirname(p) != INBOX:
            fail(say("rejectOnlyInbox") % p)
        if os.path.exists(p):
            os.remove(p)
            removed.append(p)
    out({"ok": True, "removed": removed})


# ---------- 收藏与管理 ----------

def cmd_add(a):
    ensure_dirs()
    src = os.path.abspath(os.path.expanduser(a.path))
    if not os.path.isfile(src):
        fail(say("noFile") % src)
    if os.path.getsize(src) > MAX_BYTES:
        fail(say("tooBig"))
    with open(src, "rb") as f:
        ext = sniff(f.read(16))
    if not ext:
        fail(say("notImage"))
    db = load()
    digest = sha(src)
    for sid, s in db["stickers"].items():
        if s["sha256"] == digest:
            fail(say("addDuplicate") % (sid, s["name"]))
    moods = split_list(a.moods)
    if not moods:
        fail(say("addNeedsMoods"))
    sid, n = next_sid(db)
    db["next_id"] = n + 1
    fname = "%s.%s" % (sid, ext)
    dest = os.path.join(IMG, fname)
    if os.path.dirname(src) == INBOX:
        shutil.move(src, dest)
    else:
        shutil.copy2(src, dest)
    db["stickers"][sid] = {
        "file": fname,
        "name": a.name,
        "desc": a.desc,
        "moods": moods,
        "tags": split_list(a.tags),
        "for": a.for_,
        "rating": a.rating,
        "source": a.source or "",
        "sha256": digest,
        "added": time.strftime("%Y-%m-%d"),
        "uses": 0,
        "liked": 0,
        "disliked": 0,
        "last_used": None,
    }
    save(db)
    out({"ok": True, "added": view(sid, db["stickers"][sid])})


def cmd_edit(a):
    db = load()
    s = db["stickers"].get(a.id)
    if not s:
        fail(say("noId") % a.id)
    if a.name is not None:
        s["name"] = a.name
    if a.desc is not None:
        s["desc"] = a.desc
    if a.moods is not None:
        s["moods"] = split_list(a.moods)
    if a.tags is not None:
        s["tags"] = split_list(a.tags)
    if a.for_ is not None:
        s["for"] = a.for_
    if a.rating is not None:
        s["rating"] = a.rating
    save(db)
    out({"ok": True, "updated": view(a.id, s)})


def cmd_remove(a):
    ensure_dirs()
    db = load()
    s = db["stickers"].pop(a.id, None)
    if not s:
        fail(say("noId") % a.id)
    if a.id[1:].isdigit():  # 记住用到哪了，删掉的 id 以后不会再分配给别的图
        db["next_id"] = max(int(db.get("next_id", 0) or 0), int(a.id[1:]) + 1)
    p = os.path.join(IMG, s["file"])
    if os.path.exists(p):
        shutil.move(p, os.path.join(TRASH, s["file"]))
    with open(os.path.join(TRASH, "%s.json" % a.id), "w", encoding="utf-8") as f:
        json.dump(dict(s, removed=time.strftime("%Y-%m-%d"), reason=a.reason or ""), f, ensure_ascii=False, indent=1)
    save(db)
    out({"ok": True, "removed": a.id, "moved_to": TRASH})


# ---------- 使用 ----------

# 常见说法 → 库里的情绪词。只会用到库里真有的情绪（运行时过滤），没有的自动忽略。
SYNONYMS = {
    "高兴": ["开心"],
    "难过": ["委屈", "大哭"],
    "伤心": ["委屈", "大哭"],
    "谢谢": ["点赞", "收到"],
    "感谢": ["点赞", "收到"],
    "晚安": ["困", "睡"],
    "心疼": ["抱抱", "安慰", "摸摸头"],
    "抱歉": ["委屈", "对不起", "不好意思"],
    "对不起": ["委屈", "不好意思"],
}


def split_words(words):
    """"开心 得意"、"开心,得意" 这种一个参数里塞了好几个词的，拆开。"""
    res = []
    for w in words or []:
        for x in re.split(r"[\s,，、]+", w):
            if x and x not in res:
                res.append(x)
    return res


def all_moods(db):
    return {m for s in db["stickers"].values() for m in s["moods"]}


def expand_words(db, words):
    """返回 (原词, 同义词补充的情绪)。同义词只取库里存在的情绪。"""
    words = split_words(words)
    moods = all_moods(db)
    extra = []
    for w in words:
        for m in SYNONYMS.get(w, []):
            if m in moods and m not in words and m not in extra:
                extra.append(m)
    return words, extra


def nearest_moods(db, words, k=6):
    """没匹配上时给几个最接近的情绪词：先按共同的字，再按库里张数。"""
    cnt = {}
    for s in db["stickers"].values():
        for m in s["moods"]:
            cnt[m] = cnt.get(m, 0) + 1
    q = set("".join(words))
    return sorted(cnt, key=lambda m: (-len(set(m) & q), -cnt[m], m))[:k]


def score(s, words, extra=()):
    text = " ".join([s["name"], s["desc"]] + s["moods"] + s["tags"]).lower()
    moods = [m.lower() for m in s["moods"]]
    hit = 0
    for w in words:
        w = w.lower()
        if w in moods:
            hit += 3
        elif w in [t.lower() for t in s["tags"]]:
            hit += 2
        elif any(m and m in w for m in moods):  # 反向包含："累了" 里有 "累"
            hit += 2
        elif w in text:
            hit += 1
    for w in extra:  # 同义词补充的情绪，比原词略低
        w = w.lower()
        if w in moods:
            hit += 2
        elif w in text:
            hit += 1
    return hit


def cmd_find(a):
    db = load()
    words, extra = expand_words(db, a.words)
    rows = []
    for sid, s in db["stickers"].items():
        if a.for_ and s["for"] not in (a.for_, "both"):
            continue
        sc = score(s, words, extra) if words else 1
        if sc > 0:
            rows.append((sc, s.get("rating", 3), sid, s))
    rows.sort(key=lambda r: (-r[0], -r[1]))
    res = {"ok": True, "count": len(rows), "results": [dict(view(sid, s), match=sc) for sc, _, sid, s in rows[: a.limit]]}
    if not rows and words:
        res["nearest_moods"] = nearest_moods(db, words)
    out(res)


def choose(db, words):
    """按情绪挑一张：匹配度、评分、主人的反馈都会加权，最近刚用过的降权，避免老发同一张。没有匹配返回 None。"""
    now = time.time()
    words, extra = expand_words(db, words)
    pool = []
    for sid, s in db["stickers"].items():
        if s.get("disliked", 0) >= 2 and s.get("liked", 0) == 0:
            continue
        sc = score(s, words, extra)
        if sc <= 0:
            continue
        w = sc * (1 + s.get("rating", 3) / 2.0) * (1 + s.get("liked", 0) * 0.5) / (1 + s.get("disliked", 0))
        if s.get("for") == hh.owner:
            w *= 1.3
        # 主人 10-29 15:27：自己脸的表情少用，外面的更有趣；只在点名要自己露面时（情绪词带「她」「自己」）不压
        if hh.me + "自己" in s.get("tags", []) and not any(x in w_ for w_ in words for x in (hh.me, "自己")):
            w *= 0.15
        last = s.get("last_used")
        if isinstance(last, str):  # 旧数据里有手写的 "2026-10-09" 这种日期
            try:
                last = time.mktime(time.strptime(last[:10], "%Y-%m-%d"))
            except ValueError:
                last = None
        if last and now - last < 3600 * 6:
            w *= 0.2
        pool.append((w, sid, s))
    if not pool:
        return None
    r = random.uniform(0, sum(w for w, _, _ in pool))
    for w, sid, s in pool:
        r -= w
        if r <= 0:
            break
    return sid


def cmd_pick(a):
    db = load()
    sid = choose(db, a.words)
    if not sid:
        out({"ok": True, "picked": None, "hint": say("pickNone"),
             "nearest_moods": nearest_moods(db, split_words(a.words))})
    out({"ok": True, "picked": view(sid, db["stickers"][sid])})


def cmd_feedback(a):
    db = load()
    s = db["stickers"].get(a.id)
    if not s:
        fail(say("noId") % a.id)
    key = "liked" if a.reaction == "liked" else "disliked"
    s[key] = s.get(key, 0) + 1
    if a.note:
        s.setdefault("notes", []).append("%s %s: %s" % (time.strftime("%Y-%m-%d"), a.reaction, a.note))
    save(db)
    out({"ok": True, "updated": view(a.id, s)})


FFMPEG = "/opt/homebrew/bin/ffmpeg"
MP4_CACHE = os.path.join(ROOT, "mp4")


def whatsapp_media(path):
    """WhatsApp 显示不了 GIF：转成 MP4（缓存到 stickers/mp4/），配合 gifPlayback 发出去才是循环动图。
    缓存按 GIF 内容的哈希命名（<sha256前12位>.mp4），图换了内容或 id 被别的图用了，都不会发出旧动图。"""
    import subprocess
    if not path.lower().endswith(".gif"):
        return path, False
    os.makedirs(MP4_CACHE, exist_ok=True)
    mp4 = os.path.join(MP4_CACHE, sha(path)[:12] + ".mp4")
    if os.path.isfile(mp4):
        return mp4, True
    legacy = os.path.join(MP4_CACHE, os.path.splitext(os.path.basename(path))[0] + ".mp4")
    if os.path.isfile(legacy) and os.path.getmtime(legacy) >= os.path.getmtime(path):
        os.replace(legacy, mp4)  # 旧版按 id 命名的缓存：按旧规则仍有效的，改名迁移过来
        return mp4, True
    tmp = "%s.%d.tmp.mp4" % (mp4[:-4], os.getpid())
    r = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", path, "-movflags", "faststart", "-pix_fmt", "yuv420p",
                        "-vf", "scale=trunc(iw*2/2)*2:trunc(ih*2/2)*2:flags=lanczos", "-c:v", "libx264", "-an", tmp],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise ValueError(say("gifToMp4Failed") % r.stderr.strip()[-200:])
    os.replace(tmp, mp4)
    return mp4, True


def resolve_image(ref, db):
    """ref 可以是库里的 id（s001），也可以是 stickers 目录下的图片路径（比如 inbox 里的候选）。"""
    if ref in db["stickers"]:
        return os.path.join(IMG, db["stickers"][ref]["file"]), ref
    p = os.path.abspath(os.path.expanduser(ref))
    if not p.startswith(ROOT + os.sep) or not os.path.isfile(p):
        raise ValueError(say("refNotFound") % ref)
    return p, None


def bump_usage(sids):
    """发完再记使用次数：重新读一遍索引，只改 uses/last_used，不会把发送期间别人改的描述/评分覆盖掉。"""
    if not sids:
        return
    with locked():
        db = load()
        now = time.time()
        for sid in sids:
            s = db["stickers"].get(sid)
            if s:
                s["uses"] = s.get("uses", 0) + 1
                s["last_used"] = now
        save(db)


def cmd_prepare(a):
    """只挑图、备好要发的文件，不发。Human Harness 的 sticker 工具用它：图由 HH 经常连着的网关发出去（一秒左右，
    不用再起两次 openclaw 命令行），发成了再用 `used` 记使用次数。--ref 和 send 一样（库里的 id 或 stickers 目录里的路径），
    不写 --ref 就按 --mood 挑一张。"""
    db = load()
    refs = list(a.refs or [])
    if not refs:
        if not a.mood:
            fail(say("prepareNeedsMoodOrRef"))
        sid = choose(db, a.mood)
        if not sid:
            out({"ok": True, "items": [], "note": say("prepareNone"),
                 "nearest_moods": nearest_moods(db, split_words(a.mood))})
        refs = [sid]
    items, errors = [], []
    for ref in refs:
        try:
            path, sid = resolve_image(ref, db)
            gif_playback = False
            if a.channel == "whatsapp":
                path, gif_playback = whatsapp_media(path)
        except ValueError as e:
            errors.append(str(e))
            continue
        s = db["stickers"].get(sid) if sid else None
        items.append({"ref": ref, "id": sid, "name": (s or {}).get("name") or os.path.basename(path),
                      "path": path, "gifPlayback": gif_playback})
    out({"ok": not errors, "items": items, "errors": errors}, 0 if not errors else 1)


def cmd_used(a):
    """发出去之后记一次使用（HH 的 sticker 工具发成了才调）。"""
    bump_usage(a.ids)
    out({"ok": True})

def cmd_stats(a):
    db = load()
    st = db["stickers"]
    moods = {}
    for s in st.values():
        for m in s["moods"]:
            moods[m] = moods.get(m, 0) + 1
    ensure_dirs()
    top = sorted(st.items(), key=lambda kv: -kv[1].get("uses", 0))[:5]
    out({
        "ok": True,
        "total": len(st),
        "inbox": len(os.listdir(INBOX)),
        "moods": dict(sorted(moods.items(), key=lambda kv: -kv[1])),
        "most_used": [{"id": k, "name": v["name"], "uses": v.get("uses", 0)} for k, v in top],
        "disliked": [{"id": k, "name": v["name"]} for k, v in st.items() if v.get("disliked", 0) > v.get("liked", 0)],
    })


def main():
    p = argparse.ArgumentParser(description=say("helpMain"))
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("categories", help=say("helpCategories"))
    b = sub.add_parser("browse", help=say("helpBrowse"))
    b.add_argument("category")
    b.add_argument("-n", type=int, default=3)
    s = sub.add_parser("search", help=say("helpSearch"))
    s.add_argument("query")
    s.add_argument("-n", type=int, default=3)
    g = sub.add_parser("grab", help=say("helpGrab"))
    g.add_argument("url")
    sub.add_parser("inbox", help=say("helpInbox"))
    rj = sub.add_parser("reject", help=say("helpReject"))
    rj.add_argument("paths", nargs="+")

    ad = sub.add_parser("add", help=say("helpAdd"))
    ad.add_argument("path")
    ad.add_argument("--name", required=True)
    ad.add_argument("--desc", required=True)
    ad.add_argument("--moods", required=True, help=say("helpMoods"))
    ad.add_argument("--tags", default="")
    ad.add_argument("--for", dest="for_", choices=["me", hh.owner, "both"], default="me")
    ad.add_argument("--rating", type=int, choices=range(1, 6), default=3)
    ad.add_argument("--source", default="")

    ed = sub.add_parser("edit", help=say("helpEdit"))
    ed.add_argument("id")
    ed.add_argument("--name")
    ed.add_argument("--desc")
    ed.add_argument("--moods")
    ed.add_argument("--tags")
    ed.add_argument("--for", dest="for_", choices=["me", hh.owner, "both"])
    ed.add_argument("--rating", type=int, choices=range(1, 6))

    rm = sub.add_parser("remove", help=say("helpRemove"))
    rm.add_argument("id")
    rm.add_argument("--reason", default="")

    f = sub.add_parser("find", help=say("helpFind"))
    f.add_argument("words", nargs="*")
    f.add_argument("--for", dest="for_", choices=["me", hh.owner, "both"])
    f.add_argument("--limit", type=int, default=8)
    pk = sub.add_parser("pick", help=say("helpPick"))
    pk.add_argument("words", nargs="+")
    fb = sub.add_parser("feedback", help=say("helpFeedback") % hh.owner)
    fb.add_argument("id")
    fb.add_argument("reaction", choices=["liked", "disliked"])
    fb.add_argument("--note", default="")
    pr = sub.add_parser("prepare", help=say("helpPrepare"))
    pr.add_argument("--mood", nargs="+", default=None, help=say("helpMood"))
    pr.add_argument("--ref", dest="refs", nargs="+", default=None, help=say("helpRef"))
    pr.add_argument("--channel", choices=["qqbot", "whatsapp"], required=True,
                    help=say("helpChannel"))
    us = sub.add_parser("used", help=say("helpUsed"))
    us.add_argument("ids", nargs="+")
    sub.add_parser("stats", help=say("helpStats"))

    a = p.parse_args()
    try:
        globals()["cmd_" + a.cmd](a)
    except urllib.error.URLError as e:
        fail(say("networkError") % e)


if __name__ == "__main__":
    main()
