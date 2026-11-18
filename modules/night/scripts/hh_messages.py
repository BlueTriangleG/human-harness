#!/usr/bin/python3
"""从 Human Harness 的中央记忆里取对话原话（2026-10-29 起她的大脑跑在 HH 上，对话不再进 OpenClaw 的记录）。

  hh_messages.py [--who 主人|<访客>|gua] [--since 时间] [--until 时间] [--limit N] [--json] [--fingerprint]
    时间：2026-10-29T08:00、2026-10-29 08:00、ISO（可带 +11:00），或者 -24h / -90m（往前多久）
    --who：只要和这个人的对话（他说的 + 我发给他的）；不写就是所有人
    --limit：只要最后 N 条
    --fingerprint：只打印一行 sha256（按 序号/方向/人/正文 算），发送前后两次核对用，不打印正文
只读打开 ~/.hh/hh.db。命令行默认带上切换时从 OpenClaw 导入的旧对话（--new-only 不要）；
import 用的 load() 默认不带（睡眠整理那边 OpenClaw 记录里本来就有）。
别的脚本 import 用：load(since_ms, until_ms, who=None) -> [dict(seq, ts, who, name, dir, channel, text)]
"""
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys

from hh_env import forms, words

say = words(__file__)

DB = os.environ.get("HH_DB") or os.path.join(os.environ["HH_STATE_DIR"], "hh.db")
REG = os.path.join(os.environ.get("HH_WORKSPACE") or os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "memory/people/registry.json")  # the tests run the scripts from a copied workspace's scripts/
SENT = re.compile("|".join(forms(__file__).every("sentHead")))   # the head of a sent message, in every language


def registry():
    try:
        with open(REG, encoding="utf-8") as f:
            return {k: v for k, v in json.load(f).items() if not k.startswith("_") and isinstance(v, dict)}
    except (OSError, ValueError):
        return {}


class People:
    def __init__(self, reg):
        self.reg, self.by_sender, self.by_key, self.by_name = reg, {}, {}, {}
        for who, p in reg.items():
            for s in p.get("senders", []):
                self.by_sender[str(s).lower().lstrip("+")] = who
            for k in p.get("sessionKeys", []):
                self.by_key[k] = who
            if p.get("name"):
                self.by_name[p["name"]] = who
            self.by_name[who] = who

    def of_target(self, target):
        t = str(target or "").strip()
        if t in self.by_key:
            return self.by_key[t]
        return self.by_sender.get(t.rsplit(":", 1)[-1].lower().lstrip("+"))

    def name(self, who):
        return self.reg.get(who, {}).get("name", who) if who else say("msgUnregistered")


def load(since_ms=0, until_ms=None, who=None, db=None, reg=None, imported=False):
    people = People(registry() if reg is None else reg)
    until_ms = until_ms if until_ms is not None else 1 << 62
    conn = sqlite3.connect(f"file:{db or DB}?mode=ro", uri=True, timeout=30)
    try:
        rows = conn.execute("select seq, ts, kind, src, text, meta from central "
                            "where ts >= ? and ts < ? and kind in ('input', 'note') order by seq", (since_ms, until_ms)).fetchall()
    finally:
        conn.close()
    out = []
    for seq, ts, kind, src, text, meta in rows:
        try:
            m = json.loads(meta) if meta else {}
        except ValueError:
            m = {}
        if m.get("imported"):
            if not imported:
                continue
            p = people.of_target(m.get("sessionKey"))
            if m.get("sent") or kind != "input":
                rec = {"dir": "out", "channel": None, "text": SENT.sub("", text, count=1)}
            else:
                rec = {"dir": "in", "channel": None, "text": text}
                p = people.by_name.get(m.get("from")) or p
        elif kind == "input" and src == "外界" and m.get("human"):
            rt = m.get("replyTo") or {}
            p = people.of_target(rt.get("target")) or people.by_name.get(m.get("from"))
            rec = {"dir": "in", "channel": m.get("channel") or rt.get("channel"), "text": text}
        elif kind == "note" and m.get("sent"):
            p = people.of_target(m.get("to"))
            rec = {"dir": "out", "channel": None, "text": SENT.sub("", text, count=1)}
        else:
            continue
        if who and p != who:
            continue
        rec.update(seq=seq, ts=ts, who=p, name=people.name(p) if p else (m.get("from") or m.get("to") or "?"))
        out.append(rec)
    return out


def fingerprint(recs):
    h = hashlib.sha256()
    for r in recs:
        h.update(f"{r['seq']}|{r['dir']}|{r['who']}|{r['text']}\n".encode("utf-8"))
    return h.hexdigest()


def parse_time(s, now=None):
    now = now or dt.datetime.now().astimezone()
    m = re.fullmatch(r"-(\d+)([hm])", s or "")
    if m:
        return now - dt.timedelta(**{"hours" if m[2] == "h" else "minutes": int(m[1])})
    t = dt.datetime.fromisoformat(s.replace(" ", "T"))
    return t if t.tzinfo else t.astimezone()


def main(argv):
    def arg(name, default=None):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default
    since = int(parse_time(arg("--since")).timestamp() * 1000) if arg("--since") else 0
    until = int(parse_time(arg("--until")).timestamp() * 1000) if arg("--until") else None
    try:
        recs = load(since, until, arg("--who"), imported="--new-only" not in argv)
    except sqlite3.Error as e:
        sys.exit(say("msgNoCentral", e=e))
    if arg("--limit"):
        recs = recs[-int(arg("--limit")):]
    if "--fingerprint" in argv:
        last = recs[-1] if recs else None
        print(json.dumps({"fingerprint": fingerprint(recs), "count": len(recs),
                          "last_seq": last and last["seq"], "last_ts": last and last["ts"]}))
        return
    if "--json" in argv:
        print(json.dumps(recs, ensure_ascii=False))
        return
    for r in recs:
        when = dt.datetime.fromtimestamp(r["ts"] / 1000).strftime("%m-%d %H:%M")
        speaker = say("msgSentTo", name=r["name"]) if r["dir"] == "out" else r["name"]
        print(f"[{when}] #{r['seq']} {speaker}: {r['text']}")


if __name__ == "__main__":
    main(sys.argv[1:])
