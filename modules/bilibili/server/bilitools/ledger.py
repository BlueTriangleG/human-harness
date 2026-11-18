"""判重表 + 归档：看过什么、怎么看的。

- memory/bili/seen.jsonl：一行一条（同一个 BV 可以有多行，最新的那行算数）
- memory/bili/digest/<年-月>.md：每次下结论追加一行「日期 · BV · 标题 · UP · 档位 · 一句话 · 链接」，
  给以后「我看过 XX 吗」翻旧账用（记忆搜索能搜到）。
"""
from __future__ import annotations

import datetime as dt
import re

from . import core
from .core import BiliError, bili_tool

SEEN = core.LEDGER / "seen.jsonl"
VERDICTS = ("值得看", "可以看", "不值当", "跳过", "看过")


def _index() -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for r in core.jsonl_read(SEEN):
        bv = r.get("bvid")
        if not bv:
            continue
        prev = idx.get(bv)
        if prev is None:
            idx[bv] = dict(r)
            continue
        # 自动记的「看过」不覆盖她自己下的结论
        if r.get("verdict") == "看过" and prev.get("verdict") not in (None, "", "看过"):
            prev["last_ts"] = r.get("ts")
            continue
        merged = {**prev, **{k: v for k, v in r.items() if v not in (None, "")}}
        idx[bv] = merged
    return idx


def lookup(bvids) -> dict[str, dict]:
    idx = _index()
    return {b: idx[b] for b in bvids if b in idx}


def annotate(items: list[dict]) -> list[dict]:
    """列表里每条加 seen 字段（看过就写当时的档位/时间），没看过不加。"""
    idx = _index()
    for it in items:
        r = idx.get(it.get("bvid"))
        if r:
            it["seen"] = f"{r.get('verdict') or '看过'} {str(r.get('time', ''))[:10]}".strip()
    return items


def touch(bvid: str, title: str = "", up: str = "", how: str = "") -> None:
    """看了一条（读字幕/看画面/watch）就自动记一笔「看过」；已经有记录就不重复写。"""
    if not bvid:
        return
    if bvid in _index():
        return
    try:
        core.jsonl_append(SEEN, {"ts": core.now_ts(), "time": core.fmt_ts(core.now_ts()), "bvid": bvid,
                                 "title": core.cut(title, 80), "up": core.cut(up, 30), "verdict": "看过",
                                 "how": how})
    except OSError:
        pass


def _digest_line(row: dict) -> str:
    cell = lambda s, n=60: core.cut(" ".join(str(s or "").split()), n)  # noqa: E731
    parts = [row["time"][:16], row["bvid"], cell(row.get("title"), 50), cell(row.get("up"), 20),
             row.get("verdict") or "", cell(row.get("note"), 120), core.video_url(row["bvid"])]
    return "- " + " · ".join(p for p in parts if p) + "\n"


@bili_tool(network=False)
async def seen_mark(bvid: str, verdict: str, note: str = "", title: str = "", up: str = "") -> dict:
    bv = await core.resolve_bvid(bvid)
    verdict = str(verdict or "").strip()[:12]
    if not verdict:
        raise BiliError(core.say("ledger.seen_mark.1"), core.say("ledger.seen_mark.2"))
    prev = _index().get(bv, {})
    row = {"ts": core.now_ts(), "time": core.fmt_ts(core.now_ts()), "bvid": bv,
           "title": core.cut(title or prev.get("title", ""), 80), "up": core.cut(up or prev.get("up", ""), 30),
           "verdict": verdict, "note": core.cut(note, 300)}
    core.jsonl_append(SEEN, row)
    month = dt.date.today().strftime("%Y-%m")
    dig = core.LEDGER / "digest" / f"{month}.md"
    dig.parent.mkdir(parents=True, exist_ok=True)
    fresh = not dig.exists()
    with open(dig, "a", encoding="utf-8") as f:
        if fresh:
            f.write(core.say("ledger.seen_mark.3", a=month))
        f.write(_digest_line(row))
    return {"ok": True, "bvid": bv, "verdict": verdict, "files": [str(SEEN), str(dig)]}


@bili_tool(network=False)
async def seen_check(bvids: list[str]) -> dict:
    out, unseen, bad = {}, [], []
    resolved = []
    for s in (bvids or [])[:100]:
        m = re.search(r"BV[0-9A-Za-z]{10}", str(s))
        if m:
            resolved.append(m.group(0))
            continue
        try:
            resolved.append(await core.resolve_bvid(s))
        except Exception:  # noqa: BLE001
            bad.append(str(s)[:60])
    hits = lookup(resolved)
    for bv in resolved:
        r = hits.get(bv)
        if r:
            out[bv] = {k: r.get(k) for k in ("time", "verdict", "note", "title") if r.get(k)}
        else:
            unseen.append(bv)
    res = {"ok": True, "seen": out, "unseen": unseen}
    if bad:
        res["unrecognized"] = bad
    return res


@bili_tool(network=False)
async def seen_recent(limit: int = 30, verdict: str = "", keyword: str = "") -> dict:
    rows = sorted(_index().values(), key=lambda r: -int(r.get("ts") or 0))
    if verdict:
        rows = [r for r in rows if r.get("verdict") == verdict]
    if keyword:
        k = keyword.lower()
        rows = [r for r in rows if k in " ".join(str(r.get(x, "")) for x in ("title", "up", "note")).lower()]
    n = max(1, min(int(limit or 30), 200))
    return {"ok": True, "total": len(rows),
            "items": [{k: r.get(k) for k in ("time", "bvid", "title", "up", "verdict", "note") if r.get(k)}
                      for r in rows[:n]]}


TOOLS = [seen_mark, seen_check, seen_recent]
