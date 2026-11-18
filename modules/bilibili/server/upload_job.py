"""后台投稿（由 publish.upload_video 起）。用法：upload_job.py <plan.json> <status.json>

上传要几分钟到几十分钟，比工具调用的时限长，所以脱离 MCP 进程跑；进度写进 status.json。
基于上游 bilibili-mcp 的 bili_upload_video（MIT）。
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


def status(path: Path, **kw):
    kw.setdefault("ts", int(time.time()))
    if kw.get("status") == "running":
        kw["pid"] = os.getpid()
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(kw, ensure_ascii=False), "utf-8")
    os.replace(tmp, path)


def grab_cover(video: str, tmpdir: str) -> str:
    out = os.path.join(tmpdir, "cover.jpg")
    ff = "/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else (shutil.which("ffmpeg") or "ffmpeg")
    subprocess.run([ff, "-y", "-loglevel", "error", "-ss", "3", "-i", video, "-vframes", "1", "-q:v", "2", out],
                   capture_output=True, timeout=120)
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        raise RuntimeError(core.say("upload_job.grab_cover.1"))
    return out


async def run(plan: dict, st: Path):
    from bilibili_api import Picture, video_uploader
    t0 = int(time.time())
    with tempfile.TemporaryDirectory(prefix="bili-up-", dir=str(core.DATA)) as tmp:
        cover = Picture.from_file(plan["cover"] or grab_cover(plan["video"], tmp))
        meta = video_uploader.VideoMeta(tid=plan["tid"], title=plan["title"], desc=plan["desc"], cover=cover,
                                        tags=plan["tags"], original=plan["original"], source=plan["source"],
                                        no_reprint=plan["original"], neutral_mark=plan["neutral_mark"])
        page = video_uploader.VideoUploaderPage(path=plan["video"], title=plan["title"], description="")
        up = video_uploader.VideoUploader(pages=[page], meta=meta, credential=core.get_cred(write=True))

        @up.on("__ALL__")
        async def _ev(data):
            name = data.get("name") if isinstance(data, dict) else None
            status(st, status="running", step=str(name or data)[:80], ts=t0)

        res = await up.start()
    bv = (res or {}).get("bvid") if isinstance(res, dict) else None
    if not bv:
        raise RuntimeError(core.say("upload_job.run.1", a=str(res)[:200]))
    return bv, res


def main():
    plan_f, st_f = Path(sys.argv[1]), Path(sys.argv[2])
    plan = json.loads(plan_f.read_text("utf-8"))
    t0 = time.time()
    status(st_f, status="running", step=core.say("upload_job.main.1"), ts=int(t0))
    try:
        bv, res = asyncio.run(run(plan, st_f))
        status(st_f, status="done", bvid=bv, url=core.video_url(bv), took_sec=int(time.time() - t0),
               title=plan["title"], next=core.say("upload_job.main.2"))
        core.log_action("upload_video", True, bvid=bv, title=plan["title"], step="done")
    except Exception as e:  # noqa: BLE001
        status(st_f, status="failed", error=f"{type(e).__name__}: {str(e)[:400]}", took_sec=int(time.time() - t0))
        core.log_action("upload_video", False, title=plan["title"], error=str(e)[:200])


if __name__ == "__main__":
    main()
