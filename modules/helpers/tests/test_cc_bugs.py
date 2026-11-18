"""cc-bugs 报告（2026-10-31）里 ⑥⑦⑧ 修复的回归测试：每条都能在旧代码上复现原 bug。
临时 HOME/DB/JOBS，假的 claude，不起真会话、不叫醒：python3 -m unittest scripts.test_cc_bugs"""
import contextlib
import importlib.util
import io
import os
import json
import subprocess
import sys
import tempfile
import threading
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
SPEC = importlib.util.spec_from_file_location("cc_bugs_under_test", Path(__file__).resolve().parent.parent / "scripts" / "cc.py")
cc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cc)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = self.home / "agent-tasks/.cc"
        self.db.mkdir(parents=True)
        self.jobs = self.home / "jobs"
        self.name, self.sid, self.bid = "fixture", "sid-full", "abcdef12"
        self.meta = dict(session_id=self.sid, bg_id=self.bid, mode="bg", state="running", pid=None,
                         started=time.time() - 300, turn=5, dir=str(self.home), began=True)
        for patch in (mock.patch.object(cc, "HOME", str(self.home)), mock.patch.object(cc, "DB", str(self.db)),
                      mock.patch.object(cc, "JOBS", str(self.jobs)), mock.patch.object(cc, "TASKS", str(self.home / "agent-tasks")),
                      mock.patch.object(cc, "EVENTS", str(self.home / "events.jsonl")),
                      mock.patch.object(cc, "SENSES", str(self.home / "no-senses.py")),
                      mock.patch.object(cc, "event")):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)
        cc.save(self.name, self.meta)

    def job(self, state, sid=None, updated=None):
        """updated：job 文件最后写入的时间（默认现在，即这一轮起来之后写的）。"""
        d = self.jobs / self.bid
        d.mkdir(parents=True, exist_ok=True)
        ts = time.time() if updated is None else updated
        iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + ".%03dZ" % int(ts % 1 * 1000)
        (d / "state.json").write_text(json.dumps({"sessionId": sid or self.sid, "state": state, "updatedAt": iso}))

    def inbox(self, *texts):
        with open(self.db / f"{self.name}.inbox.jsonl", "a") as f:
            for t in texts:
                f.write(json.dumps({"t": "2026-10-31 10:00:00", "text": t}) + "\n")


class BusyChecksRealJob(Base):
    """⑥ 根因 A：以前 bg 模式只要本地 state==running，busy 恒为 True。"""

    def test_ended_job_is_not_busy(self):
        for state in ("done", "stopped"):
            with self.subTest(state=state):
                self.job(state)
                self.assertFalse(cc.busy(cc.load(self.name)))

    def test_unknown_or_unreadable_keeps_local_state(self):
        m = cc.load(self.name)
        self.assertTrue(cc.busy(m))                       # job 文件读不到：不当成死了
        for state in ("working", "blocked", "some-new-state"):
            self.job(state)
            self.assertTrue(cc.busy(m), state)            # 在干活 / 没见过的状态：沿用本地
        self.job("done", sid="another-session")
        self.assertTrue(cc.busy(m))                       # job 属于别的会话：不认领
        (self.jobs / self.bid / "state.json").write_text("{broken")
        self.assertTrue(cc.busy(m))                       # 文件半截：读失败不算死

    def test_fresh_turn_within_grace_is_busy(self):
        self.job("done")                                  # 上一轮留下的 done
        cc.save(self.name, {**self.meta, "started": time.time() - 5})
        self.assertTrue(cc.busy(cc.load(self.name)))

    def test_send_starts_new_turn_instead_of_dead_inbox(self):
        self.job("done")
        self.inbox("上次没送到的话")
        with mock.patch.object(cc, "launch") as launch, \
                mock.patch.object(cc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                contextlib.redirect_stdout(io.StringIO()):
            cc.cmd_send(self.name, "新的一句", {})
        launch.assert_called_once()
        text = launch.call_args.args[1]
        self.assertIn("上次没送到的话", text)
        self.assertIn("新的一句", text)
        self.assertEqual(cc.unread(self.name)[0], [])
        self.assertEqual(len((self.db / f"{self.name}.inbox.jsonl").read_text().splitlines()), 1)   # 没往死会话的 inbox 再写


class EventsFallback(Base):
    def poll(self):
        with contextlib.redirect_stdout(io.StringIO()):
            cc.cmd_events()

    def test_job_ended_but_agent_still_listed_marks_failed(self):
        self.job("stopped")
        with mock.patch.object(cc, "agents", return_value=[dict(id=self.bid, sessionId=self.sid, status="idle", state="weird")]):
            self.poll()
        self.assertEqual(cc.load(self.name)["state"], "failed")
        self.assertEqual(cc.event.call_args.args[1], "failed")

    def test_flaky_agents_query_does_not_fail_a_working_job(self):
        self.job("working")
        with mock.patch.object(cc, "agents", return_value=[]):   # claude agents 超时/出错 → []
            self.poll()
        self.assertEqual(cc.load(self.name)["state"], "running")
        cc.event.assert_not_called()

    def test_really_gone_still_fails(self):
        with mock.patch.object(cc, "agents", return_value=[]):
            self.poll()                                           # 没有 job 文件、agents 也没有
        self.assertEqual(cc.load(self.name)["state"], "failed")


class StaleJobFileAfterOwnStop(Base):
    """#0004（11-01 23:21 hf-motion）：launch_bg 先 claude stop 空闲的旧进程（job 文件被写成 stopped），再 --resume 续上。
    续上的进程第一次请求要 100 秒（上下文大），这期间 job 文件一直是 stop 时写的 stopped；过了 90 秒宽限，
    cmd_events 就按这份旧文件判「后台会话已经结束（busy/working）」标 failed，下一句 send 看它不忙又 stop + 另开一轮，
    正在干活的那一轮被掐掉（0 步）。job 文件在这一轮的进程起来之前写的，不能当这一轮结束的证据。"""

    def setUp(self):
        super().setUp()
        launched = time.time() - 100                      # 100 秒前续上的（过了 BG_GRACE）
        cc.save(self.name, {**self.meta, "started": launched - 2, "bg_since": launched})
        self.job("stopped", updated=launched - 1)         # 我们自己 stop 旧进程时写的
        self.working = [dict(id=self.bid, sessionId=self.sid, status="busy", state="working")]

    def test_stale_stopped_is_still_busy(self):
        self.assertTrue(cc.busy(cc.load(self.name)))

    def test_events_does_not_fail_working_turn(self):
        with mock.patch.object(cc, "agents", return_value=self.working), contextlib.redirect_stdout(io.StringIO()):
            cc.cmd_events()
        self.assertEqual(cc.load(self.name)["state"], "running")
        cc.event.assert_not_called()

    def test_second_interjection_goes_to_inbox_not_new_turn(self):
        with mock.patch.object(cc, "launch") as launch, contextlib.redirect_stdout(io.StringIO()):
            cc.cmd_send(self.name, "第二句", {})
        launch.assert_not_called()
        self.assertEqual(cc.unread(self.name)[0], ["第二句"])

    def test_job_written_after_resume_still_counts(self):
        self.job("stopped")                               # 续上之后真的停了：照旧判结束
        self.assertFalse(cc.busy(cc.load(self.name)))

    def test_launch_bg_records_when_new_process_started(self):
        cc.save(self.name, {**self.meta, "began": True})
        before = time.time()
        out = subprocess.CompletedProcess([], 0, "backgrounded · %s\n" % self.bid, "")
        with mock.patch.object(cc, "bg_entry", return_value=None), \
                mock.patch.object(cc, "agents", return_value=[dict(id=self.bid, sessionId=self.sid)]), \
                mock.patch.object(cc, "write_settings", return_value="s.json"), \
                mock.patch.object(cc, "stuck_at_start", return_value=False), \
                mock.patch.object(cc, "runner_log"), \
                mock.patch.object(cc.subprocess, "run", return_value=out):
            self.assertTrue(cc.launch_bg(self.name, "话"))
        self.assertGreaterEqual(cc.load(self.name)["bg_since"], before)


class StopHookVsSend(Base):
    """⑥ 根因 D：send 判断 busy 之后、写 inbox 之前，Stop 钩子读空 inbox 并置 idle，话就留在 idle 会话的 inbox 里。"""

    def test_send_during_stop_hook_is_not_stranded(self):
        self.job("working")
        real_unread, fired = cc.unread, []
        done = threading.Event()

        def send():
            with mock.patch.object(cc, "launch") as launch, \
                    mock.patch.object(cc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                    contextlib.redirect_stdout(io.StringIO()):
                cc.cmd_send(self.name, "收工瞬间的插话", {})
            self.launched = launch.call_args
            done.set()

        def unread_then_race(name):
            result = real_unread(name)                    # 钩子读到的是空 inbox
            if not fired:
                fired.append(1)
                threading.Thread(target=send, daemon=True).start()
                time.sleep(0.4)                           # 给 send 足够时间在旧代码里先写进 inbox
            return result

        self.launched = None
        ev = json.dumps(dict(session_id=self.sid))
        with mock.patch.object(cc, "unread", side_effect=unread_then_race), \
                mock.patch.object(cc.sys, "stdin", io.StringIO(ev)):
            cc.cmd_hook("stop")
        self.assertTrue(done.wait(5))
        self.assertEqual(cc.load(self.name)["state"], "idle")             # 钩子收了工；send 看到 idle，另开一轮（launch 被 mock）
        self.assertIsNotNone(self.launched, "话被当成插话写进了已收工会话的 inbox")
        self.assertIn("收工瞬间的插话", self.launched.args[1])

    def test_lock_serialises_append_and_stop(self):
        order = []
        with cc.inbox_lock(self.name):
            t = threading.Thread(target=lambda: (cc.inbox_lock(self.name).__enter__(), order.append("got")), daemon=True)
            t.start()
            time.sleep(0.2)
            self.assertEqual(order, [])
        t.join(2)
        self.assertEqual(order, ["got"])


class LaunchBgSessionId(Base):
    """⑦：新会话没传 --session-id，claude 自己分配 id，meta 里的 uuid 是假的，按 session_id 认会话的钩子全认不出来。"""

    def test_new_session_passes_session_id(self):
        cc.save(self.name, {**self.meta, "began": False, "mode": None, "bg_id": None, "session_id": "11111111-2222-3333-4444-555555555555"})
        calls = []

        def fake(args, **k):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, f"backgrounded · {self.bid}\n", "")
        with mock.patch.object(cc, "write_settings", return_value="/x/s.json"), mock.patch.object(cc, "runner_log"), \
                mock.patch.object(cc, "stuck_at_start", return_value=False), mock.patch.object(cc.time, "sleep"), \
                mock.patch.object(cc, "agents", return_value=[dict(id=self.bid, sessionId="11111111-2222-3333-4444-555555555555")]), \
                mock.patch.object(cc.subprocess, "run", side_effect=fake):
            self.assertTrue(cc.launch_bg(self.name, "hi\n"))
        args = calls[0]
        self.assertEqual(args[args.index("--session-id") + 1], "11111111-2222-3333-4444-555555555555")
        self.assertLess(args.index("--session-id"), args.index("--"))
        self.assertNotIn("--resume", args)


if __name__ == "__main__":
    unittest.main()
