#!/usr/bin/env python3
"""bili_events.py 私信（dm 模式）的测试，不连 B站、不碰真实状态：python3 modules/bilibili/tests/test_bili_events.py
（只用标准库和感官模块，不用插件的 Python 环境；tests/run.sh 也跑它）
用一个假的 bili 可执行文件（BILI_BIN）喂会话列表，真实跑 bili_events.py + senses.collect 看去重/游标。"""
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr

TMP = tempfile.mkdtemp()
# the module environment (docs/contracts/modules.md) for a made-up role, all inside the temp dir: never a live role's state
MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # modules/bilibili
MODULES = os.path.dirname(MOD)
os.environ.update(HH_WORKSPACE=os.path.join(TMP, "ws"), HH_STATE_DIR=os.path.join(TMP, "state"), HH_MODULE_DIR=MOD,
                  HH_MODULE_STATE=os.path.join(TMP, "state", "modules", "bilibili"), HH_ROLE_ID="t", HH_ME="阿青",
                  HH_OWNER="老林", HH_TZ="UTC", HH_LANG="zh", HH_BIN=os.path.join(TMP, "no-hh"), HH_MODULE_CONFIG="{}")
for d in (os.environ["HH_WORKSPACE"], os.environ["HH_MODULE_STATE"]):
    os.makedirs(d, exist_ok=True)
os.environ["BILI_DM_HEALTH"] = os.path.join(TMP, "health.json")
HERE = os.path.join(MOD, "scripts")   # bili_events.py
sys.path[:0] = [HERE, os.path.join(MODULES, "senses", "scripts"), os.path.join(MODULES, "_lib")]
import bili_events as B  # noqa: E402
import senses as S  # noqa: E402

NOW = time.time()
FAKE = os.path.join(TMP, "fake_bili")
FIX = os.path.join(TMP, "fixture.json")
with open(FAKE, "w") as fh:     # 读 fixture.json：{"rc": 0, "stdout": "..."}，原样吐出来
    fh.write('#!/bin/sh\npython3 -I -c \'import json,sys;d=json.load(open(sys.argv[1]));sys.stdout.write(d["stdout"]);sys.exit(d["rc"])\' "%s"\n' % FIX)
os.chmod(FAKE, os.stat(FAKE).st_mode | stat.S_IEXEC)


def sess(uid=1, key="1001", ago=3600, from_me=False, unread=0, last="你好", name="某人", official=False):
    return {"uid": uid, "name": name, "unread": unread, "time": "t", "last": last, "last_from_me": from_me,
            "follow": False, "last_msg_key": key, "last_seq": "9" + key, "last_ts": int(NOW - ago), "official": official}


def set_bili(sessions=None, rc=0, raw=None):
    out = raw if raw is not None else json.dumps({"count": len(sessions or []), "sessions": sessions or []})
    json.dump({"rc": rc, "stdout": out}, open(FIX, "w"))


def run_dm():
    """真跑 main_dm，返回 (退出码, 事件列表, stderr)。"""
    B.BILI = FAKE
    o, e = io.StringIO(), io.StringIO()
    with redirect_stdout(o), redirect_stderr(e):
        rc = B.main_dm()
    return rc, [json.loads(l) for l in o.getvalue().splitlines() if l.strip()], e.getvalue()


def collect(st, cmd_args="dm"):
    """用真的 senses.collect 跑一遍 bili_dm 源（dry，不写 events.jsonl 也不叫醒）。"""
    cfg = {"sources": [{"id": "bili_dm", "type": "command", "fire_on_first": True,
                        # -s, not -I: the script reads its sentences through modules/_lib (PYTHONPATH), as hh modules run gives it
                        "cmd": "BILI_BIN=%s BILI_DM_HEALTH=%s PYTHONPATH=%s %s -s %s %s" % (FAKE, os.environ["BILI_DM_HEALTH"], os.path.join(MODULES, "_lib"),
                                                                                         sys.executable, os.path.join(HERE, "bili_events.py"), cmd_args)}]}
    with redirect_stdout(io.StringIO()):
        return S.collect(cfg, st, True)


class Fresh(unittest.TestCase):
    def setUp(self):
        for p in (os.environ["BILI_DM_HEALTH"],):
            if os.path.exists(p):
                os.remove(p)


class FourCases(Fresh):
    def test_1_read_but_unanswered_is_reminded(self):      # 旧逻辑 unread_only 会漏掉的那种
        set_bili([sess(unread=0, from_me=False)])
        rc, evs, _ = run_dm()
        self.assertEqual((rc, len(evs)), (0, 1))
        self.assertIn("bili-dm-1-1001", evs[0]["id"])
        self.assertIn("还没回", evs[0]["body"])

    def test_2_answered_not_reminded(self):
        set_bili([sess(from_me=True, unread=3)])
        self.assertEqual(run_dm()[1], [])

    def test_3_api_failure_is_explicit_and_not_empty_success(self):
        for raw, rc in (("", 1), ("not json", 0), (json.dumps({"ok": False, "error": "B站 风控冷却中，还剩 5 分钟"}), 1),
                        (json.dumps({"ok": False, "error": "还没有 B站 登录凭证", "hint": "先调 auth_sync"}), 1)):
            set_bili(rc=rc, raw=raw)
            self.setUp()                                # 每种失败都从 0 次开始数（3 次才会报告警，见 3c）
            code, evs, err = run_dm()
            self.assertEqual((code, evs), (2, []), raw)
            self.assertIn("UNAVAILABLE", err)

    def test_3b_failure_does_not_advance_cursor(self):
        st = {}
        set_bili([sess()])
        self.assertEqual(len(collect(st)), 1)          # 第一轮：提醒，id 进 seen
        seen_before = list(st["seen"]["bili_dm"])
        set_bili(rc=1, raw=json.dumps({"ok": False, "error": "x"}))
        self.assertEqual(collect(st), [])               # 失败：没事件
        self.assertEqual(st["seen"]["bili_dm"], seen_before)   # seen 没动（没把失败当「没私信」）
        set_bili([sess(key="1002")])                    # 恢复后对方的新消息照常提醒
        self.assertEqual(len(collect(st)), 1)

    def test_3c_down_alert_after_3_fails_once_per_day(self):
        set_bili(rc=1, raw=json.dumps({"ok": False, "error": "登录失效"}))
        self.assertEqual(run_dm()[:2], (2, []))
        self.assertEqual(run_dm()[:2], (2, []))
        rc, evs, _ = run_dm()                           # 第 3 次：报一条
        self.assertEqual((rc, len(evs)), (0, 1))
        self.assertIn("不可用", evs[0]["text"])
        self.assertEqual(run_dm()[:2], (2, []))         # 同一天不再报
        set_bili([sess()])
        self.assertEqual(run_dm()[0], 0)
        self.assertEqual(B.load_health()["fails"], 0)   # 成功清零

    def test_3d_rate_limit_not_counted_and_cools_down(self):
        # 11-06：一天零星几十次「请求过于频繁」，下一分钟就好；11-04 连撞 3 次就误报了「接口不可用」
        limited = json.dumps({"ok": False, "error": "请求太频繁：请求过于频繁，请稍后再试", "hint": "歇几分钟"})
        set_bili(rc=1, raw=limited)
        self.assertEqual(run_dm()[:2], (2, []))
        h = B.load_health()
        self.assertEqual(int(h.get("fails") or 0), 0, "限流不算进连续失败")
        self.assertGreater(h["cooldown_until"], time.time() + 170)
        set_bili([sess()])
        self.assertEqual(run_dm()[:2], (0, []), "歇着的 3 分钟里不发请求、不输出")
        h["cooldown_until"] = time.time() - 1
        B.save_health(h)
        rc, evs, _ = run_dm()
        self.assertEqual((rc, len(evs)), (0, 1), "歇够了照常查，新私信照常提醒")
        self.assertNotIn("rl_since", B.load_health(), "成功清掉限流的记录")

    def test_3e_rate_limit_alerts_only_after_15_minutes(self):
        limited = json.dumps({"ok": False, "error": "请求过于频繁"})
        set_bili(rc=1, raw=limited)
        for _ in range(4):                               # 连撞 4 次（每次歇够再查）也不报
            h = B.load_health(); h["cooldown_until"] = 0; B.save_health(h)
            self.assertEqual(run_dm()[:2], (2, []))
        h = B.load_health(); h["cooldown_until"] = 0; h["rl_since"] = time.time() - 16 * 60; B.save_health(h)
        rc, evs, _ = run_dm()
        self.assertEqual((rc, len(evs)), (0, 1), "连着限流超过 15 分钟才报一条")
        self.assertIn("限流", evs[0]["text"])

    def test_4_replay_not_duplicated(self):
        st = {}
        set_bili([sess()])
        self.assertEqual(len(collect(st)), 1)
        self.assertEqual(collect(st), [])               # 同样输入再跑：不重复
        self.assertEqual(collect(st), [])
        set_bili([sess(key="1002", last="在吗")])        # 对方又发了一条：新的
        self.assertEqual(len(collect(st)), 1)
        set_bili([sess(key="1002", last="在吗", from_me=True)])   # 我回了
        self.assertEqual(collect(st), [])
        set_bili([sess(key="1003", last="谢谢")])        # 对方再回：又提醒
        self.assertEqual(len(collect(st)), 1)


class Extras(Fresh):
    def test_window_48h(self):
        set_bili([sess(ago=47 * 3600), sess(uid=2, key="2", ago=49 * 3600)])
        self.assertEqual([e["id"].split("-")[2] for e in run_dm()[1]], ["1"])

    def test_max_5_per_run_newest_first(self):
        set_bili([sess(uid=i, key=str(i), ago=100 * i) for i in range(1, 9)])
        evs = run_dm()[1]
        self.assertEqual(len(evs), 5)
        self.assertEqual([e["id"].split("-")[2] for e in evs], ["1", "2", "3", "4", "5"])

    def test_filters(self):
        set_bili([sess(uid=1, last=""), sess(uid=2, key="2", official=True), sess(uid=0, key="3")])
        self.assertEqual(run_dm()[1], [])               # 空内容 / 官方号 / 没 uid 都不提醒
        set_bili([sess(uid=4, key="4", ago=1)])
        self.assertEqual(len(run_dm()[1]), 1)

    def test_name_change_keeps_id_and_same_minute_two_messages_differ(self):
        set_bili([sess(name="旧名", key="55")])
        a = run_dm()[1][0]["id"]
        set_bili([sess(name="新名", key="55")])
        self.assertEqual(run_dm()[1][0]["id"], a)       # 昵称变了 id 不变（旧逻辑会重复叫醒）
        set_bili([sess(key="56", ago=3600)])
        self.assertNotEqual(run_dm()[1][0]["id"], a)    # 同一分钟的第二条：key 不同 → id 不同

    def test_key_fallbacks(self):
        s = sess(key="")
        s["last_seq"] = ""
        k1 = B.msg_key(s)
        self.assertTrue(k1.startswith(str(s["last_ts"])))
        s["last_seq"] = "77"
        self.assertEqual(B.msg_key(s), "77")
        s["last_msg_key"] = "88"
        self.assertEqual(B.msg_key(s), "88")

    def test_reply_mode_survives_api_error(self):
        set_bili(rc=1, raw=json.dumps({"ok": False, "error": "x"}))
        B.BILI = FAKE
        o, e = io.StringIO(), io.StringIO()
        with redirect_stdout(o), redirect_stderr(e):
            rc = B.main_reply()
        self.assertEqual((rc, o.getvalue()), (0, ""))
        self.assertIn("UNAVAILABLE", e.getvalue())

    def test_module_declares_both_sources(self):
        # 以前看的是角色自己的 senses/senses.json；进了模块以后，两个来源的默认命令在模块的声明里（角色配置可以盖掉）
        decl = open(os.path.join(MOD, "module.ts"), encoding="utf-8").read()
        self.assertRegex(decl, r'bili:\s*\{[^}]*cmd:\s*"(?:[^"\\]|\\.)*bili_events\.py"')
        self.assertRegex(decl, r'bili_dm:\s*\{[^}]*cmd:\s*"(?:[^"\\]|\\.)*bili_events\.py dm"')


if __name__ == "__main__":
    unittest.main(verbosity=2)
