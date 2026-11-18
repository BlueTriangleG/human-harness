"""cc_inbox_hook.py：按 session_id 找会话，不信 CC_SESSION（10-29：备用进程的环境变量是旧的，插话被别的会话读走）。
临时 CC_DB，真跑钩子脚本：/opt/homebrew/bin/python3 scripts/test_cc_hook.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

def _hh_env(ws, sessions, tasks=None):
    """What HH hands the helper scripts (docs/contracts/modules.md), inside the test's temp dirs, with made-up names"""
    cfg = {"sessionsDir": str(sessions), **({"tasksDir": str(tasks)} if tasks else {})}
    return {"HH_WORKSPACE": str(ws), "HH_STATE_DIR": str(ws), "HH_MODULE_DIR": str(ws), "HH_MODULE_STATE": str(ws),
            "HH_ROLE_ID": "t", "HH_ME": "阿青", "HH_OWNER": "老林", "HH_TZ": "UTC", "HH_LANG": "zh", "HH_BIN": "/nonexistent/hh",
            "HH_MODULE_CONFIG": json.dumps(cfg)}


HOOK = str(Path(__file__).resolve().parent.parent / "scripts" / "cc_inbox_hook.py")


class Hook(unittest.TestCase):
    def setUp(self):
        self.db = Path(tempfile.mkdtemp())
        self.make("alpha", "sid-alpha")
        self.make("beta", "sid-beta")

    def make(self, name, sid):
        (self.db / f"{name}.json").write_text(json.dumps({"session_id": sid, "mode": "bg"}), encoding="utf-8")
        (self.db / f"{name}.settings.json").write_text(json.dumps({"hooks": {}, "session_id": sid}), encoding="utf-8")

    def send(self, name, text, t="2026-10-29 11:02:05"):
        with open(self.db / f"{name}.inbox.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": t, "text": text}, ensure_ascii=False) + "\n")

    def cursor(self, name):
        try:
            return int((self.db / f"{name}.cursor").read_text().strip())
        except OSError:
            return None

    def run_hook(self, ev, env_session=None):
        env = {"PATH": os.environ["PATH"], "CC_DB": str(self.db), **_hh_env(self.db, self.db)}
        if env_session:
            env["CC_SESSION"] = str(self.db / env_session)
        r = subprocess.run(["/usr/bin/python3", "-I", HOOK], input=json.dumps(ev), capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"] if r.stdout.strip() else None

    def log(self, name):
        p = self.db / f"{name}.hooklog"
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []

    def test_wrong_env_does_not_steal_other_sessions_inbox(self):      # 10-29 的 bug 本身
        self.send("alpha", "给 alpha 的话")
        out = self.run_hook({"session_id": "sid-beta", "tool_name": "Bash"}, env_session="alpha")   # beta 的进程，环境变量却是 alpha
        self.assertIsNone(out)
        self.assertIsNone(self.cursor("alpha"))                         # alpha 的游标没被动
        self.assertEqual(self.log("beta")[0]["by"], "session_id")

    def test_own_session_gets_own_messages_even_with_wrong_env(self):
        self.send("beta", "给 beta 的话")
        out = self.run_hook({"session_id": "sid-beta", "tool_name": "Bash"}, env_session="alpha")
        self.assertIn("给 beta 的话", out)
        self.assertIn("阿青插话 11:02", out)
        self.assertEqual(self.cursor("beta"), 1)
        last = self.log("beta")[-1]
        self.assertEqual((last["new"], last["env"]), (1, "alpha"))      # 日志里留着环境变量和实际会话对不上的证据

    def test_right_env_still_works_and_second_call_empty(self):
        self.send("alpha", "一句")
        self.assertIn("一句", self.run_hook({"session_id": "sid-alpha"}, env_session="alpha"))
        self.assertIsNone(self.run_hook({"session_id": "sid-alpha"}, env_session="alpha"))
        self.assertEqual(self.cursor("alpha"), 1)

    def test_two_sessions_each_get_only_their_own(self):
        self.send("alpha", "A")
        self.send("beta", "B")
        self.assertIn("B", self.run_hook({"session_id": "sid-beta"}, env_session="alpha"))
        self.assertIn("A", self.run_hook({"session_id": "sid-alpha"}, env_session="alpha"))
        self.assertEqual((self.cursor("alpha"), self.cursor("beta")), (1, 1))

    def test_unmatched_session_touches_nothing_and_is_logged(self):
        self.send("alpha", "A")
        self.assertIsNone(self.run_hook({"session_id": "sid-stranger", "tool_name": "Bash"}, env_session="alpha"))
        self.assertIsNone(self.cursor("alpha"))
        self.assertEqual(self.log("_unmatched")[0]["skip"], "unmatched")

    def test_subagent_events_skipped(self):
        self.send("alpha", "A")
        self.assertIsNone(self.run_hook({"session_id": "sid-alpha", "agent_id": "x1"}))
        self.assertIsNone(self.cursor("alpha"))
        self.assertEqual(self.log("alpha")[0]["skip"], "agent")

    def test_no_session_id_falls_back_to_env(self):
        self.send("alpha", "A")
        self.assertIn("A", self.run_hook({"tool_name": "Bash"}, env_session="alpha"))

    def test_no_session_id_no_env_is_silent(self):
        self.assertIsNone(self.run_hook({"tool_name": "Bash"}))
        self.assertEqual(list(self.db.glob("*.hooklog")), [])

    def test_settings_and_corrupt_json_files_ignored(self):
        (self.db / "junk.json").write_text("{bad", encoding="utf-8")
        (self.db / "events.json").write_text("[1,2]", encoding="utf-8")
        self.send("alpha", "A")
        self.assertIn("A", self.run_hook({"session_id": "sid-alpha"}))

    def test_hooklog_records_every_call(self):
        self.run_hook({"session_id": "sid-alpha", "tool_name": "Read"})
        self.send("alpha", "A")
        self.run_hook({"session_id": "sid-alpha", "tool_name": "Bash"})
        rows = self.log("alpha")
        self.assertEqual([(r["tool"], r.get("new")) for r in rows], [("Read", 0), ("Bash", 1)])

    def test_output_carries_session_token_when_known(self):
        m = json.loads((self.db / "alpha.json").read_text())
        m["token"] = "a1b2c3"
        (self.db / "alpha.json").write_text(json.dumps(m), encoding="utf-8")
        self.send("alpha", "带口令的话")
        out = self.run_hook({"session_id": "sid-alpha"})
        self.assertIn("【阿青插话 11:02 #a1b2c3】带口令的话", out)
        self.assertNotIn("a1b2c3", json.dumps(self.log("alpha")))             # hooklog 里不记口令，只记有没有

    def test_output_untagged_for_session_without_token(self):                # 访客任务 / 还没续上过的老会话
        self.send("alpha", "老会话的话")
        out = self.run_hook({"session_id": "sid-alpha"})
        self.assertIn("【阿青插话 11:02】老会话的话", out)
        self.assertNotIn("#", out.split("】")[0])

    def test_each_session_uses_its_own_token(self):
        for n, t in (("alpha", "aaaaaa"), ("beta", "bbbbbb")):
            m = json.loads((self.db / f"{n}.json").read_text())
            m["token"] = t
            (self.db / f"{n}.json").write_text(json.dumps(m), encoding="utf-8")
            self.send(n, "x")
        self.assertIn("#bbbbbb", self.run_hook({"session_id": "sid-beta"}, env_session="alpha"))
        self.assertIn("#aaaaaa", self.run_hook({"session_id": "sid-alpha"}, env_session="beta"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
