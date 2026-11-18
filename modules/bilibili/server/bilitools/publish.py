"""发东西：图文动态、投稿视频。都是对外说话 —— 默认 dry_run（只检查不发），{owner} 点头后再 dry_run=false。

视频投稿（来自上游 bilibili-mcp 的 bili_upload_video，MIT）：
  - {me}的 AGENTS 规定第一条在 {me}的浏览器网页投稿；API 投稿是以后的事，发之前 {owner} 点头。
  - AI 声明：B站 要求 AI 生成内容标注。这里通过 neutral_mark 写「作者声明」，第一次用之前在网页核对显示对不对。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

from bilibili_api import Picture, dynamic

from . import core
from .core import BiliError, bili_tool

AI_MARK = "含AI生成内容"  # 10-29 实测：B站创作声明 id=1 的原文，写别的会报 21517「选择的创作声明不存在」
_ALLOWED_ROOTS = (str(core.WS), *core.CONFIG.get("uploadRoots", []))      # 只发工作区和配置点名的素材目录里的文件
JOBS = core.DATA / "jobs"


def _local_file(p: str, what: str) -> str:
    path = os.path.realpath(os.path.expanduser(str(p or "").strip()))
    if not any(path == r or path.startswith(r.rstrip("/") + "/") for r in _ALLOWED_ROOTS):
        raise BiliError(core.say("publish._local_file.1", a=what, b=path))
    if not os.path.isfile(path):
        raise BiliError(core.say("publish._local_file.2", a=what, b=path))
    return path


@bili_tool(cap="post_dynamic")
async def post_dynamic(text: str, images: list[str] | None = None, dry_run: bool = True) -> dict:
    msg = str(text or "").strip()
    if not msg:
        raise BiliError(core.say("publish.post_dynamic.1"))
    imgs = [_local_file(p, core.say("publish.imgs.1")) for p in (images or []) if p][:9]
    if dry_run:
        return {"dry_run": True, "text": msg, "images": imgs, "chars": len(msg), "_cap_n": 0,
                "next": core.say("publish.post_dynamic.2")}
    d = dynamic.BuildDynamic.empty().add_plain_text(msg)
    for p in imgs:
        d.add_image(Picture.from_file(p))
    res = await dynamic.send_dynamic(info=d, credential=core.get_cred(write=True))
    did = (res or {}).get("dyn_id_str") or (res or {}).get("dyn_id")
    core.log_action("post_dynamic", True, text=core.cut(msg, 200), dynamic_id=did)
    return {"posted": True, "dynamic_id": did, "url": f"https://t.bilibili.com/{did}" if did else None}


@bili_tool(cap="upload_video")
async def upload_video(video_path: str, title: str, desc: str = "", tid: int = 27, tags: list[str] | None = None,
                       cover_path: str = "", ai_generated: bool = True, original: bool = True, source: str = "",
                       dry_run: bool = True) -> dict:
    vp = _local_file(video_path, core.say("publish.vp.1"))
    t = str(title or "").strip()
    if not t or len(t) > 80:
        raise BiliError(core.say("publish.upload_video.1"))
    if len(desc or "") > 2000:
        raise BiliError(core.say("publish.upload_video.2"))
    tg = [str(x).strip() for x in (tags or []) if str(x).strip()][:10]
    if not tg:
        raise BiliError(core.say("publish.upload_video.3"))
    if any(len(x) > 20 for x in tg):
        raise BiliError(core.say("publish.upload_video.4"))
    if not original and not source:
        raise BiliError(core.say("publish.upload_video.5"))
    cp = _local_file(cover_path, core.say("publish.cp.1")) if cover_path else ""
    plan = {"video": vp, "size_mb": round(os.path.getsize(vp) / 1e6, 1), "title": t, "desc": desc or "",
            "tid": int(tid), "tags": tg, "cover": cp, "neutral_mark": AI_MARK if ai_generated else None,
            "original": bool(original), "source": source or None}
    if dry_run:
        return {"dry_run": True, "plan": {**plan, "desc": core.cut(desc, 80), "cover": cp or core.say("publish.upload_video.6")},
                "_cap_n": 0, "next": core.say("publish.upload_video.7")}
    core.get_cred(write=True)
    JOBS.mkdir(parents=True, exist_ok=True)
    job = f"upload-{int(time.time())}"
    plan_f, st_f = JOBS / f"{job}.plan.json", JOBS / f"{job}.json"
    core.write_atomic(plan_f, json.dumps(plan, ensure_ascii=False))
    core.write_atomic(st_f, json.dumps({"status": "running", "step": core.say("publish.upload_video.8"), "ts": core.now_ts()}, ensure_ascii=False))
    with open(JOBS / f"{job}.log", "w") as logf:
        subprocess.Popen([sys.executable, "-E", "-s", str(core.ROOT / "server" / "upload_job.py"), str(plan_f), str(st_f)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=logf,
                         start_new_session=True, cwd=str(core.ROOT / "server"))
    core.log_action("upload_video", True, title=t, job=job, step="started")
    return {"job": job, "status": "started", "next": core.say("publish.upload_video.9")}


@bili_tool(network=False)
async def upload_status(job: str = "") -> dict:
    if job and not job.startswith("upload-"):
        raise BiliError(core.say("publish.upload_status.1"))
    files = sorted(JOBS.glob("upload-*[0-9].json")) if not job else [JOBS / f"{job}.json"]
    if not files or not files[-1].exists():
        return {"status": "none", "next": core.say("publish.upload_status.2")}
    st = json.loads(files[-1].read_text("utf-8") or "{}")
    if st.get("status") == "running" and st.get("pid"):
        try:
            os.kill(int(st["pid"]), 0)
        except OSError:
            st = {**st, "status": "failed", "error": core.say("publish.st.1")}
    st.pop("pid", None)
    st["job"] = files[-1].stem
    return st


TOOLS = [post_dynamic, upload_video, upload_status]
