"""goals.py 的测试：python3 -m unittest test_goals（在 tests 目录里）"""
import datetime, io, json, os, sys, tempfile, time, unittest
from contextlib import redirect_stdout
from unittest import mock

TMP = tempfile.mkdtemp()
HERE = os.path.dirname(os.path.abspath(__file__))
# The module environment HH gives the script (docs/contracts/modules.md), for a made-up role
os.environ.update({"HH_WORKSPACE": os.path.join(TMP, "ws"), "HH_STATE_DIR": TMP, "HH_MODULE_DIR": os.path.dirname(HERE),
                   "HH_MODULE_STATE": TMP, "HH_ROLE_ID": "test", "HH_ME": "阿青", "HH_OWNER": "老林",
                   "HH_TZ": "Australia/Melbourne", "HH_LANG": "zh", "HH_BIN": "hh", "HH_MODULE_CONFIG": "{}"})
sys.path[:0] = [os.path.join(os.path.dirname(HERE), "scripts"), os.path.join(os.path.dirname(HERE), "..", "_lib")]
import goals as G  # noqa: E402


def run(*args):
    buf = io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["goals.py", *args]), redirect_stdout(buf):
        try:
            G.main()
        except SystemExit as e:
            code = e.code or 0
    return code, buf.getvalue()


def at(hour, minute=0):
    return datetime.datetime(2026, 10, 22, hour, minute, tzinfo=G.TZ)


class Goals(unittest.TestCase):
    def setUp(self):
        for f in (G.DATA, G.MD):
            if os.path.exists(f):
                os.remove(f)

    def add(self, level, title, *extra):
        return run("add", level, title, "--why", "想要", "--done-when", "做到某样", *extra)

    def test_add_needs_why_and_done_when(self):
        code, out = run("add", "today", "随便")
        self.assertEqual(code, 1)
        self.assertIn("--done-when", out)

    def test_levels_and_parent_rules(self):
        self.add("dream", "做自己的动画")
        self.add("long", "学会分镜", "--parent", "g1")
        self.add("short", "画完第一个分镜", "--parent", "g2")
        code, out = self.add("long", "错挂", "--parent", "g3")
        self.assertEqual(code, 1)
        self.assertIn("梦想", out)
        code, out = self.add("dream", "梦想不能有上级", "--parent", "g1")
        self.assertIn("梦想没有上级", out)

    def test_max_three_today(self):
        for i in range(3):
            self.assertEqual(self.add("today", f"t{i}")[0], 0)
        code, out = self.add("today", "第四个")
        self.assertEqual(code, 1)
        self.assertIn("已经有 3 个", out)
        run("done", "g1", "对照完成标准做到了")
        self.assertEqual(self.add("today", "第四个")[0], 0)

    def test_done_requires_reason_and_she_decides(self):
        self.add("short", "s")
        self.assertEqual(run("done", "g1")[0], 1)
        run("done", "g1", "我看过了，达成")
        g = G.load()["goals"][0]
        self.assertEqual(g["status"], "done")
        self.assertIn("达成", g["closed_note"])
        self.assertIn("最近收尾的", open(G.MD).read())

    def test_pulse_after_gap_then_not_again_until_gap(self):
        self.add("today", "推进看番眼睛")
        d = G.load(); d["goals"][0]["created_ts"] = time.time() - 50 * 60; G.save(d)
        with mock.patch.object(G, "now", return_value=at(14)), mock.patch.object(G, "today", return_value="2026-10-22"):
            d = G.load(); d["goals"][0]["day"] = "2026-10-22"; G.save(d)
            _, out = run("pulse")
            self.assertEqual(len(out.strip().splitlines()), 1)
            ev = json.loads(out)
            self.assertIn("怎样算完成：做到某样", ev["body"])
            self.assertTrue(ev["id"].startswith("goal:g1:2026-10-22:1"))
            _, out2 = run("pulse")
            self.assertEqual(out2.strip(), "")

    def test_pulse_skips_night_recent_log_and_busy_cc(self):
        self.add("today", "x", "--link", "cc:anime")
        d = G.load(); g = d["goals"][0]; g["created_ts"] = time.time() - 3600; g["day"] = "2026-10-22"; G.save(d)
        with mock.patch.object(G, "today", return_value="2026-10-22"):
            with mock.patch.object(G, "now", return_value=at(1, 30)):
                self.assertEqual(run("pulse")[1].strip(), "")  # 1 点到 8 点不叫
            with mock.patch.object(G, "now", return_value=at(7, 50)):
                self.assertEqual(run("pulse")[1].strip(), "")
            with mock.patch.object(G, "now", return_value=at(14)), mock.patch.object(G, "cc_running", return_value=True):
                self.assertEqual(run("pulse")[1].strip(), "")
            run("log", "g1", "刚推进了")
            with mock.patch.object(G, "now", return_value=at(14)), mock.patch.object(G, "cc_running", return_value=False):
                self.assertEqual(run("pulse")[1].strip(), "")

    def test_pulse_daily_cap(self):
        self.add("today", "x")
        with mock.patch.object(G, "now", return_value=at(14)), mock.patch.object(G, "today", return_value="2026-10-22"):
            n = 0
            for _ in range(10):
                d = G.load(); g = d["goals"][0]; g["day"] = "2026-10-22"
                g["created_ts"] = 0; g["last_pulse"] = time.time() - 3600; G.save(d)
                n += len(run("pulse")[1].strip().splitlines())
            self.assertEqual(n, G.PULSE_MAX_PER_DAY)

    def test_yesterday_today_goal_flagged_and_carry(self):
        self.add("today", "昨天的")
        d = G.load(); d["goals"][0]["day"] = "2000-01-01"; G.save(d)
        b = G.brief(G.load())
        self.assertIn("还没收尾", b)
        _, out = run("pulse")
        self.assertEqual(out.strip(), "")  # 不是今天的不催
        run("carry", "g1")
        self.assertEqual(G.load()["goals"][0]["day"], G.today())

    def test_night_until_1am_is_same_day_and_pulses(self):
        with mock.patch.object(G, "now", return_value=datetime.datetime(2026, 10, 23, 0, 40, tzinfo=G.TZ)):
            self.assertEqual(G.today(), "2026-10-22")  # 00:40 还算前一天
            self.add("today", "熬夜做完")
            d = G.load(); d["goals"][0]["created_ts"] = time.time() - 3600; G.save(d)
            self.assertEqual(len(run("pulse")[1].strip().splitlines()), 1)  # 夜里 1 点前照样叫
        with mock.patch.object(G, "now", return_value=datetime.datetime(2026, 10, 23, 4, 10, tzinfo=G.TZ)):
            self.assertEqual(G.today(), "2026-10-23")

    def test_brief_empty_and_levels(self):
        self.assertIn("一个目标都没有", G.brief(G.load()))
        self.add("dream", "梦")
        self.add("today", "今天的事")
        b = G.brief(G.load())
        self.assertIn("今日：", b)
        self.assertIn("梦想：g1 梦", b)

    def test_topic(self):
        code, out = run("topic", "add", "today", "写", "周报", "--why", "周一要交", "--done-when", "发出去")
        self.assertEqual(json.loads(out), {"title": "写 周报", "why": "周一要交"})
        self.add("today", "今天的事")
        self.assertEqual(json.loads(run("topic", "log", "g1", "推进了")[1])["title"], "今天的事")
        self.assertIsNone(json.loads(run("topic", "log", "g9", "x")[1]))
        self.assertIsNone(json.loads(run("topic", "ls")[1]))


if __name__ == "__main__":
    unittest.main()
