"""cc.py --guest（访客派的 Claude Code 任务，2026-10-26）的测试。全在临时目录里跑：假 claude、假 load.py 闸门，
不碰真的 ~/agent-tasks，不叫醒感官层。守卫规则用真的 leak-guard/guest-cli.mjs（node）。
  /usr/bin/python3 -m unittest test_cc_guest
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REAL_HOME = Path(os.path.expanduser("~"))
LG = REAL_HOME / ".openclaw/extensions/leak-guard"

FAKE_CLAUDE = """#!/bin/sh
# 记下参数和 stdin，假装回了话
out="$CC_TEST_OUT"
printf '%s\\n' "$@" > "$out.args"
cat > "$out.stdin"
echo "做完了"
"""


def make_home():
    # 不放在 ~/.claude 或 /tmp 下面：守卫的文本兜底会把 .claude/ 当私密路径；/tmp 整个能读会让测试变弱
    base = REAL_HOME / "agent-tasks" / "guest-trust" / "sb"
    base.mkdir(parents=True, exist_ok=True)
    home = Path(tempfile.mkdtemp(prefix="cchome-", dir=base))
    ws = home / ".openclaw/workspace"
    (ws / "scripts").mkdir(parents=True)
    (ws / "memory/people").mkdir(parents=True)
    (ws / "memory/anime").mkdir(parents=True)
    (ws / "memory/老林.md").write_text("老林 的私事\n", encoding="utf-8")
    (ws / "memory/anime/a.md").write_text("番\n", encoding="utf-8")
    (ws / "memory/people/xiaohe.md").write_text("# 小禾\n", encoding="utf-8")
    (ws / "memory/people/registry.json").write_text(json.dumps({
        "老林": {"name": "老林", "privacy": "owner", "profile": "memory/老林.md", "sessionKeys": ["agent:main:main"]},
        "xiaohe": {"name": "小禾", "privacy": "guest", "trust": "trusted", "profile": "memory/people/xiaohe.md",
                   "sessionKeys": ["agent:main:direct:+1000000090"], "sharedThreads": []},
        "other": {"name": "别人", "privacy": "guest", "profile": "memory/people/other.md"},
    }, ensure_ascii=False), encoding="utf-8")
    shutil.copy(HERE.parent / "scripts/cc.py", ws / "scripts/cc.py")
    for texts in ("texts.json", "texts.zh.json"):   # the script's sentences travel with it: it reads them from beside its scripts/ directory
        shutil.copy(HERE.parent / texts, ws / texts)
    (home / ".openclaw/_lib").mkdir(parents=True)
    shutil.copy(HERE.parent.parent / "_lib/hh_env.py", home / ".openclaw/_lib/hh_env.py")
    (home / "bin").mkdir()
    (home / "bin/load").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")   # 闸门永远放行
    (home / "bin/load").chmod(0o755)
    node_bin = home / ".local/openclaw-node/bin"
    node_bin.mkdir(parents=True)
    os.symlink(REAL_HOME / ".local/openclaw-node/bin/node", node_bin / "node")
    fake = home / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(0o755)
    (home / "agent-tasks/.cc").mkdir(parents=True)
    return home


def _hh_env(ws, sessions, tasks=None):
    """What HH hands the helper scripts (docs/contracts/modules.md), inside the test's temp dirs, with made-up names"""
    cfg = {"sessionsDir": str(sessions), **({"tasksDir": str(tasks)} if tasks else {})}
    return {"HH_WORKSPACE": str(ws), "HH_STATE_DIR": str(ws), "HH_MODULE_DIR": str(ws), "HH_MODULE_STATE": str(ws),
            "HH_ROLE_ID": "t", "HH_ME": "阿青", "HH_OWNER": "老林", "HH_TZ": "UTC", "HH_LANG": "zh", "HH_BIN": "/nonexistent/hh",
            "HH_MODULE_CONFIG": json.dumps(cfg)}


@unittest.skipUnless(LG.exists(), "needs OpenClaw's leak-guard (guest tasks)")
class CcGuest(unittest.TestCase):
    def setUp(self):
        self.home = make_home()
        self.ws = self.home / ".openclaw/workspace"
        self.cc = self.ws / "scripts/cc.py"
        self.out = self.home / "claude-out"
        self.env = {**os.environ, **_hh_env(self.ws, self.home / "agent-tasks/.cc", self.home / "agent-tasks"),
                    "PATH": f"{self.home / 'bin'}:{os.environ['PATH']}", "CC_HOME": str(self.home), "CC_CLAUDE_BIN": str(self.home / "claude"), "CC_MODE": "p",
                    "CC_SENSES": str(self.home / "no-senses.py"), "CC_EVENTS": str(self.home / "events.jsonl"),
                    "CC_LEAK_GUARD": str(LG), "CC_TEST_OUT": str(self.out),
                    "LEAK_GUARD_WS": str(self.ws), "LEAK_GUARD_TASKS": str(self.home / "agent-tasks"),
                    "LEAK_GUARD_STATE": str(self.home / "state")}

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_cc(self, *args, stdin=None):
        return subprocess.run([sys.executable, "-I", str(self.cc), *args], capture_output=True, text=True, env=self.env,
                              input=stdin, timeout=60)

    def meta(self, name):
        return json.loads((self.home / f"agent-tasks/.cc/{name}.json").read_text(encoding="utf-8"))

    def wait_turn(self):
        for _ in range(100):
            if Path(str(self.out) + ".stdin").exists() and Path(str(self.out) + ".args").exists():
                time.sleep(0.2)
                return
            time.sleep(0.1)
        self.fail("假 claude 没被调用")

    def test_send_rejects_bad_requests(self):
        r = self.run_cc("send", "t1", "做个网页", "--guest", "xiaohe", "--dir", str(self.ws))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("不能指定目录", r.stdout)
        r = self.run_cc("send", "t1", "x", "--guest", "xiaohe", "--add-dir", "/Users")
        self.assertIn("不能指定目录", r.stdout)
        r = self.run_cc("send", "t1", "x", "--guest", "other")   # 不是 trusted
        self.assertIn("不是能派任务的访客", r.stdout)
        r = self.run_cc("send", "t1", "x", "--guest", "老林")
        self.assertIn("不是能派任务的访客", r.stdout)
        (self.home / "agent-tasks/aqing-task").mkdir()
        (self.home / "agent-tasks/.cc/aqing-task.json").write_text(json.dumps({"session_id": "s-aqing", "dir": str(self.home / "agent-tasks/aqing-task")}))
        r = self.run_cc("send", "aqing-task", "x", "--guest", "xiaohe")   # 阿青自己的任务
        self.assertIn("不是 xiaohe 派的任务", r.stdout)
        (self.home / "agent-tasks/old-dir").mkdir()
        r = self.run_cc("send", "old-dir", "x", "--guest", "xiaohe")    # 目录已经有了
        self.assertIn("已经有了", r.stdout)

    def test_guest_send_writes_locked_settings(self):
        r = self.run_cc("send", "web", "帮我做个网页", "--guest", "xiaohe", "--model", "sonnet")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.wait_turn()
        m = self.meta("web")
        self.assertEqual(m["guest"], "xiaohe")
        self.assertEqual(m["dir"], str(self.home / "agent-tasks/web"))
        prompt = Path(str(self.out) + ".stdin").read_text(encoding="utf-8")
        self.assertTrue(prompt.startswith("【这是小禾（老林 的朋友，访客）"), prompt[:80])
        self.assertIn("帮我做个网页", prompt)
        args = Path(str(self.out) + ".args").read_text().split("\n")
        self.assertNotIn("--add-dir", args)
        settings = json.loads(Path(args[args.index("--settings") + 1]).read_text())
        sb = settings["sandbox"]
        self.assertTrue(sb["enabled"])
        self.assertFalse(sb["allowUnsandboxedCommands"])
        self.assertIn(str(self.ws.resolve()), sb["filesystem"]["denyRead"])
        self.assertIn(str((self.home / "agent-tasks/web").resolve()), sb["filesystem"]["allowRead"])
        self.assertTrue(settings["permissions"]["deny"])
        hook = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertIn("_hook guard", hook)

    def test_show_and_ls_only_her_tasks(self):
        for name, guest in (("hers", "xiaohe"), ("mine", None)):
            d = self.home / "agent-tasks" / name
            d.mkdir()
            meta = {"session_id": f"s-{name}", "dir": str(d), "state": "idle", "turn": 1}
            if guest:
                meta["guest"] = guest
            (self.home / f"agent-tasks/.cc/{name}.json").write_text(json.dumps(meta))
        r = self.run_cc("ls", "--guest", "xiaohe")
        self.assertIn("hers", r.stdout)
        self.assertNotIn("mine", r.stdout)
        r = self.run_cc("ls")
        self.assertIn("mine", r.stdout)                      # 阿青自己看全部
        r = self.run_cc("show", "mine", "--guest", "xiaohe")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("没有 xiaohe 派的任务", r.stdout)

    def guard(self, session_id, tool_name, tool_input, cwd):
        r = self.run_cc("_hook", "guard", stdin=json.dumps({"session_id": session_id, "tool_name": tool_name,
                                                              "tool_input": tool_input, "cwd": cwd}))
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["hookSpecificOutput"]["permissionDecisionReason"] if r.stdout.strip() else ""

    def test_guard_hook(self):
        d = self.home / "agent-tasks/hers"
        d.mkdir()
        (self.home / "agent-tasks/.cc/hers.json").write_text(json.dumps({"session_id": "s-hers", "dir": str(d), "guest": "xiaohe"}))
        self.assertEqual(self.guard("s-hers", "Bash", {"command": "npm test"}, str(d)), "")
        self.assertEqual(self.guard("s-hers", "Read", {"file_path": str(self.ws / "memory/anime/a.md")}, str(d)), "")
        self.assertEqual(self.guard("s-hers", "Write", {"file_path": str(d / "index.html"), "content": "x"}, str(d)), "")
        self.assertIn("老林.md", self.guard("s-hers", "Bash", {"command": f"cat {self.ws}/memory/老林.md"}, str(d)))
        self.assertNotEqual(self.guard("s-hers", "Read", {"file_path": str(self.ws / "memory/people/registry.json")}, str(d)), "")
        self.assertNotEqual(self.guard("s-hers", "Write", {"file_path": str(self.ws / "scripts/x.py"), "content": "x"}, str(d)), "")
        self.assertNotEqual(self.guard("s-unknown", "Bash", {"command": "ls"}, str(d)), "")      # 认不出是谁的任务：挡
        r = self.run_cc("_hook", "guard", stdin="不是 json")
        self.assertIn("deny", r.stdout)


if __name__ == "__main__":
    unittest.main()
