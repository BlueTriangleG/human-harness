#!/usr/bin/env python3
"""看一个视频：信息、弹幕高能时刻、画面九宫格、前几分钟的台词。全在本机跑，不花钱。

用法:
  python3 scripts/watch.py <B站或YouTube链接>            # 默认听前 3 分钟
  python3 scripts/watch.py <链接> --minutes 10           # 多听一会儿（越长越慢）
  python3 scripts/watch.py <链接> --no-audio             # 只看信息、弹幕和画面，最快
  python3 scripts/watch.py <链接> --lang auto            # 听写语言自动识别（默认 zh；也可以 en、ja 等）

哪一步失败（信息、弹幕、画面、台词）都会打一行原因，然后接着做别的。
info.txt 一开始就写，后面每做完一步往里追加，中途断了也能看到已经拿到的部分。

看完：用 view_image 打开输出里的「画面」那张图，就能看到视频里的样子。
结果也存在 memory/videos/<视频id>/ 里（info.txt、sheet.jpg、transcript.txt）。
"""
import argparse
import collections
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import html

from hh_env import words

say = words(__file__)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
OUT_ROOT = os.path.join(os.environ["HH_WORKSPACE"], "memory", "videos")  # shared with the B站 module: memory/videos/<id>/
BIN = "/opt/homebrew/bin"


def fmt_t(sec):
    sec = int(sec)
    return "%d:%02d" % (sec // 60, sec % 60) if sec < 3600 else "%d:%02d:%02d" % (sec // 3600, sec % 3600 // 60, sec % 60)


def danmaku(url, tmp):
    subprocess.run([BIN + "/yt-dlp", "-q", "--no-warnings", "--skip-download", "--write-subs", "--sub-langs", "danmaku",
                    "-o", os.path.join(tmp, "d.%(ext)s"), url], capture_output=True, timeout=120)
    p = os.path.join(tmp, "d.danmaku.xml")
    if not os.path.exists(p):
        return [], []
    raw = open(p, "rb").read()
    items = []
    for t, txt in re.findall(r'<d p="([\d.]+),[^"]*">([^<]*)</d>', raw.decode("utf-8", "replace")):
        items.append((float(t), html.unescape(txt).strip()))
    if not items:
        return [], []
    # 弹幕最密的时刻 = 高能时刻（按 10 秒一格数）
    bins = collections.Counter(int(t // 10) for t, _ in items if t >= 20)  # 开头的"来了"不算
    peaks = []
    for b, _ in bins.most_common():
        if all(abs(b - p) > 2 for p in peaks):
            peaks.append(b)
        if len(peaks) == 6:
            break
    moments = []
    for b in sorted(peaks):
        words = collections.Counter(txt for t, txt in items if int(t // 10) == b and txt)
        moments.append((b * 10 + 5, bins[b], [w for w, _ in words.most_common(4)]))
    top = [w for w, n in collections.Counter(txt for _, txt in items if len(txt) >= 2).most_common(12) if n >= 3]
    return moments, top


def ytdlp_info(url):
    r = subprocess.run([BIN + "/yt-dlp", "-J", "--no-warnings", url], capture_output=True, text=True, timeout=120)
    if not r.stdout.strip():
        err = (r.stderr or "").strip().splitlines()
        raise RuntimeError(err[-1][:200] if err else say("ytdlpNoOutput"))
    d = json.loads(r.stdout)
    tags = say("listSep").join((d.get("tags") or [])[:8])
    return {"id": re.sub(r"[^\w-]", "_", d["id"]), "title": d.get("title"), "up": d.get("uploader"),
            "duration": int(d.get("duration") or 0), "desc": (d.get("description") or "")[:500],
            "stat": say("stats") % (d.get("view_count"), d.get("like_count"), d.get("comment_count"))
                    + (say("tagsLine", tags=tags) if tags else "")}


def download(url, secs, tmp):
    """只下载前 secs 秒的音频，用来听台词。"""
    out = os.path.join(tmp, "v.%(ext)s")
    cmd = [BIN + "/yt-dlp", "-q", "--no-warnings", "-f", "worstaudio/worst",
           "--download-sections", "*0-%d" % secs, "--force-keyframes-at-cuts", "-o", out, url]
    subprocess.run(cmd, capture_output=True, timeout=600)
    files = [f for f in os.listdir(tmp) if f.startswith("v.")]
    return os.path.join(tmp, files[0]) if files else None


def stream_url(url):
    r = subprocess.run([BIN + "/yt-dlp", "-g", "--no-warnings", "-f", "worstvideo[height>=240]/worst[height>=240]/worst", url],
                       capture_output=True, text=True, timeout=120)
    return r.stdout.strip().splitlines()[0] if r.stdout.strip() else None


def contact_sheet(video, times, dest, tmp):
    """在给定时间点截图（直接从视频流里跳着截，不用下载整个视频），拼成一张 3x3 的图。"""
    shots = []
    for i, t in enumerate(times[:9]):
        p = os.path.join(tmp, "f%02d.jpg" % i)
        subprocess.run([BIN + "/ffmpeg", "-y", "-loglevel", "error", "-headers", "Referer: https://www.bilibili.com\r\nUser-Agent: %s\r\n" % UA,
                        "-ss", str(t), "-i", video, "-frames:v", "1",
                        "-vf", "scale=480:-2", p], capture_output=True, timeout=60)
        if os.path.exists(p):
            shots.append(p)
    if not shots:
        return None
    cols = 3 if len(shots) > 4 else 2
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as f:
        for p in shots:
            f.write("file '%s'\n" % p)
    subprocess.run([BIN + "/ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
                    "-vf", "tile=%dx%d:padding=4" % (cols, (len(shots) + cols - 1) // cols), "-frames:v", "1", dest],
                   capture_output=True, timeout=60)
    return dest if os.path.exists(dest) else None


def info_from_url(url):
    """视频信息拿不到时的后备：从链接里抠出 id，其他留空。"""
    m = re.search(r"(BV[0-9A-Za-z]{10})", url) or re.search(r"(?:v=|youtu\.be/|shorts/)([\w-]{6,})", url)
    vid = m.group(1) if m else "url_" + hashlib.md5(url.encode()).hexdigest()[:10]
    return {"id": re.sub(r"[^\w-]", "_", vid), "title": say("notGot"), "up": say("notGot"), "duration": 0, "desc": "",
            "stat": say("statsNotGot")}


def why(e):
    if isinstance(e, subprocess.TimeoutExpired):
        return say("timedOut") % e.timeout
    return "%s: %s" % (e.__class__.__name__, str(e)[:200])


def transcribe(video, secs, tmp, lang="zh"):
    wav = os.path.join(tmp, "a.wav")
    subprocess.run([BIN + "/ffmpeg", "-y", "-loglevel", "error", "-i", video, "-t", str(secs), "-ac", "1", "-ar", "16000", wav],
                   capture_output=True, timeout=120)
    if not os.path.exists(wav):
        return ""
    lang_args = [] if lang == "auto" else ["--language", lang]   # auto：让 whisper 自己听是什么语言
    subprocess.run([BIN + "/whisper", wav, "--model", "base"] + lang_args + ["--output_format", "txt",
                    "--output_dir", tmp, "--fp16", "False", "--verbose", "False"],
                   capture_output=True, timeout=900, env=dict(os.environ, PYTHONWARNINGS="ignore"))
    p = os.path.join(tmp, "a.txt")
    return " ".join(open(p).read().split()) if os.path.exists(p) else ""


def main():
    ap = argparse.ArgumentParser(description=say("helpMain"))
    ap.add_argument("url")
    ap.add_argument("--minutes", type=float, default=3)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--lang", default="zh", help=say("helpLang"))
    a = ap.parse_args()

    try:
        info = ytdlp_info(a.url)
    except Exception as e:  # 信息拿不到，照样试试弹幕、画面、台词
        print(say("infoFailed") % why(e), file=sys.stderr)
        info = info_from_url(a.url)
    moments, top = [], []
    tmp0 = tempfile.mkdtemp(prefix="watch-")
    try:
        moments, top = danmaku(a.url, tmp0)  # 只有B站有弹幕
    except Exception as e:  # 弹幕拿不到不影响看
        print(say("danmakuFailed") % why(e), file=sys.stderr)
    finally:
        shutil.rmtree(tmp0, ignore_errors=True)
    dur = info["duration"] or 600

    out_dir = os.path.join(OUT_ROOT, info["id"])
    os.makedirs(out_dir, exist_ok=True)
    info_path = os.path.join(out_dir, "info.txt")
    lines = [say("titleLine") % info["title"], say("uploaderLine") % info["up"], say("durationLine") % fmt_t(dur), info["stat"], say("linkLine") % a.url]
    if info.get("desc"):
        lines.append(say("descLine") % info["desc"][:300].replace("\n", " "))
    if moments:
        lines.append(say("peaksHeader"))
        for t, n, words in moments:
            lines.append(say("peakLine") % (fmt_t(t), n, " / ".join(words)))
    if top:
        lines.append(say("topDanmaku", list=" / ".join(top)))
    with open(info_path, "w") as f:   # 先把已经拿到的写下来，后面每一步往后追加
        f.write("\n".join(lines) + "\n")
    written = len(lines)

    def flush():
        nonlocal written
        if len(lines) > written:
            with open(info_path, "a") as f:
                f.write("\n".join(lines[written:]) + "\n")
            written = len(lines)

    # 画面：弹幕高能时刻 + 均匀分布的几张，凑九张
    peaks = [int(t) for t, _, _ in moments][:5]
    even = [int(dur * k / (10 - len(peaks))) for k in range(1, 10 - len(peaks))]
    times = sorted(set(t for t in peaks + even if t < dur))[:9]
    listen = 0 if a.no_audio else min(dur, int(a.minutes * 60))
    tmp = tempfile.mkdtemp(prefix="watch-")
    try:
        try:
            src = stream_url(a.url)
            sheet = contact_sheet(src, times, os.path.join(out_dir, "sheet.jpg"), tmp) if src else None
        except Exception as e:
            print(say("sheetFailed") % why(e), file=sys.stderr)
            sheet = None
        if sheet:
            lines.append(say("sheetLine") % (sheet, say("listSep").join(fmt_t(t) for t in times)))
        else:
            lines.append(say("sheetNone"))
        flush()
        if listen:
            try:
                video = download(a.url, listen + 2, tmp)
                transcript = transcribe(video, listen, tmp, a.lang) if video else ""
            except Exception as e:
                print(say("transcriptFailed") % why(e), file=sys.stderr)
                transcript = ""
            if transcript:
                with open(os.path.join(out_dir, "transcript.txt"), "w") as f:
                    f.write(transcript)
                lines.append(say("transcriptLine") % (fmt_t(listen), transcript[:2500]))
            else:
                lines.append(say("transcriptNone"))
            flush()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n".join(lines))


if __name__ == "__main__":
    main()
