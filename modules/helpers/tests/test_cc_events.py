"""Background lifecycle regressions: temporary HOME/DB, synthetic replies, no live worker/wake."""
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

def _hh_env(ws, sessions, tasks=None):
    """What HH hands the helper scripts (docs/contracts/modules.md), inside the test's temp dirs, with made-up names"""
    cfg = {"sessionsDir": str(sessions), **({"tasksDir": str(tasks)} if tasks else {})}
    return {"HH_WORKSPACE": str(ws), "HH_STATE_DIR": str(ws), "HH_MODULE_DIR": str(ws), "HH_MODULE_STATE": str(ws),
            "HH_ROLE_ID": "t", "HH_ME": "阿青", "HH_OWNER": "老林", "HH_TZ": "UTC", "HH_LANG": "zh", "HH_BIN": "/nonexistent/hh",
            "HH_MODULE_CONFIG": json.dumps(cfg)}


os.environ.update(_hh_env(tempfile.mkdtemp(), tempfile.mkdtemp()))
SPEC = importlib.util.spec_from_file_location("cc_events_under_test", Path(__file__).resolve().parent.parent / "scripts" / "cc.py")
cc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cc)
REAL_EVENT = cc.event


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


class BackgroundEvents(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = self.home / "agent-tasks/.cc"
        self.db.mkdir(parents=True)
        self.sid, self.bid, self.name = "fixture-session", "abcdef12", "fixture"
        self.started = time.time() - 180
        self.meta = dict(session_id=self.sid, bg_id=self.bid, mode="bg", state="running", pid=None,
                         started=self.started, turn=55, dir=str(self.home), began=True)
        self.cur = dict(sessionId=self.sid, id=self.bid, status="idle", state="blocked")
        self.job = self.home / ".claude/jobs" / self.bid / "state.json"
        self.job.parent.mkdir(parents=True)
        self.transcript = self.home / ".claude/projects/fixture" / (self.sid + ".jsonl")
        self.transcript.parent.mkdir(parents=True)
        self.patches = [mock.patch.object(cc, "HOME", str(self.home)), mock.patch.object(cc, "DB", str(self.db)),
                        mock.patch.object(cc, "EVENTS", str(self.home / "events.jsonl")),
                        mock.patch.object(cc, "SENSES", str(self.home / "no-senses.py")),
                        mock.patch.object(cc, "agents", side_effect=lambda: [copy.deepcopy(self.cur)]),
                        mock.patch.object(cc, "event")]
        for patch in self.patches:
            patch.start()
        self.addCleanup(self.tmp.cleanup)
        for patch in self.patches:
            self.addCleanup(patch.stop)
        cc.save(self.name, self.meta)
        self.evidence()

    def evidence(self, job_time=None, reply_time=None, job_sid=None, job_state="blocked"):
        self.job.write_text(json.dumps(dict(sessionId=job_sid or self.sid, state=job_state,
                                            updatedAt=iso(job_time if job_time is not None else self.started + 30))))
        self.transcript.write_text(json.dumps(dict(type="user", timestamp=iso(self.started),
                                                   message=dict(content="fixture request"))) + "\n" +
                                   json.dumps(dict(type="assistant", timestamp=iso(reply_time if reply_time is not None else self.started + 29),
                                                   message=dict(content=[dict(type="text", text="需要确认，尚未执行")]))))

    def poll(self):
        with contextlib.redirect_stdout(io.StringIO()):
            cc.cmd_events()

    def test_blocked_once_and_cli_classification(self):
        self.poll()
        cc.event.assert_called_once_with(self.name, "needs_input", "等待确认（尚未完成）：需要确认，尚未执行", body="需要确认，尚未执行")
        self.assertEqual(cc.load(self.name)["state"], "needs_input")
        self.assertFalse(cc.busy(cc.load(self.name)))
        self.poll()
        cc.event.assert_called_once()
        # A delayed Stop hook must not relabel this waiting result as successful/done.
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(dict(session_id=self.sid)))):
            cc.cmd_hook("stop")
        self.assertEqual(cc.load(self.name)["state"], "needs_input")
        cc.event.assert_called_once()

    def test_waiting_event_cli_transport(self):
        # Exercise the real append/JSON command path, but only with the temporary DB
        # and an explicitly absent senses executable: no notification can be launched.
        with mock.patch.object(cc, "event", REAL_EVENT):
            self.poll()
        env = {**os.environ, **_hh_env(self.home, self.db), "CC_HOME": str(self.home), "CC_EVENTS": str(self.home / "events.jsonl"),
               "CC_SENSES": str(self.home / "no-senses.py")}
        script = str(Path(__file__).resolve().parent.parent / "scripts" / "cc.py")
        for command in (("ls",), ("show", self.name)):
            result = subprocess.run([sys.executable, "-I", script, *command], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("等待确认", result.stdout)
            self.assertNotIn("正在干活", result.stdout)
        result = subprocess.run([sys.executable, "-I", script, "events"], env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        emitted = json.loads(result.stdout)
        self.assertIn("等待确认（尚未完成）", emitted["text"])
        self.assertEqual(emitted["body"], "需要确认，尚未执行")
    def test_done_preserved(self):
        self.cur["state"] = "done"
        self.poll()
        self.assertEqual(cc.load(self.name)["state"], "idle")
        self.assertEqual(cc.event.call_args.args[1], "done")
        self.poll()
        cc.event.assert_called_once()

    def test_working_and_unknown_stay_silent(self):
        for state in ("working", "running", "new-unknown-state"):
            with self.subTest(state=state):
                self.cur.update(state=state, status="running")
                self.poll()
                self.assertEqual(cc.load(self.name)["state"], "running")
                cc.event.assert_not_called()

    def test_stale_or_missing_evidence_stays_silent(self):
        for kwargs in (dict(job_time=self.started - 1), dict(reply_time=self.started - 1),
                       dict(job_sid="wrong-session"), dict(job_state="working")):
            with self.subTest(kwargs=kwargs):
                self.evidence(**kwargs)
                self.poll()
                cc.event.assert_not_called()
                self.assertEqual(cc.load(self.name)["state"], "running")
        self.job.unlink()
        self.poll()
        cc.event.assert_not_called()

    def test_wrong_job_id_stays_silent(self):
        self.cur["id"] = "deadbeef"
        self.poll()
        cc.event.assert_not_called()

    def test_stopped_stays_stopped(self):
        cc.save(self.name, {**self.meta, "state": "stopped"})
        self.poll()
        self.assertEqual(cc.load(self.name)["state"], "stopped")
        cc.event.assert_not_called()

    def test_stop_or_supersede_during_slow_query(self):
        for change in (dict(state="stopped"), dict(turn=56, started=self.started + 120), dict(session_id="new-session")):
            with self.subTest(change=change):
                cc.save(self.name, self.meta)
                def query():
                    cc.save(self.name, {**self.meta, **change})
                    return [self.cur]
                with mock.patch.object(cc, "agents", side_effect=query):
                    self.poll()
                cc.event.assert_not_called()
                self.assertEqual(cc.load(self.name), {**self.meta, **change})

    def test_stop_immediately_before_guarded_save(self):
        original_save = cc.save
        def racing_save(name, meta, expected=None):
            if expected is not None:
                original_save(name, {**self.meta, "state": "stopped"})
            return original_save(name, meta, expected=expected)
        with mock.patch.object(cc, "save", side_effect=racing_save):
            self.poll()
        self.assertEqual(cc.load(self.name)["state"], "stopped")
        cc.event.assert_not_called()

    def test_stop_after_save_before_event(self):
        original_save = cc.save
        def racing_save(name, meta, expected=None):
            saved = original_save(name, meta, expected=expected)
            if expected is not None:
                original_save(name, {**meta, "state": "stopped"})
            return saved
        with mock.patch.object(cc, "save", side_effect=racing_save):
            self.poll()
        self.assertEqual(cc.load(self.name)["state"], "stopped")
        cc.event.assert_not_called()

    def test_resume_then_new_blocked_emits_once_per_round(self):
        self.poll()
        previous = cc.load(self.name)
        def launch(name, prompt):
            self.assertEqual(name, self.name)
            cc.save(name, {**previous, "state": "running", "turn": 56, "started": self.started + 90})
        with mock.patch.object(cc, "launch", side_effect=launch) as launcher, mock.patch.object(cc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "ok", "")):
            with contextlib.redirect_stdout(io.StringIO()):
                cc.cmd_send(self.name, "确认了，继续", {})
            launcher.assert_called_once()
        self.assertFalse((self.db / (self.name + ".inbox.jsonl")).exists())
        self.poll()  # old blocked + old final must not count in round56
        self.assertEqual(cc.event.call_count, 1)
        self.evidence(job_time=self.started + 110, reply_time=self.started + 109)
        self.poll()
        self.poll()
        self.assertEqual(cc.event.call_count, 2)
        self.assertEqual(cc.load(self.name)["state"], "needs_input")


class IdleClose(unittest.TestCase):
    """11-17: eight helpers done for hours kept their background processes, 2.3GB swapped out on a 16GB machine"""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "db"
        self.db.mkdir()
        self.ran = []
        for patch in (mock.patch.object(cc, "DB", str(self.db)), mock.patch.object(cc, "runner_log"),
                      mock.patch.object(cc.subprocess, "run", side_effect=lambda a, **k: self.ran.append(a))):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)

    def helper(self, name, **kw):
        cc.save(name, dict(dict(session_id="s-" + name, bg_id="b-" + name, mode="bg", state="idle", ended=time.time() - 16 * 60), **kw))

    def test_done_long_enough_is_closed_once_and_resumes_later(self):
        self.helper("long")
        self.helper("fresh", ended=time.time() - 5 * 60)
        self.helper("asking", state="needs_input")
        self.helper("plain", mode=None)
        cc.cmd_events()
        self.assertEqual(self.ran, [[cc.CLAUDE, "stop", "b-long"]], "only the one done for 15 minutes, in the background")
        self.assertEqual(cc.load("long")["state"], "idle", "still idle: the next send resumes it from its record")
        cc.cmd_events()
        self.assertEqual(len(self.ran), 1, "closed once for this idle spell")
        cc.save("long", dict(cc.load("long"), ended=time.time() - 20 * 60))   # an older end than its close: the same idle spell
        cc.cmd_events()
        self.assertEqual(len(self.ran), 1, "its close came after that turn ended")
        cc.save("long", dict(cc.load("long"), ended=time.time() - 16 * 60, closed=time.time() - 17 * 60))
        cc.cmd_events()
        self.assertEqual(self.ran[-1], [cc.CLAUDE, "stop", "b-long"], "a later idle spell closes it again")

    def test_a_send_in_between_wins(self):
        self.helper("raced")
        real = cc.save
        def send_first(name, m, expected=None):   # a send starts a new turn between this look and its close
            if expected is not None:
                real(name, dict(cc.load(name), state="running", bg_id="b-new"))
            return real(name, m, expected)
        with mock.patch.object(cc, "save", side_effect=send_first):
            cc.close_idle("raced", cc.load("raced"))
        self.assertEqual(self.ran, [], "nothing stopped")
        self.assertEqual(cc.load("raced")["state"], "running", "the send's turn is left as it is")


if __name__ == "__main__":
    unittest.main()
