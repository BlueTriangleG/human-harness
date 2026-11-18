#!/usr/bin/env python3
"""sticker.py 的测试。全部在临时目录里跑：索引是角色真索引的拷贝（没有就用小样本），ffmpeg mock，
不会真的发消息，也不会改真的 stickers/index.json。

运行：python3 modules/stickers/tests/test_sticker.py -v
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "scripts"), os.path.join(HERE, "..", "..", "_lib")]
# run by itself: what HH hands the script (docs/contracts/modules.md) points at an empty temp dir, made-up names
_tmp = tempfile.mkdtemp(prefix="sticker-env-")
for k, v in dict({k: _tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                 HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="UTC", HH_LANG="zh", HH_BIN=_tmp + "/no-hh").items():
    os.environ.setdefault(k, v)
import sticker  # noqa: E402

REAL_INDEX = sticker.INDEX  # the role's own library, copied when there is one
GIF = b"GIF89a" + b"\x00" * 32


class FakeRun:
    """替代 subprocess.run：记录调用，按命令返回假的结果。"""

    def __init__(self):
        self.calls = []
        self.ffmpeg_runs = 0

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        if cmd and cmd[0] == sticker.FFMPEG:
            self.ffmpeg_runs += 1
            with open(cmd[cmd.index("-i") + 1], "rb") as src, open(cmd[-1], "wb") as f:
                f.write(b"fake mp4 of " + src.read()[:16])
            return subprocess.CompletedProcess(cmd, 0, "", "")
        raise AssertionError("unexpected command %r" % (cmd,))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sticker-test-")
        root = os.path.join(self.tmp, "stickers")
        os.makedirs(os.path.join(root, "img"))
        os.makedirs(os.path.join(root, "inbox"))
        os.makedirs(os.path.join(root, "trash"))
        if os.path.exists(REAL_INDEX):
            shutil.copy(REAL_INDEX, os.path.join(root, "index.json"))
        else:  # 真索引不在时用一个小样本
            json.dump({"version": 1, "stickers": {
                "s001": self.entry("s001.gif", ["开心", "得意"]),
                "s002": self.entry("s002.jpg", ["累", "崩溃"]),
                "s003": self.entry("s003.gif", ["委屈", "大哭"]),
                "s004": self.entry("s004.gif", ["点赞", "收到"]),
                "s005": self.entry("s005.gif", ["安慰", "摸摸头"]),
            }}, open(os.path.join(root, "index.json"), "w"), ensure_ascii=False)  # noqa: SIM115
        self.real_index_mtime = os.path.getmtime(REAL_INDEX) if os.path.exists(REAL_INDEX) else None
        self.patches = [mock.patch.object(sticker, k, v) for k, v in {
            "ROOT": root, "IMG": os.path.join(root, "img"), "INBOX": os.path.join(root, "inbox"),
            "TRASH": os.path.join(root, "trash"), "INDEX": os.path.join(root, "index.json"),
            "MP4_CACHE": os.path.join(root, "mp4"),
        }.items()]
        for p in self.patches:
            p.start()
        # 每张图都放一个小文件，send 时能找到
        for s in self.db()["stickers"].values():
            with open(os.path.join(sticker.IMG, s["file"]), "wb") as f:
                f.write(GIF + s["file"].encode())

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp)
        if self.real_index_mtime is not None:
            self.assertEqual(os.path.getmtime(REAL_INDEX), self.real_index_mtime, "真索引被改了！")

    @staticmethod
    def entry(fname, moods):
        return {"file": fname, "name": fname, "desc": "测试", "moods": moods, "tags": [], "for": "both",
                "rating": 3, "sha256": fname, "uses": 0, "liked": 0, "disliked": 0, "last_used": None}

    def db(self):
        with open(sticker.INDEX, encoding="utf-8") as f:
            return json.load(f)

    def write_db(self, db):
        with open(sticker.INDEX, "w", encoding="utf-8") as f:
            json.dump(db, f, ensure_ascii=False)

    def run_cli(self, *argv, fake=None):
        fake = fake or FakeRun()
        buf = io.StringIO()
        code = 0
        with mock.patch("subprocess.run", fake), mock.patch.object(sys, "argv", ["sticker.py"] + list(argv)), \
                contextlib.redirect_stdout(buf):
            try:
                sticker.main()
            except SystemExit as e:
                code = e.code or 0
        return json.loads(buf.getvalue()), code, fake

    def pick_id(self, mood):
        for sid, s in self.db()["stickers"].items():
            if mood in s["moods"]:
                return sid
        self.skipTest("索引里没有情绪 %s" % mood)


# ---------- 4. 情绪匹配 ----------

class Matching(Base):
    def test_split_words(self):
        self.assertEqual(sticker.split_words(["开心 得意", "无语,收到", "累，崩溃"]), ["开心", "得意", "无语", "收到", "累", "崩溃"])

    def test_space_separated_single_arg(self):
        a, _, _ = self.run_cli("find", "开心 得意")
        b, _, _ = self.run_cli("find", "开心", "得意")
        self.assertGreater(a["count"], 0)
        self.assertEqual([r["id"] for r in a["results"]], [r["id"] for r in b["results"]])

    def test_reverse_containment(self):
        sid = self.pick_id("累")
        res, _, _ = self.run_cli("find", "累了", "--limit", "100")
        self.assertIn(sid, [r["id"] for r in res["results"]])

    def test_synonyms_only_existing_moods(self):
        db = self.db()
        words, extra = sticker.expand_words(db, ["高兴", "晚安", "心疼"])
        moods = sticker.all_moods(db)
        self.assertTrue(set(extra) <= moods)
        if "开心" in moods:
            self.assertIn("开心", extra)
        for m in ("困", "睡", "抱抱"):
            if m not in moods:
                self.assertNotIn(m, extra)

    def test_synonym_finds(self):
        sid = self.pick_id("开心")
        res, _, _ = self.run_cli("find", "高兴", "--limit", "100")
        self.assertIn(sid, [r["id"] for r in res["results"]])
        res, _, _ = self.run_cli("pick", "谢谢")
        self.assertIsNotNone(res["picked"])

    def test_exact_mood_ranks_above_synonym(self):
        s = {"name": "x", "desc": "", "moods": ["开心"], "tags": []}
        self.assertGreater(sticker.score(s, ["开心"]), sticker.score(s, ["高兴"], ["开心"]))

    def test_nearest_moods_on_no_match(self):
        res, _, _ = self.run_cli("find", "火星文xyz")
        self.assertEqual(res["count"], 0)
        self.assertTrue(res["nearest_moods"])
        res, _, _ = self.run_cli("pick", "火星文xyz")
        self.assertIsNone(res["picked"])
        self.assertTrue(res["nearest_moods"])

    def test_find_without_words_lists_all(self):
        res, _, _ = self.run_cli("find", "--limit", "1000")
        self.assertEqual(res["count"], len(self.db()["stickers"]))


# ---------- 5. MP4 缓存 + id 不复用 ----------

class Mp4CacheAndIds(Base):
    @staticmethod
    def write(path, data):
        with open(path, "wb") as f:
            f.write(data)

    @staticmethod
    def read(path):
        with open(path, "rb") as f:
            return f.read()

    def gif(self, name, data):
        p = os.path.join(sticker.IMG, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_cache_keyed_by_content(self):
        p = self.gif("s999.gif", GIF + b"one")
        fake = FakeRun()
        with mock.patch("subprocess.run", fake):
            mp4a, gp = sticker.whatsapp_media(p)
            self.assertTrue(gp)
            self.assertEqual(os.path.basename(mp4a), sticker.sha(p)[:12] + ".mp4")
            sticker.whatsapp_media(p)
            self.assertEqual(fake.ffmpeg_runs, 1)  # 第二次命中缓存
            self.gif("s999.gif", GIF + b"two")  # 同一个文件名换了内容
            os.utime(p, (1, 1))  # 就算 mtime 更旧也不会用错
            mp4b, _ = sticker.whatsapp_media(p)
            self.assertNotEqual(mp4a, mp4b)
            self.assertEqual(fake.ffmpeg_runs, 2)
            self.assertFalse([f for f in os.listdir(sticker.MP4_CACHE) if ".tmp" in f])

    def test_legacy_cache_migrated(self):
        p = self.gif("s998.gif", GIF + b"legacy")
        os.utime(p, (1000, 1000))
        os.makedirs(sticker.MP4_CACHE)
        legacy = os.path.join(sticker.MP4_CACHE, "s998.mp4")
        self.write(legacy, b"old mp4")
        fake = FakeRun()
        with mock.patch("subprocess.run", fake):
            mp4, _ = sticker.whatsapp_media(p)
        self.assertEqual(fake.ffmpeg_runs, 0)
        self.assertEqual(self.read(mp4), b"old mp4")
        self.assertFalse(os.path.exists(legacy))

    def test_stale_legacy_not_used(self):
        p = self.gif("s997.gif", GIF + b"new")
        os.makedirs(sticker.MP4_CACHE)
        legacy = os.path.join(sticker.MP4_CACHE, "s997.mp4")
        self.write(legacy, b"stale")
        os.utime(legacy, (1000, 1000))
        fake = FakeRun()
        with mock.patch("subprocess.run", fake):
            mp4, _ = sticker.whatsapp_media(p)
        self.assertEqual(fake.ffmpeg_runs, 1)
        self.assertNotEqual(self.read(mp4), b"stale")

    def test_non_gif_untouched(self):
        self.assertEqual(sticker.whatsapp_media("/x/a.jpg"), ("/x/a.jpg", False))

    def add(self, data):
        src = os.path.join(sticker.INBOX, "c%d.gif" % len(data))
        self.write(src, data)
        res, code, _ = self.run_cli("add", src, "--name", "n", "--desc", "d", "--moods", "测试")
        self.assertEqual(code, 0, res)
        return res["added"]["id"]

    def test_removed_id_not_reused(self):
        a = self.add(GIF + b"aaaa")
        res, code, _ = self.run_cli("remove", a, "--reason", "test")
        self.assertEqual(code, 0, res)
        b = self.add(GIF + b"bbbbb")
        self.assertGreater(int(b[1:]), int(a[1:]))
        self.assertGreaterEqual(self.db()["next_id"], int(b[1:]) + 1)

    def test_trash_ids_respected_without_next_id(self):
        db = self.db()
        db.pop("next_id", None)
        top = max(int(k[1:]) for k in db["stickers"])
        self.write_db(db)
        self.write(os.path.join(sticker.TRASH, "s%03d.json" % (top + 5)), b"{}")
        sid = self.add(GIF + b"cccccc")
        self.assertEqual(int(sid[1:]), top + 6)


# ---------- 7. Human Harness 的 sticker 工具：prepare 只挑不发，used 记次数 ----------

class Prepare(Base):
    def test_prepare_by_mood_never_sends_or_counts(self):
        db = self.db()
        mood = db["stickers"][sorted(db["stickers"])[0]]["moods"][0]
        before = json.dumps(db, sort_keys=True)
        res, code, fake = self.run_cli("prepare", "--mood", mood, "--channel", "whatsapp")
        self.assertEqual(code, 0, res)
        self.assertEqual(len(res["items"]), 1)
        self.assertTrue(os.path.isfile(res["items"][0]["path"]))
        self.assertEqual([c for c in fake.calls if c[0] != sticker.FFMPEG], [])  # 只挑不发：除了转 MP4 不起别的命令
        self.assertEqual(json.dumps(self.db(), sort_keys=True), before)

    def test_prepare_gif_for_whatsapp_becomes_mp4(self):
        sid = next((k for k, s in sorted(self.db()["stickers"].items()) if s["file"].endswith(".gif")), None)
        if not sid:
            self.skipTest("索引里没有 GIF")
        res, code, _ = self.run_cli("prepare", "--ref", sid, "--channel", "whatsapp")
        self.assertEqual(code, 0, res)
        self.assertTrue(res["items"][0]["path"].endswith(".mp4"))
        self.assertTrue(res["items"][0]["gifPlayback"])
        self.assertEqual(res["items"][0]["id"], sid)
        res, code, _ = self.run_cli("prepare", "--ref", sid, "--channel", "qqbot")
        self.assertTrue(res["items"][0]["path"].endswith(".gif"))
        self.assertFalse(res["items"][0]["gifPlayback"])

    def test_prepare_no_match(self):
        res, code, _ = self.run_cli("prepare", "--mood", "zzzqqq", "--channel", "qqbot")
        self.assertEqual(code, 0, res)
        self.assertEqual(res["items"], [])
        self.assertIn("nearest_moods", res)

    def test_prepare_outside_library_refused(self):
        res, code, _ = self.run_cli("prepare", "--ref", "/etc/hosts", "--channel", "qqbot")
        self.assertEqual(code, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["items"], [])

    def test_prepare_needs_mood_or_ref(self):
        res, code, _ = self.run_cli("prepare", "--channel", "qqbot")
        self.assertEqual(code, 1)

    def test_used_bumps(self):
        sid = sorted(self.db()["stickers"])[0]
        before = self.db()["stickers"][sid].get("uses", 0)
        res, code, _ = self.run_cli("used", sid, "s99999")
        self.assertEqual(code, 0, res)
        self.assertEqual(self.db()["stickers"][sid]["uses"], before + 1)
        self.assertIsInstance(self.db()["stickers"][sid]["last_used"], float)

if __name__ == "__main__":
    unittest.main()
