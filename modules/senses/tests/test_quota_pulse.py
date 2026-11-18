"""quota_pulse.py 的测试"""
import datetime, os, sys, tempfile, unittest
os.environ["QUOTA_HOME"] = tempfile.mkdtemp()
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "scripts"), os.path.join(HERE, "..", "..", "_lib")]
# run by itself: what HH hands the scripts (docs/contracts/modules.md) points at an empty temp dir, made-up names
_tmp = tempfile.mkdtemp(prefix="senses-env-")
for _k, _v in dict({k: _tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                   HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="Australia/Melbourne", HH_LANG="zh", HH_BIN=_tmp + "/no-hh").items():
    os.environ.setdefault(_k, _v)
import quota_pulse as Q  # noqa: E402

def at(d, h, m=0):
    return datetime.datetime(2026, 10, d, h, m, tzinfo=Q.TZ)

def fake(used, reset_in_min, week=20):
    return lambda st, ts: {"used": used, "reset": ts + reset_in_min * 60, "week": week}

class T(unittest.TestCase):
    def setUp(self):
        if os.path.exists(Q.STATE): os.remove(Q.STATE)

    def test_nudges_once_per_window_when_lots_left(self):
        f = fake(20, 60)
        n = at(22, 14)
        out = Q.pulse(n, lambda st, ts: {"used": 20, "reset": n.timestamp() + 3600, "week": 20})
        self.assertEqual(len(out), 1); self.assertIn("才用了 20%", out[0]["text"])
        out2 = Q.pulse(n + datetime.timedelta(minutes=5), lambda st, ts: {"used": 22, "reset": n.timestamp() + 3600, "week": 20})
        self.assertEqual(out2, [])

    def test_no_nudge_when_used_a_lot_or_far_from_reset_or_week_high(self):
        n = at(22, 14)
        self.assertEqual(Q.pulse(n, fake(70, 30)), [])
        self.assertEqual(Q.pulse(n, fake(10, 200)), [])
        self.assertEqual(Q.pulse(n, fake(10, 30, week=90)), [])

    def test_quiet_at_night_except_bedtime(self):
        self.assertEqual(Q.pulse(at(23, 3), fake(10, 30)), [])     # 3 点
        out = Q.pulse(at(23, 0, 40), fake(80, 300))                 # 0:40 睡前
        self.assertEqual([e["id"].split(":")[1] for e in out], ["bedtime"])
        self.assertEqual(Q.pulse(at(23, 0, 50), fake(80, 300)), [])  # 一晚只一次

    def test_unreadable_usage_is_silent(self):
        self.assertEqual(Q.pulse(at(22, 14), lambda st, ts: None), [])

if __name__ == "__main__":
    unittest.main()
