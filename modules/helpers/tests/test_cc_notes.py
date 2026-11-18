"""派活时附笔记（11-02 老林：给帮手也绑定技能）：cc.py send 先问 HH 这件活该附哪几页（hh learn helper），接在给帮手的话后面。
临时 CC_HOME，假的 hh 和 load.py，不起真会话：/opt/homebrew/bin/python3 scripts/test_cc_notes.py"""
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

TMP = tempfile.mkdtemp()
os.environ["CC_HOME"] = TMP
def _hh_env(ws, sessions, tasks=None):
    """What HH hands the helper scripts (docs/contracts/modules.md), inside the test's temp dirs, with made-up names"""
    cfg = {"sessionsDir": str(sessions), **({"tasksDir": str(tasks)} if tasks else {})}
    return {"HH_WORKSPACE": str(ws), "HH_STATE_DIR": str(ws), "HH_MODULE_DIR": str(ws), "HH_MODULE_STATE": str(ws),
            "HH_ROLE_ID": "t", "HH_ME": "阿青", "HH_OWNER": "老林", "HH_TZ": "UTC", "HH_LANG": "zh", "HH_BIN": "/nonexistent/hh",
            "HH_MODULE_CONFIG": json.dumps(cfg)}
os.environ.update(_hh_env(os.path.join(TMP, ".openclaw/workspace"), os.path.join(TMP, "agent-tasks/.cc")))
os.environ["CC_JOBS_DIR"] = os.path.join(TMP, "jobs")
(Path(TMP) / "agent-tasks/.cc").mkdir(parents=True)
SPEC = importlib.util.spec_from_file_location("cc_notes_under_test", Path(__file__).resolve().parent.parent / "scripts" / "cc.py")
cc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cc)

NOTES = ("（我笔记里跟这件事有关的页，动手前先读一遍，里面的做法和踩过的坑照着来：）\n"
         "- /home/aqing/.openclaw/workspace/skills/做视频/avatar/形象怎么做.md：给形象加动作和效果\n"
         "- /home/aqing/.openclaw/workspace/skills/通用/basics/先学现成的.md：先学现成的再动手")


class Done:
    def __init__(self, rc=0, out=""):
        self.returncode, self.stdout, self.stderr = rc, out, ""


class HelperNotes(unittest.TestCase):
    def test_asks_hh_with_worker_and_first_500_chars(self):
        seen = []
        with mock.patch.object(cc.subprocess, "run", side_effect=lambda args, **k: seen.append((args, k)) or Done(0, NOTES + "\n")):
            self.assertEqual(cc.helper_notes("kaichou-l2d", "活" * 800), NOTES)
        args, kw = seen[0]
        self.assertEqual(args, [cc.HH, "learn", "helper", "kaichou-l2d", "活" * 500])
        self.assertEqual(kw["timeout"], cc.HELPER_NOTES_S)

    def test_failures_never_block_the_dispatch(self):
        for effect in (lambda *a, **k: Done(1, "hh learn 不认识：helper"), subprocess.TimeoutExpired("hh", 10), OSError("no hh")):
            with mock.patch.object(cc.subprocess, "run", side_effect=effect):
                self.assertEqual(cc.helper_notes("x", "活"), "")

    def test_brief_names_the_pages(self):
        self.assertEqual(cc.notes_brief(NOTES), "附给它的笔记：形象怎么做、先学现成的")
        self.assertEqual(cc.notes_brief(""), "")
        self.assertEqual(cc.notes_brief("（头）\n- /x/skills/做视频/会长：嘴型.md：简介：带冒号"), "附给它的笔记：会长：嘴型")

    def test_failure_is_logged_for_maintainers_and_anything_odd_still_never_blocks(self):
        logged = []
        with mock.patch.object(cc, "runner_log", side_effect=lambda n, t: logged.append((n, t))):
            with mock.patch.object(cc.subprocess, "run", return_value=Done(1, "")) as r:
                r.return_value.stderr = "connect ENOENT /home/aqing/.hh/hh.sock"
                self.assertEqual(cc.helper_notes("w1", "活"), "")
            with mock.patch.object(cc.subprocess, "run", side_effect=UnicodeDecodeError("utf-8", b"\xff", 0, 1, "bad")):
                self.assertEqual(cc.helper_notes("w2", "活"), "")
        self.assertEqual([n for n, _ in logged], ["w1", "w2"])
        self.assertIn("hh.sock", logged[0][1])


class SendAttachesNotes(unittest.TestCase):
    def setUp(self):
        self.name = "t-" + os.urandom(3).hex()
        self.launched = []
        for target, kw in (("launch", dict(side_effect=lambda n, t: self.launched.append(t))), ("runner_log", {})):
            x = mock.patch.object(cc, target, **kw)
            x.start()
            self.addCleanup(x.stop)
        g = mock.patch.object(cc.subprocess, "run", return_value=Done(0, ""))   # load.py gate 放行
        g.start()
        self.addCleanup(g.stop)

    def send(self, text, **opts):
        out = io.StringIO()
        with redirect_stdout(out):
            cc.cmd_send(self.name, text, opts)
        return out.getvalue()

    def test_new_task_gets_notes_after_the_text_and_she_sees_which(self):
        with mock.patch.object(cc, "helper_notes", return_value=NOTES) as h:
            out = self.send("把会长的嘴照原图重画", model="opus")
        h.assert_called_once_with(self.name, "把会长的嘴照原图重画")
        self.assertEqual(self.launched, ["把会长的嘴照原图重画\n\n" + NOTES])
        self.assertIn("附给它的笔记：形象怎么做、先学现成的", out.strip().splitlines()[-1], "在最后一行里（她常 | tail -1）")

    def test_light_prefix_is_not_part_of_the_question(self):
        with mock.patch.object(cc, "helper_notes", return_value="") as h:
            self.send("改个参数", light=True, model="sonnet")
        h.assert_called_once_with(self.name, "改个参数")
        self.assertTrue(self.launched[0].startswith("【轻量代码轮"))
        self.assertNotIn("附给它的笔记", self.launched[0])

    def test_follow_up_to_a_busy_worker_goes_to_its_inbox_with_notes(self):
        cc.save(self.name, dict(session_id="s", dir=TMP, turn=1, began=True, add_dirs=[], allow=[], pid=os.getpid()))
        with mock.patch.object(cc, "busy", return_value=True), mock.patch.object(cc, "helper_notes", return_value=NOTES):
            out = self.send("插一句：嘴要圆")
        self.assertIn("附给它的笔记", out)
        inbox = Path(cc.p(self.name, "inbox.jsonl")).read_text(encoding="utf-8")
        self.assertIn("插一句：嘴要圆\\n\\n（我笔记里", inbox)

    def test_guest_tasks_get_no_notes(self):
        cc.save(self.name, dict(session_id="s", dir=TMP, turn=1, began=True, add_dirs=[], allow=[], guest="xiaohe"))
        with mock.patch.object(cc, "helper_notes", return_value=NOTES) as h, mock.patch.object(cc, "busy", return_value=False), \
                mock.patch.object(cc, "unread", return_value=([], 0)), mock.patch.object(cc, "mark_read"):
            self.send("接着做")
        h.assert_not_called()
        self.assertEqual(self.launched, ["接着做"])



class ModelLog(unittest.TestCase):
    """新开的会话记一行用了什么模型（工具只记，不替人挑：怎么挑是用它的人自己的规矩，老林 11-04）"""
    def setUp(self):
        self.name = "m-" + os.urandom(3).hex()
        self.launched = []
        for target, kw in (("launch", dict(side_effect=lambda n, t: self.launched.append(t))), ("runner_log", {})):
            x = mock.patch.object(cc, target, **kw)
            x.start()
            self.addCleanup(x.stop)
        g = mock.patch.object(cc.subprocess, "run", return_value=Done(0, ""))
        g.start()
        self.addCleanup(g.stop)

    def send(self, text, **opts):
        out = io.StringIO()
        with redirect_stdout(out):
            cc.cmd_send(self.name, text, opts)
        return out.getvalue()

    def rows(self):
        return [json.loads(x) for x in Path(cc.DB, cc.MODELS_LOG).read_text(encoding="utf-8").splitlines() if json.loads(x)["name"] == self.name]

    def test_no_model_still_dispatches_on_the_default(self):
        with mock.patch.object(cc, "helper_notes", return_value=""):
            out = self.send("把动效渲出来")
        self.assertEqual(len(self.launched), 1, "不写 --model 照样派（不在工具里替人定规矩）")
        self.assertIn("（默认模型）", out)
        self.assertEqual([(r["model"], r["first"]) for r in self.rows()], [(None, "把动效渲出来")])

    def test_logs_the_model_and_her_own_words(self):
        with mock.patch.object(cc, "helper_notes", return_value=NOTES):
            out = self.send("改个参数", model="sonnet", light=True)
        self.assertIn("（sonnet）", out)
        self.assertEqual([(r["model"], r["first"]) for r in self.rows()], [("sonnet", "改个参数")], "轻量前缀、笔记不进记的那一句")

    def test_the_roles_config_picks_the_model_over_the_sender(self):
        with mock.patch.dict(cc.hh.config, {"model": "haiku"}), mock.patch.object(cc, "helper_notes", return_value=""):
            out = self.send("改个参数", model="opus")
        self.assertIn("（haiku）", out)
        self.assertIn("你给的 --model 不算", out)   # the sender hears it; otherwise the other model looks like a fault
        self.assertEqual([r["model"] for r in self.rows()], ["haiku"])


if __name__ == "__main__":
    unittest.main()
