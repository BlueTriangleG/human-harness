"""后台转写一条 B站 视频的声音（由 viewing.transcribe 起，脱离 MCP 进程跑）。

用法：transcribe_job.py <BV> <page> <minutes> <model> <status.json> <out.txt>
只下音轨（最低码率那条），ffmpeg 转 16k 单声道，本机 whisper 转文字。写状态文件，结束后自己退出。
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bilitools import core  # noqa: E402


def _bin(name: str) -> str:
    for p in (f"/opt/homebrew/bin/{name}", shutil.which(name) or ""):
        if p and os.path.exists(p):
            return p
    raise RuntimeError(core.say("transcribe_job._bin.1", a=name))


def status(path: Path, **kw):
    kw.setdefault("ts", int(time.time()))
    if kw.get("status") == "running":
        kw["pid"] = os.getpid()          # 让 transcribe_status 能看出进程是不是还活着
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(kw, ensure_ascii=False), "utf-8")
    os.replace(tmp, path)


async def audio_url(bvid: str, page: int) -> str:
    from bilibili_api import video
    v = video.Video(bvid=bvid, credential=core.get_cred(required=False))
    d = await v.get_download_url(page_index=page - 1)
    dash = d.get("dash") or {}
    auds = sorted(dash.get("audio") or [], key=lambda a: a.get("bandwidth") or 0)
    if auds:
        a = auds[0]
        return a.get("baseUrl") or a.get("base_url") or (a.get("backupUrl") or [""])[0]
    durl = d.get("durl") or []
    if durl:
        return durl[0].get("url")
    raise RuntimeError(core.say("transcribe_job.audio_url.1"))


def main():
    bvid, page, minutes, model, st_path, out_path = sys.argv[1:7]
    page, minutes = int(page), int(minutes)
    st, out = Path(st_path), Path(out_path)
    t0 = time.time()
    try:
        status(st, status="running", step=core.say("transcribe_job.main.1"), ts=int(t0))
        url = asyncio.run(audio_url(bvid, page))
        with tempfile.TemporaryDirectory(prefix="bili-asr-", dir=str(core.DATA)) as tmp:
            wav = os.path.join(tmp, "a.wav")
            status(st, status="running", step=core.say("transcribe_job.main.2"), ts=int(t0))
            hdr = f"Referer: https://www.bilibili.com/\r\nUser-Agent: {core.UA}\r\n"
            p = subprocess.run([_bin("ffmpeg"), "-y", "-loglevel", "error", "-headers", hdr, "-i", url,
                                "-t", str(minutes * 60), "-vn", "-ac", "1", "-ar", "16000", wav],
                               capture_output=True, text=True, timeout=600)
            if p.returncode != 0 or not os.path.exists(wav):
                raise RuntimeError(core.say("transcribe_job.main.3") + (p.stderr or "")[-300:])
            status(st, status="running", step=core.say("transcribe_job.main.4", a=model), ts=int(t0))
            p = subprocess.run([_bin("whisper"), wav, "--model", model, "--language", "zh", "--fp16", "False",
                                "--initial_prompt", "以下是普通话的句子。", "--output_format", "txt",
                                "--output_dir", tmp, "--verbose", "False"],
                               capture_output=True, text=True, timeout=minutes * 60 * 3 + 600)
            txt = os.path.join(tmp, "a.txt")
            if p.returncode != 0 or not os.path.exists(txt):
                raise RuntimeError(core.say("transcribe_job.main.5") + (p.stderr or "")[-300:])
            text = Path(txt).read_text("utf-8", errors="replace").strip()
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp_out = out.with_suffix(".tmp")
        tmp_out.write_text(text + "\n", "utf-8")
        os.replace(tmp_out, out)
        status(st, status="done", chars=len(text), took_sec=int(time.time() - t0), file=str(out),
               minutes=minutes, model=model)
    except Exception as e:  # noqa: BLE001
        status(st, status="failed", error=f"{type(e).__name__}: {str(e)[:400]}", took_sec=int(time.time() - t0))


if __name__ == "__main__":
    main()
