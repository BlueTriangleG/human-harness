"""额度账本 budget.py 的单元测试（2026-11-02：读法变了以后旧数用了一整天、还拿它催我多花）。

全在临时目录里跑，不会真的查额度：
  /opt/homebrew/bin/python3 scripts/test_budget.py
"""
import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "scripts"), os.path.join(HERE, "..", "..", "_lib")]
# run by itself: what HH hands the scripts (docs/contracts/modules.md) points at an empty temp dir, made-up names
_tmp = tempfile.mkdtemp(prefix="senses-env-")
for _k, _v in dict({k: _tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                   HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="Australia/Melbourne", HH_LANG="zh", HH_BIN=_tmp + "/no-hh").items():
    os.environ.setdefault(_k, _v)

import budget as B  # noqa: E402


def event(**wins):
    return json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": wins}})


class Parse(unittest.TestCase):
    def test_only_seven_day_window_still_reads(self):
        out = "\n".join([json.dumps({"type": "system"}), event(seven_day={"utilization": 0.71, "resetsAt": 1793710800})])
        r = B.parse(out)
        self.assertEqual(r["week"], 71.0)
        self.assertEqual(r["week_reset"], 1793710800)
        self.assertIsNone(r["five"])

    def test_windows_split_across_events(self):
        out = "\n".join([event(five_hour={"utilization": 0.12, "resetsAt": 1}), event(seven_day={"utilization": 0.5, "resetsAt": 2})])
        r = B.parse(out)
        self.assertEqual((r["five"], r["week"]), (12.0, 50.0))

    def test_no_seven_day_is_no_reading(self):
        self.assertIsNone(B.parse(event(five_hour={"utilization": 0.1, "resetsAt": 1})))
        self.assertIsNone(B.parse("not json\n"))


class Stale(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.p = [mock.patch.object(B, "DIR", self.tmp), mock.patch.object(B, "SNAPS", os.path.join(self.tmp, "snaps.jsonl")),
                  mock.patch.object(B, "STATE", os.path.join(self.tmp, "pulse.json")), mock.patch.object(B, "running_cc", lambda: [])]
        for x in self.p:
            x.start()

    def tearDown(self):
        for x in self.p:
            x.stop()

    def write_snap(self, age, week=56.0):
        now = time.time()
        with open(B.SNAPS, "w") as f:
            f.write(json.dumps({"five": 1.0, "five_reset": now + 3600, "week": week, "week_reset": now + 2 * 86400,
                                "ts": int(now - age), "t": "旧"}) + "\n")

    def test_failed_probe_marks_the_old_reading(self):
        self.write_snap(age=7200)
        with mock.patch.object(B, "probe", lambda: None):
            r = B.snap(force=True)
        self.assertTrue(r["stale"])
        self.assertEqual(r["week"], 56.0)

    def test_pulse_does_not_nudge_on_a_stale_reading(self):
        self.write_snap(age=7200, week=10.0)       # 落后很多，但这数是两小时前的
        buf = io.StringIO()
        with mock.patch.object(B, "probe", lambda: None), mock.patch.object(B, "now", lambda: B.datetime.datetime(2026, 11, 2, 12, 0, tzinfo=B.TZ)), redirect_stdout(buf):
            B.pulse()
        self.assertEqual(buf.getvalue(), "")

    def test_pulse_still_nudges_on_a_fresh_reading_without_five_hour(self):
        now = time.time()
        fresh = {"five": None, "five_reset": None, "week": 10.0, "week_reset": now + 2 * 86400}
        buf = io.StringIO()
        with mock.patch.object(B, "probe", lambda: dict(fresh)), mock.patch.object(B, "now", lambda: B.datetime.datetime(2026, 11, 2, 12, 0, tzinfo=B.TZ)), redirect_stdout(buf):
            B.pulse()
        out = json.loads(buf.getvalue())
        self.assertIn("额度在浪费", out["text"])
        self.assertIn("5h 窗口 ?", out["body"])

    def test_status_and_day_survive_missing_five_hour(self):
        now = time.time()
        with open(B.SNAPS, "w") as f:
            for i, (five, week) in enumerate([(1.0, 50.0), (None, 51.0)]):
                f.write(json.dumps({"five": five, "five_reset": None, "week": week, "week_reset": now + 86400,
                                    "ts": int(now - 600 + i * 300), "t": "2026-11-02 12:0" + str(i)}) + "\n")
        buf = io.StringIO()
        with mock.patch.object(B, "probe", lambda: None), redirect_stdout(buf):
            B.status()
            B.day()
        self.assertIn("5小时窗口：?", buf.getvalue())
        self.assertIn("7d +1.0  5h ?", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
