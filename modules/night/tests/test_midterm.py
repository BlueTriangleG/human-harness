#!/usr/bin/python3
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
import midterm as M

TZ = M.TZ


def thread(tmp, name, body):
    d = Path(tmp) / 'memory/threads'
    d.mkdir(parents=True, exist_ok=True)
    p = d / f'{name}.md'
    p.write_text(body, encoding='utf-8')
    return M.Thread(p)


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.today = dt.date(2026, 10, 24)

    def test_meta_and_layers(self):
        t = thread(self.tmp, 'a', '# 故事线：B站\n<!-- 事件线 开始=2026-10-21 最近进展=2026-10-24 17:37 状态=进行中 -->\n'
                   '## 一句话\n做UP主回本\n## 简述\n一段话。\n## 现在的状态\n- x\n## 经过\n- 2026-10-01 旧\n')
        self.assertEqual(t.title, 'B站')
        self.assertEqual(t.last, dt.datetime(2026, 10, 24, 17, 37, tzinfo=TZ))
        self.assertEqual(t.one_line(), '做UP主回本')
        self.assertEqual(t.brief_text(), '一段话。')
        self.assertEqual(t.tier(self.today), 'brief')

    def test_fallback_from_log(self):
        t = thread(self.tmp, 'b', '# 旧事\n## 现在的状态\n- 状态：进行中\n## 经过\n- 2026-10-12 开始\n- 2026-10-15 13:00 进展\n')
        self.assertEqual(t.start.date(), dt.date(2026, 10, 12))
        self.assertEqual(t.last.date(), dt.date(2026, 10, 15))
        self.assertEqual(t.tier(self.today), 'line')   # 9 天
        self.assertEqual(t.one_line(), '状态：进行中')    # 状态段没写日期：说不准旧不旧，照旧用

    def test_time_windows(self):
        mk = lambda d, st='进行中': thread(self.tmp, f'x{d}{st}', f'# t\n<!-- 事件线 最近进展={d} 状态={st} -->\n## 经过\n')
        self.assertEqual(mk('2026-10-22').tier(self.today), 'brief')   # 前天
        self.assertEqual(mk('2026-10-21').tier(self.today), 'line')    # 3 天前
        self.assertEqual(mk('2026-10-11').tier(self.today), 'line')    # 13 天
        self.assertEqual(mk('2026-10-10').tier(self.today), 'name')    # 14 天：只记个名（以前是不放）
        self.assertEqual(mk('2026-08-25', '暂停').tier(self.today), 'name')   # 60 天
        self.assertIsNone(mk('2026-08-24', '暂停').tier(self.today))         # 61 天，不在进行
        self.assertEqual(mk('2026-03-01').tier(self.today), 'name')    # 还在进行的老事不论多久都记个名
        self.assertIsNone(mk('2026-10-16', '已了结').tier(self.today))  # 了结超过 7 天
        self.assertEqual(mk('2026-10-18', '已了结').tier(self.today), 'line')

    def test_day_boundary(self):
        # 凌晨 2 点的进展算前一天
        t = thread(self.tmp, 'n', '# n\n<!-- 事件线 最近进展=2026-10-22 02:00 -->\n## 经过\n')
        self.assertEqual(t.age(self.today), 3)
        self.assertEqual(t.tier(self.today), 'line')

    def test_pin(self):
        t = thread(self.tmp, 'p', '# p\n<!-- 事件线 最近进展=2026-10-01 置顶到=2026-10-30 -->\n## 经过\n')
        self.assertEqual(t.tier(self.today), 'brief')

    def test_shrink_by_time_not_count(self):
        for i in range(3):
            thread(self.tmp, f's{i}', f'# s{i}\n<!-- 事件线 最近进展=2026-10-2{2 + i} -->\n## 简述\n' + '长' * 250 + '\n## 经过\n')
        now = dt.datetime(2026, 10, 24, 20, 0, tzinfo=TZ)
        M.WS = Path(self.tmp)
        text, used = M.render(None, now, events_max=600)
        self.assertLess(used[0], 3)          # 缩了时间窗口
        self.assertIn('s2', text)            # 最新的还在
        self.assertIn('这次太长，暂时缩了', text)   # 缩了就说一声

    # ---- 2026-10-25 P0-3 新增 ----

    def test_meta_older_than_log(self):
        """元数据比「经过」旧：最近进展取经过里更新的那条，简述后面接上之后的原文。"""
        t = thread(self.tmp, 'm', '# m\n<!-- 事件线 开始=2026-10-01 最近进展=2026-10-11 状态=进行中 -->\n'
                   '## 一句话\n旧的一句话\n## 简述\n整理那晚写的简述。\n## 经过\n- 2026-10-11 第一件\n- 2026-10-24 09:00 新的原文\n')
        self.assertEqual(t.last, dt.datetime(2026, 10, 24, 9, 0, tzinfo=TZ))
        self.assertEqual(t.tier(dt.date(2026, 10, 25)), 'brief')     # 以前会被判出窗口
        self.assertIn('之后：2026-10-24 09:00 新的原文', t.brief_text())
        self.assertIn('10-24 又有新进展', t.one_line())

    def test_no_meta_misplaced_event(self):
        """没有元数据：误放在「因果和判断」下面的带日期事件行也算最近进展。"""
        t = thread(self.tmp, 'e', '# 选耳机\n## 现在的状态\n- 状态：在挑\n- 最后更新：2026-10-12\n## 经过（按时间）\n- 2026-10-10 开始挑\n'
                   '## 因果和我的判断\n- 我的判断：要降噪\n- 2026-10-18 18:18 定了 QC Ultra\n')
        self.assertFalse(t.has_meta)
        self.assertEqual(t.last.date(), dt.date(2026, 10, 18))
        self.assertEqual(t.start.date(), dt.date(2026, 10, 10))

    def test_stale_status_shows_log(self):
        """「现在的状态」比最新的事件行旧：不再拿过时的状态当简述，放最新 1–2 条原文并标状态段日期。"""
        t = thread(self.tmp, 'x', '# 故事线：小红书账号\n## 现在的状态\n- 下一步：先不开小红书\n- 最后更新：2026-10-12\n'
                   '## 经过（按时间）\n- 2026-10-12 18:25 资料改好\n- 2026-10-24 18:13 自介视频发到小红书\n- 2026-10-24 19:03 回了阿桔\n')
        b = t.brief_text()
        self.assertNotIn('先不开小红书', b)
        self.assertIn('2026-10-24 18:13 自介视频发到小红书', b)
        self.assertIn('2026-10-24 19:03 回了阿桔', b)
        self.assertIn('状态段最后更新 10-12', b)
        self.assertNotIn('先不开', t.one_line())
        # 状态段是新的：照用状态段
        t2 = thread(self.tmp, 'y', '# y\n## 现在的状态\n- 已经发了\n- 最后更新：2026-10-24\n## 经过\n- 2026-10-24 10:00 发了\n')
        self.assertTrue(t2.brief_text().startswith('- 已经发了') or '已经发了' in t2.brief_text())
        self.assertNotIn('「经过」最新', t2.brief_text())

    def test_placeholder(self):
        """模板里没填的提示不当内容。"""
        t = thread(self.tmp, 'ph', '# 新事\n<!-- 事件线 开始=2026-10-24 最近进展=2026-10-24 10:00 状态=进行中 -->\n'
                   '## 一句话\n（30 字以内：这是什么事、到哪了）\n## 简述\n（一段话，200 字以内：大概经过 + 现在的状态 + 下一步卡在哪。写给明天醒来的她，读完就能接上）\n'
                   '## 现在的状态\n- 刚开始\n- 最后更新：2026-10-24\n## 经过\n- 2026-10-24 10:00 起了个头\n')
        self.assertEqual(t.line, '')
        self.assertEqual(t.brief, '')
        self.assertNotIn('字以内', t.brief_text())
        self.assertNotIn('字以内', t.one_line())
        self.assertIn('刚开始', t.brief_text())

    def test_year_month(self):
        """只写到月的日期（2026-10）：按 10-01 算，标「只到月」，不再当成一百万天前。"""
        t = thread(self.tmp, 'v', '# 故事线：爸妈签证\n## 现在的状态\n- 状态：进行中\n- 最后更新：2026-10-10\n'
                   '## 经过（按时间）\n- 2026-10 Reminders 里有「帮爸妈申请签证」\n')
        self.assertEqual(t.last, dt.datetime(2026, 10, 1, 12, tzinfo=TZ))
        self.assertEqual(t.last_prec, 'month')
        self.assertEqual(t.age(dt.date(2026, 10, 25)), 24)
        self.assertEqual(t.tier(dt.date(2026, 10, 25)), 'name')
        self.assertIn('2026-10（只到月）', t.dates_label())
        self.assertEqual(t.name_line(), '爸妈签证 · 2026-10 · 进行中')

    def test_no_dates_mtime(self):
        """一个日期都没有：用文件修改时间，标「缺日期」。"""
        t = thread(self.tmp, 'nd', '# 无日期\n## 现在的状态\n- 在做\n## 经过\n- 某天开始\n')
        p = t.path
        ts = dt.datetime(2026, 10, 20, 15, tzinfo=TZ).timestamp()
        os.utime(p, (ts, ts))
        t = M.Thread(p)
        self.assertEqual(t.last_prec, 'mtime')
        self.assertEqual(t.age(self.today), 4)
        self.assertIn('缺日期', t.dates_label())

    def test_next_date(self):
        """下次=某天：到那天前至少一句话，最后 3 天放简述，过了就照常。"""
        t = thread(self.tmp, 'nx', '# 考试\n<!-- 事件线 最近进展=2026-09-01 状态=暂停 下次=2026-11-20 -->\n## 一句话\n12 月考 P 牌\n## 经过\n')
        self.assertEqual(t.tier(dt.date(2026, 10, 24)), 'line')
        self.assertEqual(t.tier(dt.date(2026, 11, 17)), 'line')
        self.assertEqual(t.tier(dt.date(2026, 11, 18)), 'brief')
        self.assertEqual(t.tier(dt.date(2026, 11, 20)), 'brief')
        self.assertIsNone(t.tier(dt.date(2026, 11, 21)))     # 过了那天、暂停又很久没动：不放
        self.assertIn('下次 11-20', t.dates_label())

    def test_labels_and_name_tier_render(self):
        """「3–13 天前」标签不再差一天；只记个名一行是「标题 · 日期 · 状态」。"""
        thread(self.tmp, 'l1', '# 三天前\n<!-- 事件线 最近进展=2026-10-21 状态=进行中 -->\n## 一句话\n一句\n## 经过\n')
        thread(self.tmp, 'l2', '# 很久\n<!-- 事件线 最近进展=2026-09-01 状态=进行中 -->\n## 一句话\n一句\n## 经过\n')
        M.WS = Path(self.tmp)
        text, used = M.render(None, dt.datetime(2026, 10, 24, 20, 0, tzinfo=TZ))
        self.assertEqual(used, M.LADDER[0])
        self.assertIn('### 3–13 天前动过的', text)
        self.assertNotIn('4–14', text)
        self.assertIn('- 很久 · 09-01 · 进行中', text)
        self.assertIn('只记个名', text)

    def test_ladder_monotonic(self):
        for a, b in zip(M.LADDER, M.LADDER[1:]):
            self.assertTrue(all(y <= x for x, y in zip(a, b)), (a, b))
            self.assertNotEqual(a, b)

    def test_people_headings_demoted_and_stamp(self):
        """人物近况里的「## 人名」降级（F64）；标题带「写于 MM-DD」，超过 36 小时提示可能过时。"""
        d = Path(self.tmp) / 'memory/midterm'
        d.mkdir(parents=True, exist_ok=True)
        (d / 'people.md').write_text('<!-- 写于 2026-10-22 03:10 -->\n# 人物近况\n\n## laolin\n- 忙\n## 小禾\n- 开心\n', encoding='utf-8')
        (d / 'self.md').write_text('# 这两天的我\n\n这两天在做视频。\n', encoding='utf-8')
        ts = dt.datetime(2026, 10, 24, 3, 0, tzinfo=TZ).timestamp()
        os.utime(d / 'self.md', (ts, ts))
        M.WS = Path(self.tmp)
        text, _ = M.render(None, dt.datetime(2026, 10, 24, 20, 0, tzinfo=TZ))
        self.assertIn('### 人物近况（写于 10-22）', text)
        self.assertIn('已经 2 天没整理，可能过时', text)
        self.assertIn('#### 小禾', text)
        self.assertNotIn('\n## 小禾', text)
        self.assertNotIn('写于 2026-10-22 03:10', text)        # 元数据行不进正文
        self.assertIn('### 这两天的我（写于 10-24）', text)       # 没有写于行：按修改时间
        self.assertNotIn('这两天的我（写于 10-24）\n（已经', text)

    def test_near_from_export(self):
        """2 期：退役开关开了（archive 里有 laolin.md），人物近况读 hhd 导出的 ledger/people/near.md、写于照它；
        没开时 near.md 就算在（hhd 部署起就导出、迁移前只有标题）也照旧读 memory/midterm/people.md。"""
        d = Path(self.tmp)
        (d / 'memory/midterm').mkdir(parents=True, exist_ok=True)
        (d / 'memory/midterm/people.md').write_text('<!-- 写于 2026-10-22 03:10 -->\n# 人物近况\n\n## laolin\n- 旧文件：忙\n', encoding='utf-8')
        (d / 'ledger/people').mkdir(parents=True, exist_ok=True)
        (d / 'ledger/people/near.md').write_text('<!-- 写于 2026-11-03 03:16 -->\n# 人物近况\n\n#### laolin\n- 导出：在赶 PR（e0101）\n\n'
                                                 '#### 小禾\n- 导出：周末听音乐会\n', encoding='utf-8')
        M.WS = d
        now = dt.datetime(2026, 11, 4, 9, 0, tzinfo=TZ)
        self.assertFalse(M.retired_active())
        text, _ = M.render(None, now)
        self.assertIn('### 人物近况（写于 10-22）', text)
        self.assertIn('旧文件：忙', text)
        self.assertNotIn('导出：', text)
        a = d / 'memory/archive/retired-20261103'
        a.mkdir(parents=True)
        (a / 'laolin.md').write_text('# laolin\n', encoding='utf-8')
        self.assertTrue(M.retired_active())
        text, _ = M.render(None, now)
        self.assertIn('### 人物近况（写于 11-03）\n#### laolin\n- 导出：在赶 PR（e0101）', text)
        self.assertIn('#### 小禾\n- 导出：周末听音乐会', text)
        self.assertNotIn('旧文件：忙', text)
        self.assertNotIn('写于 2026-11-03', text)
        self.assertNotIn('可能过时', text)                        # 29 小时前写的


class Leaving(unittest.TestCase):
    def test_leaving(self):
        tmp = tempfile.mkdtemp()
        thread(tmp, 'old', '# old\n<!-- 事件线 最近进展=2026-10-10 -->\n## 经过\n')   # 昨天 13 天，今天 14 天
        thread(tmp, 'new', '# new\n<!-- 事件线 最近进展=2026-10-20 -->\n## 经过\n')
        M.WS = Path(tmp)
        self.assertEqual([t.name for t in M.leaving(dt.date(2026, 10, 24))], ['old'])

    def test_leaving_uses_rendered_window(self):
        """快照缩过窗（一句话只放 7 天）：按实际渲染的窗口算，滑出那天就报，不会两边都不在。"""
        tmp = tempfile.mkdtemp()
        thread(tmp, 'mid', '# mid\n<!-- 事件线 最近进展=2026-10-17 -->\n## 经过\n')   # 昨天 6 天，今天 7 天
        M.WS = Path(tmp)
        self.assertEqual(M.leaving(dt.date(2026, 10, 24)), [])          # 没缩窗：还在一句话档
        for day in ('2026-10-23', '2026-10-24'):
            now = dt.datetime.fromisoformat(day + 'T12:00:00').replace(tzinfo=TZ)
            M.remember_window((3, 7, 60), now)
        self.assertEqual([t.name for t in M.leaving(dt.date(2026, 10, 24))], ['mid'])
        log = json.loads((Path(tmp) / M.WINDOW_LOG).read_text(encoding='utf-8'))
        self.assertEqual(log['2026-10-24'], {'min': [3, 7, 60], 'max': [3, 7, 60]})

    def test_remember_window_min_max(self):
        tmp = tempfile.mkdtemp()
        M.WS = Path(tmp)
        now = dt.datetime(2026, 10, 24, 12, 0, tzinfo=TZ)
        self.assertTrue(M.remember_window((3, 14, 60), now))
        self.assertTrue(M.remember_window((2, 7, 60), now))
        self.assertFalse(M.remember_window((3, 10, 60), now))   # 在 min/max 之间，不用写
        self.assertEqual(M.window_for(dt.date(2026, 10, 24), 'min'), (2, 7, 60))
        self.assertEqual(M.window_for(dt.date(2026, 10, 24), 'max'), (3, 14, 60))
        self.assertEqual(M.window_for(dt.date(2026, 10, 23), 'min'), M.LADDER[0])


if __name__ == '__main__':
    unittest.main()
