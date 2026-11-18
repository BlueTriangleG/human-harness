import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "scripts"), str(HERE.parent.parent / "_lib")]
# run by itself: what HH hands the scripts (docs/contracts/modules.md) points at an empty temp dir, made-up names
_tmp = tempfile.mkdtemp(prefix="senses-env-")
for _k, _v in dict({k: _tmp for k in ("HH_WORKSPACE", "HH_STATE_DIR", "HH_MODULE_DIR", "HH_MODULE_STATE")},
                   HH_ROLE_ID="t", HH_ME="阿青", HH_OWNER="老林", HH_TZ="Australia/Melbourne", HH_LANG="zh", HH_BIN=_tmp + "/no-hh").items():
    os.environ.setdefault(_k, _v)
os.environ.setdefault("HH_MODULE_CONFIG", json.dumps({"notMe": ["阿青在补番"]}))
import hh_env  # noqa: E402
hh_env.hh = hh_env.read()   # a test file run before this one (discover) may have read the environment without the config
import senses  # noqa: E402


class Dispatch(unittest.TestCase):
    def test_retries_back_off_then_stop(self):
        st = {"seen": {"xhs": []}, "pending": [], "last_wake": 0}
        cfg = {"sources": [], "min_wake_gap_sec": 0}
        ev = {"id": "e1", "src": "xhs", "text": "hi", "do": ""}
        st["pending"].append(ev)
        wakes = []
        clock = [1_000_000.0]
        with mock.patch.object(senses, "save_state"), \
                mock.patch.object(senses, "wake", side_effect=lambda s, t: wakes.append(clock[0])), \
                mock.patch.object(senses, "wake_inflight", return_value=False), \
                mock.patch.object(senses, "check_last_wake"), mock.patch.object(senses.time, "time", lambda: clock[0]):
            for step in range(0, 4000, 30):
                clock[0] = 1_000_000.0 + step
                senses.poll(cfg, st, False)
        gaps = [b - a for a, b in zip(wakes, wakes[1:])]
        self.assertEqual(len(wakes), 3)
        self.assertGreaterEqual(gaps[0], 180)
        self.assertGreaterEqual(gaps[1], 600)



class Hooks(unittest.TestCase):
    def test_default_hook_queues_for_wake(self):
        st = {}
        senses.run_hooks({"sources": []}, st, [{"id": "a", "src": "xhs", "ts": 1, "text": "x", "do": ""}])
        self.assertEqual(st["pending"][0]["debounce"], 15)

    def test_command_hook_gets_event_and_matching_is_per_source(self):
        cfg = {"hooks": [{"type": "command", "on": ["web1"], "cmd": "cat"},
                         {"type": "wake_main", "on": "xhs", "debounce_sec": 5}]}
        st = {}
        with mock.patch.object(senses, "hook_command") as hc:
            senses.HOOKS["command"] = hc
            senses.run_hooks(cfg, st, [{"id": "a", "src": "web1", "ts": 1, "text": "x"},
                                       {"id": "b", "src": "xhs", "ts": 1, "text": "y"}])
            senses.HOOKS["command"] = senses.hook_command
        hc.assert_called_once()
        self.assertEqual(hc.call_args[0][1]["id"], "a")
        self.assertEqual([e["id"] for e in st["pending"]], ["b"])

    def test_disabled_hook_skipped(self):
        st = {}
        senses.run_hooks({"hooks": [{"type": "wake_main", "enabled": False}]}, st,
                         [{"id": "a", "src": "xhs", "ts": 1, "text": "x"}])
        self.assertEqual(st.get("pending", []), [])


class CommandSource(unittest.TestCase):
    def test_plain_lines_keep_old_ids(self):
        r = mock.Mock(returncode=0, stdout="a line\n\nother\n".encode())
        with mock.patch.object(senses.subprocess, "run", return_value=r):
            items = senses.src_command({"cmd": "x"})
        self.assertEqual([i["id"] for i in items], [senses.h("a line"), senses.h("other")])
        self.assertNotIn("body", items[0])

    def test_json_line_carries_body_and_same_id_as_plain_text(self):
        line = json.dumps({"text": "cc done", "body": "全文\n第二行"}, ensure_ascii=False)
        r = mock.Mock(returncode=0, stdout=(line + "\n").encode())
        with mock.patch.object(senses.subprocess, "run", return_value=r):
            (it,) = senses.src_command({"cmd": "x"})
        self.assertEqual(it["id"], senses.h("cc done"))
        self.assertEqual(it["body"], "全文\n第二行")

    def test_body_goes_into_wake_text(self):
        st = {"pending": [{"id": "e1", "src": "cc", "ts": 0, "text": "cc done", "do": "", "body": "第一行\n第二行"}]}
        with mock.patch.object(senses, "check_last_wake"), mock.patch.object(senses, "wake") as w:
            senses.dispatch({}, st, 10_000)
        text = w.call_args[0][1]
        self.assertIn("  第一行\n  第二行", text)
        self.assertIn("--ack e1", text)


class Followup(unittest.TestCase):
    def test_schedules_once_for_debounced_events(self):
        now = 1000.0
        st = {"pending": [{"id": "1", "src": "xhs", "ts": now - 5, "debounce": 15}]}
        with mock.patch.object(senses.subprocess, "Popen") as pop:
            senses.schedule_followup(st, now)
            senses.schedule_followup(st, now)   # second call must not stack another sleeper
        self.assertEqual(pop.call_count, 1)
        self.assertAlmostEqual(st["followup_at"], now + 11, delta=0.01)

    def test_nothing_waiting_no_followup(self):
        with mock.patch.object(senses.subprocess, "Popen") as pop:
            senses.schedule_followup({"pending": [{"id": "1", "src": "xhs", "ts": 0, "dispatches": 1}]}, 1000.0)
        pop.assert_not_called()


class Debounce(unittest.TestCase):
    def test_burst_waits_until_quiet(self):
        now = 1000.0
        pending = [{"id": "1", "src": "xhs", "ts": now - 20, "debounce": 15},
                   {"id": "2", "src": "xhs", "ts": now - 5, "debounce": 15}]
        self.assertEqual(senses.due_events(pending, now), [])          # newest only 5s old
        self.assertEqual(len(senses.due_events(pending, now + 11)), 2)  # quiet for 16s -> both together

    def test_max_wait_caps_continuous_stream(self):
        now = 1000.0
        pending = [{"id": "1", "src": "xhs", "ts": now - 61, "debounce": 15},
                   {"id": "2", "src": "xhs", "ts": now - 1, "debounce": 15}]
        self.assertEqual([e["id"] for e in senses.due_events(pending, now)], ["1"])



DUMP = """Current Notification Manager State
  NotificationRecord(0x01: pkg=com.tencent.mm user=UserHandle{0} id=1 tag=null importance=4 key=0|com.tencent.mm|1|null|10207: Notification(channel=message_channel_new_id shortcut=null))
        postTime=1000
        extras={
                android.title=String (老林)
                android.text=String ([2条]哈咯)
  NotificationRecord(0x02: pkg=com.tencent.mm user=UserHandle{0} id=2 tag=null importance=2 key=0|com.tencent.mm|2|null|10207: Notification(channel=reminder_channel_id shortcut=null))
        extras={
                android.title=String (微信)
                android.text=String (你的账号在新设备登录)
  NotificationRecord(0x03: pkg=com.xingin.xhs user=UserHandle{0} id=3 tag=null importance=4 key=0|com.xingin.xhs|3|null|10190: Notification(channel=msg shortcut=null))
        postTime=2000
        extras={
                android.title=String (老林 私信你)
                android.text=String (在吗)
  NotificationRecord(0x04: pkg=com.xingin.xhs user=UserHandle{0} id=4 tag=null importance=4 key=0|com.xingin.xhs|4|null|10190: Notification(channel=msg shortcut=null))
        extras={
                android.title=String (你的关注：@某人)
"""


class PhoneNotify(unittest.TestCase):
    """11-01：微信通知和小红书共用一套解析；小红书的 id 算法不能变（seen 里存的都是旧 id）。"""
    def test_wx_messages_only(self):
        items = senses.parse_wx(DUMP)
        self.assertEqual([i["text"] for i in items], ["老林：[2条]哈咯"])

    def test_xhs_unchanged(self):
        items = senses.parse_xhs(DUMP)
        self.assertEqual([i["text"] for i in items], ["老林 私信你：在吗"])
        legacy = senses.h("0|com.xingin.xhs|3|null|10190:" + "老林 私信你" + "在吗")
        self.assertEqual(items[0]["legacy_id"], legacy)
        self.assertEqual(items[0]["id"], senses.h(legacy + ":2000"))

    def test_bad_dump_raises(self):
        with self.assertRaises(RuntimeError):
            senses.parse_wx("adb: device offline")

    def test_wx_type_registered(self):
        self.assertIs(senses.TYPES["wx_notify"], senses.src_wx)

    def test_home_only_when_idle_and_foreground(self):
        top = "  topResumedActivity=ActivityRecord{1 u0 com.tencent.mm/.ui.LauncherUI t1}\n"
        calls = []
        fake = lambda *a, **k: calls.append(a) or (top if a[:2] == ("shell", "dumpsys") else "")
        with mock.patch.object(senses, "adb", fake), mock.patch.object(senses, "life_active", return_value=False):
            with mock.patch.object(senses, "phone_idle_sec", return_value=30):
                senses.home_if_idle_in("com.tencent.mm", {})
            self.assertNotIn(("shell", "input", "keyevent", "KEYCODE_HOME"), calls)
            with mock.patch.object(senses, "phone_idle_sec", return_value=300):
                senses.home_if_idle_in("com.xingin.xhs", {})
                self.assertNotIn(("shell", "input", "keyevent", "KEYCODE_HOME"), calls)
                senses.home_if_idle_in("com.tencent.mm", {})
            self.assertIn(("shell", "input", "keyevent", "KEYCODE_HOME"), calls)

    def test_wake_home_skips_while_phone_in_use(self):
        """11-11：叫醒交接完按 Home 前先看手机有没有人正在用（#0059 扫码登录被连着按回桌面）。"""
        top = "  topResumedActivity=ActivityRecord{1 u0 com.xingin.xhs/.index.v2.IndexActivityV2 t1}\n"
        home = ("shell", "input", "keyevent", "KEYCODE_HOME")
        def run(idle, life=False):
            calls = []
            fake = lambda *a, **k: calls.append(a) or (top if a[:2] == ("shell", "dumpsys") else "")
            with mock.patch.object(senses, "adb", fake), mock.patch.object(senses, "phone_on", return_value=True), \
                    mock.patch.object(senses, "life_active", return_value=life), \
                    mock.patch.object(senses, "phone_idle_sec", return_value=idle):
                senses.home_if_xhs_foreground()
            return calls
        self.assertNotIn(home, run(5))                                 # 刚有人点过：不按
        self.assertNotIn(home, run(senses.PHONE_IN_USE_SEC - 1))
        self.assertIn(home, run(senses.PHONE_IN_USE_SEC + 1))          # 闲了一阵：照旧按
        self.assertNotIn(home, run(300, life=True))                    # 自由时间：不按（原样）


class PhoneCatchup(unittest.TestCase):
    """10-31：手机关了一阵再开，叫她去小红书消息页补看（关机期间的私信不一定补通知）。"""
    def run_at(self, st, pid, now, dry=False):
        with mock.patch.object(senses, "phone_pid", return_value=pid), mock.patch.object(senses.time, "time", return_value=now):
            return senses.phone_catchup({"_st": st, "_dry": dry})

    def test_first_sight_and_reboot_after_long_off(self):
        st = {}
        self.assertEqual(len(self.run_at(st, "100", 10_000)), 1)
        self.assertEqual(self.run_at(st, "100", 10_120), [])      # 一直开着
        out = self.run_at(st, "200", 10_120 + 7200)               # 关了两小时再开
        self.assertEqual(len(out), 1)
        self.assertIn("约 2.0 小时", out[0]["text"])

    def test_quick_restart_does_not_wake(self):
        st = {}
        self.run_at(st, "100", 10_000)
        self.assertEqual(self.run_at(st, "200", 10_150), [])      # 两分半内重开（重启一下手机）

    def test_six_minutes_off_wakes_with_wechat(self):
        st = {}
        self.run_at(st, "100", 10_000)
        out = self.run_at(st, "200", 10_000 + 360)               # 11-01 22:31 那次：关了 6 分钟
        self.assertEqual(len(out), 1)
        self.assertIn("wx_chats", out[0]["text"])

    def test_dry_run_keeps_state(self):
        st = {}
        self.run_at(st, "100", 10_000, dry=True)
        self.assertEqual(st["xhs_phone"], {})

    def test_off_returns_nothing(self):
        self.assertEqual(self.run_at({}, "", 10_000), [])


class PhoneNet(unittest.TestCase):
    """11-03：手机 03:28 开机就没网，10:59 才被看见。每轮查，连着两轮没网就后台修，断过就报。"""
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "memory/phone"))
        self.p = [mock.patch.object(senses, "WS", self.tmp), mock.patch.object(senses, "phone_starting", return_value=False)]
        for x in self.p: x.start()

    def tearDown(self):
        for x in self.p: x.stop()

    def run_at(self, st, now, rc, idle=600, on=True, dry=False, why="没网：安卓没有能用的网络，wifi CONNECTING、没 IP"):
        spawned = []
        res = mock.Mock(returncode=rc, stdout="有网" if rc == 0 else why + "\nphone.py net --fix 修", stderr="")
        with mock.patch.object(senses.subprocess, "run", return_value=res), \
                mock.patch.object(senses.subprocess, "Popen", side_effect=lambda a, **k: spawned.append(a)), \
                mock.patch.object(senses.time, "time", return_value=now), \
                mock.patch.object(senses, "phone_idle_sec", return_value=idle), \
                mock.patch.object(senses, "phone_on", return_value=on):
            return senses.src_phone_net({"_st": st, "_dry": dry}), spawned

    def fixed(self, at, how):
        with open(os.path.join(self.tmp, "memory/phone/.net_fix.json"), "w") as f:
            json.dump({"at": at, "how": how, "why": ""}, f)

    def test_ok_is_quiet(self):
        self.assertEqual(self.run_at({}, 1000, 0), ([], []))

    def test_second_bad_round_fixes_and_reboots_when_idle(self):
        st = {}
        self.run_at(st, 1000, 0)
        self.assertEqual(self.run_at(st, 1120, 1), ([], []))       # 一轮没网先不动（可能刚好在重连）
        out, sp = self.run_at(st, 1240, 1)
        self.assertEqual(out, [])
        self.assertEqual(sp[0][-2:], ["net", "--fix"])              # 闲着：允许重启
        self.assertEqual(self.run_at(st, 1360, 1)[1], [])          # 修理在跑，不再派

    def test_in_use_fix_does_not_reboot(self):
        st = {}
        self.run_at(st, 1000, 1, idle=30)
        self.assertEqual(self.run_at(st, 1120, 1, idle=30)[1][0][-1], "--no-reboot")

    def test_fixed_goes_to_triage_with_duration_and_catchup(self):
        st = {}
        self.run_at(st, 1000, 0); self.run_at(st, 1120, 1); self.run_at(st, 1240, 1)
        self.fixed(1300, "wifi")
        out, _ = self.run_at(st, 1360, 0)
        self.assertEqual(len(out), 1)
        t = out[0]["text"]
        for s in ("[手机断网·已修好]", "约 6 分钟", "关开 wifi 修好了", "wx_chats", "小红书", "wifi CONNECTING"):
            self.assertIn(s, t)
        self.assertEqual(self.run_at(st, 1480, 0)[0], [])           # 只报一次

    def test_stale_last_ok_is_not_the_start(self):
        """感官层停过 40 分钟（电脑睡了），回来第一轮就没网：从这一轮算，不报成断了 40 分钟。"""
        st = {}
        self.run_at(st, 1000, 0)
        self.run_at(st, 1000 + 2400, 1); self.run_at(st, 1000 + 2520, 1)
        out, _ = self.run_at(st, 1000 + 2640, 0)
        self.assertIn("[手机断网·已修好]", out[0]["text"])
        self.assertIn("约 4 分钟", out[0]["text"])

    def test_long_outage_wakes_me_even_if_fixed(self):
        """03:28 那次：开机就没网（之前没见过有网），过了半小时以上才好。"""
        st = {}
        self.run_at(st, 10_000, 1, idle=30)
        self.run_at(st, 10_120, 1, idle=30)
        out, _ = self.run_at(st, 10_000 + 2400, 0)
        self.assertIn("[手机断网·要你处理]", out[0]["text"])
        self.assertIn("约 40 分钟", out[0]["text"])

    def test_failed_fix_wakes_me_once_then_retries_later(self):
        st = {}
        self.run_at(st, 1000, 1, idle=30); self.run_at(st, 1120, 1, idle=30)
        self.fixed(1200, "failed")
        out, sp = self.run_at(st, 1240, 1, idle=30)
        self.assertEqual(sp, [])
        self.assertIn("[手机断网·要你处理]", out[0]["text"])
        self.assertIn("phone net --fix", out[0]["text"])          # 在用手机所以没重启：告诉她用完自己修
        self.assertEqual(self.run_at(st, 1360, 1)[0], [])            # 不重复报
        out, sp = self.run_at(st, 1120 + 1800, 1)                    # 半小时后再派，这回她闲着，能重启
        self.assertEqual(sp[0][-2:], ["net", "--fix"])
        self.fixed(1120 + 1900, "reboot")
        out, _ = self.run_at(st, 1120 + 2000, 0)
        self.assertIn("[手机断网·要你处理]", out[0]["text"])          # 报过修不好的，恢复了也告诉本人
        self.assertIn("重启手机修好了", out[0]["text"])

    def test_stuck_fix_reported_after_quarter_hour(self):
        st = {}
        self.run_at(st, 1000, 1); self.run_at(st, 1120, 1)          # 派了修理，但一直没写结果
        out, _ = self.run_at(st, 1000 + 900, 1)
        self.assertIn("自动修了一阵还没好", out[0]["text"])

    def test_phone_off_or_booting_is_not_an_outage(self):
        st = {}
        self.run_at(st, 1000, 1)
        self.assertEqual(self.run_at(st, 1120, 1, on=False), ([], []))
        self.assertEqual(st["phone_net"]["bad_since"], 0)
        self.assertEqual(self.run_at(st, 1240, 3), ([], []))         # 正在开机/重启
        self.assertEqual(st["phone_net"]["bad_n"], 0)

    def test_dry_run_changes_nothing(self):
        before = {"last_ok": 900, "bad_since": 900, "bad_n": 1}
        st = {"phone_net": dict(before)}
        out, sp = self.run_at(st, 1000, 1, dry=True)                 # 第二轮没网，本该派修理
        self.assertEqual(sp, [])
        self.assertEqual(st["phone_net"], before)


class PhoneIdle(unittest.TestCase):
    """10-14：模拟器每次被 adb 查询都会往 emulator.log 写一行，闲置判断不能被它刷新。"""
    def test_only_last_used_counts(self):
        with tempfile.TemporaryDirectory() as d:
            phone = Path(d, "memory/phone"); phone.mkdir(parents=True)
            last = phone / ".last_used"; last.touch()
            old = time.time() - 300
            os.utime(last, (old, old))
            (phone / "emulator.log").write_text("ERROR | adb protocol fault\n")  # 刚写过
            with mock.patch.object(senses, "WS", d):
                self.assertGreater(senses.phone_idle_sec(), senses.PHONE_IDLE_HOME_SEC)

    def test_missing_last_used_is_idle(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(senses, "WS", d):
            self.assertGreater(senses.phone_idle_sec(), senses.PHONE_IDLE_HOME_SEC)


class Fields(unittest.TestCase):
    def test_wx_group_line_gets_fields(self):
        it = senses.wx_item("河边小院", "[5条]小禾: @阿青 不许依靠数学归纳", "id1")
        self.assertEqual((it["conv"], it["sender"], it["isGroup"], it["mentionsMe"], it["unread"]),
                         ("河边小院", "小禾", True, True, 5))
        self.assertEqual(it["text"], "河边小院：[5条]小禾: @阿青 不许依靠数学归纳")

    def test_wx_private_line(self):
        it = senses.wx_item("伯伯", "能提供下建议，投资股票的技巧吗？", "id2")
        self.assertEqual((it["conv"], it["sender"], it["isGroup"], it["mentionsMe"], it["unread"]), ("伯伯", "伯伯", False, False, 1))

    def test_mention_of_buban_nickname_is_not_mention(self):
        self.assertFalse(senses.wx_item("群", "a: @阿青在补番 你好", "x")["mentionsMe"])

    def test_notice_prefix_is_mention(self):
        self.assertTrue(senses.wx_item("群", "[2条][有人@我]a: 在吗", "x")["mentionsMe"])
        self.assertTrue(senses.wx_item("群", "[有人@我]a: 在吗", "x")["mentionsMe"])

    def test_parse_wx_carries_fields(self):
        out = ("Notification Manager State\n  NotificationRecord(0x1 pkg=com.tencent.mm user=0 id=1 key=k1 channel=message_channel_new_id)\n"
               "    extras={\n      android.title=String (河边小院)\n      android.text=String ([5条]小禾: @阿青 hi)\n")
        items = senses.parse_wx(out)
        self.assertEqual((items[0]["conv"], items[0]["sender"], items[0]["mentionsMe"]), ("河边小院", "小禾", True))

    def test_xhs_item_private(self):
        it = senses.xhs_item("某人", "你好呀", "i")
        self.assertEqual((it["conv"], it["sender"], it["isGroup"], it["unread"]), ("某人", "某人", False, 1))

    def test_xhs_dm_title_strips_sixin(self):
        """11-03：真的私信标题是「老林 私信你」，会话名/发话人去掉「私信你」，text 和 id 不变。"""
        it = senses.xhs_item("老林 私信你", "在吗", "i")
        self.assertEqual((it["conv"], it["sender"], it["isGroup"], it["text"], it["id"]), ("老林", "老林", False, "老林 私信你：在吗", "i"))
        self.assertEqual(senses.xhs_item("老林私信你", "在吗", "i")["conv"], "老林")
        items = senses.parse_xhs(DUMP)
        self.assertEqual((items[0]["conv"], items[0]["sender"], items[0]["text"]), ("老林", "老林", "老林 私信你：在吗"))
        # 只有「私信你」三个字的标题不剥成空名字
        self.assertEqual(senses.xhs_item("私信你", "x", "i")["conv"], "私信你")

    def test_phone_net_long_outage_is_alarm(self):
        ev = senses.net_fail_event({"bad_since": 0, "why": "x", "told_fail": True}, {}, 3600)
        self.assertTrue(ev.get("alarm"))

    def test_net_back_alarm_only_when_tagged(self):
        long = senses.net_back_event({"bad_since": 0}, {}, senses.PHONE_NET_LONG_SEC + 60)
        short = senses.net_back_event({"bad_since": 0}, {}, 120)
        self.assertTrue(long.get("alarm"))
        self.assertNotIn("alarm", short)

    def test_collect_carries_fields(self):
        item = senses.wx_item("河边小院", "[5条]小禾: @阿青 hi", "i1")
        st = {"seen": {"wx": []}}
        cfg = {"sources": [{"id": "wx", "type": "wx_notify"}]}
        with mock.patch.dict(senses.TYPES, {"wx_notify": lambda s: [item]}):
            evs = senses.collect(cfg, st, True)
        self.assertEqual((evs[0]["conv"], evs[0]["sender"], evs[0]["isGroup"], evs[0]["mentionsMe"], evs[0]["unread"]),
                         ("河边小院", "小禾", True, True, 5))


class Handoff(unittest.TestCase):
    def run_dispatch(self, cfg_extra, st):
        d = tempfile.mkdtemp()
        cfg = dict({"sources": [], "min_wake_gap_sec": 0}, **cfg_extra)
        self.msg = os.path.join(d, "msg")
        self.out = os.path.join(d, "out")
        with mock.patch.object(senses, "WAKE_MSG", self.msg), mock.patch.object(senses, "WAKE_OUT", self.out), \
                mock.patch.object(senses.subprocess, "Popen") as po, \
                mock.patch.object(senses, "wake_log"), mock.patch.object(senses, "check_last_wake"), \
                mock.patch.object(senses, "wake_inflight", return_value=False):
            po.return_value.pid = 1
            senses.dispatch(cfg, st, 1_000_000.0)

    def wx_state(self):
        ev = {"id": "e1", "src": "wx", "text": "河边小院：[5条]小禾: @阿青 hi", "do": "", "ts": 0,
              "conv": "河边小院", "sender": "小禾", "isGroup": True, "mentionsMe": True, "unread": 5}
        return {"pending": [ev], "last_wake": 0}

    def test_hh_wake_file_is_json_with_events(self):
        st = self.wx_state()
        self.run_dispatch({"hh_json": True}, st)
        msg = json.load(open(self.msg))
        self.assertTrue(msg["text"].startswith("[感官] 有新动静"))
        self.assertEqual((msg["events"][0]["conv"], msg["events"][0]["sender"]), ("河边小院", "小禾"))
        self.assertEqual(st["wake"]["ids"], [msg["events"][0]["id"]])

    def test_hh_ok_result_acks_dispatched_ids(self):
        st = {"pending": [{"id": "a"}, {"id": "b"}, {"id": "c"}], "wake": {"ids": ["a", "b"], "checked": False}}
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o")
            Path(out).write_text('{"status": "ok", "result": "delivered"}')
            with mock.patch.object(senses, "WAKE_OUT", out), \
                    mock.patch.object(senses, "wake_inflight", return_value=False), mock.patch.object(senses, "wake_log"), \
                    mock.patch.object(senses, "home_if_xhs_foreground"):
                senses.check_last_wake(st)
        self.assertEqual([e["id"] for e in st["pending"]], ["c"])

    def test_hh_json_flag_off_keeps_text(self):
        st = self.wx_state()
        self.run_dispatch({}, st)
        txt = open(self.msg).read()
        self.assertFalse(txt.startswith("{"))
        self.assertTrue(txt.startswith("[感官] 有新动静"))
        self.assertEqual(st["wake"]["ids"], ["e1"])



class DropStale(unittest.TestCase):
    def test_drop_stale_backs_up_and_clears(self):
        with tempfile.TemporaryDirectory() as d:
            sp = os.path.join(d, "state.json")
            Path(sp).write_text(json.dumps({"pending": [{"id": "a", "dispatches": 3}, {"id": "b", "dispatches": 1}]}))
            with mock.patch.object(senses, "STATE", sp), mock.patch.object(senses.sys, "argv", ["senses.py", "--drop-stale"]):
                senses.main()
            st = json.load(open(sp))
            self.assertEqual([e["id"] for e in st["pending"]], ["b"])
            baks = [n for n in os.listdir(d) if n.startswith("state.json.bak-") and n.endswith("-stale")]
            self.assertEqual(len(baks), 1)


if __name__ == "__main__":
    unittest.main()


class EverySec(unittest.TestCase):
    def _cfg(self):
        return {"sources": [{"id": "goals", "type": "t_every", "every_sec": 60, "fire_on_first": True}]}

    def test_every_sec_skips_until_due(self):
        fn = mock.Mock(return_value=[])
        st = {"seen": {"goals": []}}
        with mock.patch.dict(senses.TYPES, {"t_every": fn}):
            senses.collect(self._cfg(), st, False, now=1000.0)
            senses.collect(self._cfg(), st, False, now=1010.0)
            self.assertEqual(fn.call_count, 1)
            senses.collect(self._cfg(), st, False, now=1061.0)
            self.assertEqual(fn.call_count, 2)
        self.assertEqual(st["last_run"]["goals"], 1061.0)

    def test_skip_is_not_an_error(self):
        st = {"seen": {"goals": []}, "last_run": {"goals": 1000.0}}
        with mock.patch.dict(senses.TYPES, {"t_every": mock.Mock(return_value=None)}), \
             mock.patch.object(senses, "report_error") as re:
            senses.collect(self._cfg(), st, False, now=1005.0)
        re.assert_not_called()

    def test_watcher_trigger_ignores_every_sec(self):
        fn = mock.Mock(return_value=[])
        st = {"seen": {"goals": []}, "last_run": {"goals": 1000.0}}
        with mock.patch.dict(senses.TYPES, {"t_every": fn}):
            senses.collect(self._cfg(), st, False, only="goals", now=1002.0)
        self.assertEqual(fn.call_count, 1)
        self.assertEqual(st["last_run"]["goals"], 1002.0)

    def test_no_every_sec_runs_every_time(self):
        fn = mock.Mock(return_value=[])
        cfg = {"sources": [{"id": "wx", "type": "t_every"}]}
        st = {"seen": {"wx": []}}
        with mock.patch.dict(senses.TYPES, {"t_every": fn}):
            senses.collect(cfg, st, False, now=1000.0)
            senses.collect(cfg, st, False, now=1001.0)
        self.assertEqual(fn.call_count, 2)


class DebounceBySrc(unittest.TestCase):
    def test_debounce_by_src(self):
        hook = {"type": "wake_main", "debounce_sec": 15, "debounce_by_src": {"wx": 3}}
        st = {}
        senses.hook_wake_main(hook, {"id": "a", "src": "wx", "ts": 1000.0, "text": "x"}, st)
        senses.hook_wake_main(hook, {"id": "b", "src": "goals", "ts": 1000.0, "text": "y"}, st)
        self.assertEqual([e["debounce"] for e in st["pending"]], [3, 15])
        self.assertEqual([e["id"] for e in senses.due_events(st["pending"], 1003.5)], ["a"])
