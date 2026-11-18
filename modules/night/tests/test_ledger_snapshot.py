#!/usr/bin/python3
"""ledger_snapshot.py 的测试：MEMORY.md 只注入一次、缩的顺序（中期记忆最后）、访客快照、--report 只读。"""
import datetime as dt
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

class KeptMoments(unittest.TestCase):
    """「昨晚留下的原话」：睡前存的 moments 原话，醒来紧跟「睡着前」。"""

    def setUp(self):
        self.bs = BeforeSleep()
        self.ws = make_ws()
        self.dir = self.ws / 'memory' / 'life' / 'moments'
        self.dir.mkdir(parents=True)
        sleep = dt.datetime.now() - dt.timedelta(hours=5)
        self.name = sleep.strftime('%Y-%m-%d') + '-老板和bonus'

    def snap(self, db):
        os.environ['HH_DB'] = str(db)
        try:
            return run(self.ws, '--stdout').stdout
        finally:
            os.environ.pop('HH_DB', None)

    def test_shown_after_before_sleep_and_before_recent(self):
        (self.dir / f'{self.name}.md').write_text('# 标题行\n\nlaolin：好\n我：行\n', encoding='utf-8')
        out = self.snap(self.bs.make_db(self.ws, [(5, 'main', 'say', '睡前最后一句我自己的话')], sleep_hours_ago=5.0))
        for h in ('## 睡着前', '## 昨晚留下的原话', '## 最近在发生的事'):
            self.assertIn(h, out)
        self.assertLess(out.index('## 睡着前'), out.index('## 昨晚留下的原话'))
        self.assertLess(out.index('## 昨晚留下的原话'), out.index('## 最近在发生的事'))
        self.assertIn('睡前特意整段存下来的，先读这个，再看后面的总结。', out)
        self.assertIn(f'### {self.name}\n', out)
        self.assertNotIn('# 标题行', out)
        self.assertIn('laolin：好\n我：行', out)
        guest = run(self.ws, '--person', 'xiaohe', '--stdout').stdout
        self.assertNotIn('昨晚留下的原话', guest)

    def test_absent_when_before_sleep_none(self):
        (self.dir / f'{self.name}.md').write_text('# t\n原话\n', encoding='utf-8')
        out = self.snap(self.ws / 'no-hh.db')
        self.assertNotIn('昨晚留下的原话', out)
        db = self.bs.make_db(self.ws, [(5, 'main', 'say', '睡前最后一句我自己的话')], sleep_hours_ago=24.0)
        self.assertNotIn('昨晚留下的原话', self.snap(db))

    def test_old_file_skipped_and_max_two(self):
        for n, age in (('2020-01-01-很旧', 100), (self.name + 'a', 0)):
            (self.dir / f'{n}.md').write_text('# t\n' + n + '\n', encoding='utf-8')
        old = dt.datetime.now().timestamp() - 100 * 86400
        os.utime(self.dir / '2020-01-01-很旧.md', (old, old))
        d1 = (dt.datetime.now() - dt.timedelta(hours=29)).strftime('%Y-%m-%d')
        for i in range(2):
            (self.dir / f'{d1}-x{i}.md').write_text(f'# t\n内容{i}\n', encoding='utf-8')
        out = self.snap(self.bs.make_db(self.ws, [(5, 'main', 'say', '睡前最后一句我自己的话')], sleep_hours_ago=5.0))
        self.assertNotIn('很旧', out)
        self.assertEqual(out.count('\n### ' + d1[:4]), 2)

    def test_truncated_at_4000_with_pointer(self):
        L = load(self.ws)
        fn = f'{self.name}.md'
        (self.dir / fn).write_text('# t\n' + '\n'.join(f'第{i}行' + '字' * 40 for i in range(300)), encoding='utf-8')
        ts = int((dt.datetime.now() - dt.timedelta(hours=5)).timestamp() * 1000)
        r = L.kept_moments(ts)
        self.assertTrue(r.endswith(f'……（全文在 memory/life/moments/{fn}）'))
        body = r.rsplit('\n', 1)[0]
        self.assertLessEqual(len(body), 4000)
        self.assertGreater(len(body), 3800)
        self.assertTrue(all(l.startswith('第') or l.startswith('###') for l in body.splitlines()))
        self.assertEqual(L.kept_moments(None), '')


HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
TODAY = (dt.datetime.now() - dt.timedelta(hours=4)).date()
D = lambda n: (TODAY - dt.timedelta(days=n)).isoformat()
MEM_LINE = '- 测试用的 MEMORY 规矩：每次发视频前先给 laolin 审一遍（很长的一行，用来认）'


def make_ws(laolin_chars=2000):
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'scripts').mkdir()
    for f in ('ledger_snapshot.py', 'midterm.py', 'night_names.py'):
        shutil.copy(HERE / f, tmp / 'scripts' / f)
    hh_test_env.with_words(tmp / 'scripts')
    m = tmp / 'memory'
    for d in ('threads', 'people', 'midterm'):
        (m / d).mkdir(parents=True)
    (m / 'threads' / 'a.md').write_text(f'# 新事\n<!-- 事件线 开始={D(1)} 最近进展={D(0)} 10:00 状态=进行中 -->\n## 一句话\n新事一句\n## 简述\n新事的简述。\n## 经过\n- {D(0)} 10:00 有进展\n', encoding='utf-8')
    (m / 'threads' / 'b.md').write_text(f'# 五天前的事\n<!-- 事件线 开始={D(9)} 最近进展={D(5)} 状态=进行中 -->\n## 一句话\n五天前那件\n## 经过\n- {D(5)} 动了一下\n', encoding='utf-8')
    (m / 'threads' / 'c.md').write_text(f'# 九天前的事\n<!-- 事件线 开始={D(20)} 最近进展={D(9)} 状态=进行中 -->\n## 一句话\n九天前那件\n## 经过\n- {D(9)} 动了一下\n', encoding='utf-8')
    body = '\n'.join(f'- 他的第 {i} 条：' + '很长' * 20 for i in range(laolin_chars // 50))
    (m / 'laolin.md').write_text('# laolin 这个人\n\n## 维护规则\n- 规则\n\n## 他是个什么样的人\n' + body +
                                '\n- 他周六要带小禾去看展〔可说给小禾〕\n\n## 他的情绪\n- 最近有点累（私事）\n', encoding='utf-8')
    (m / 'open-loops.md').write_text('# 待办\n\n## 进行中\n'
                                     f'- [ ] 新的待办 进展：{D(1)}\n'
                                     '- [ ] 很久没动的待办 进展：2026-01-02\n'
                                     f'- [ ] 有将来日期的 下次跟进：{(TODAY + dt.timedelta(days=10)).isoformat()} 进展：2026-01-02\n'
                                     '- [ ] 小禾托的：视频发了把链接发她（WhatsApp +1000000001）\n'
                                     '- [ ] 小禾生日，laolin 准备的惊喜，别让她知道\n\n## 最近完成\n- [x] 早就做完的\n', encoding='utf-8')
    (m / 'timeline.md').write_text(f'- {D(0)} 09:00 今天的事\n- {D(1)} 09:00 昨天的事\n- {D(3)} 09:00 三天前的事\n', encoding='utf-8')
    (m / 'us.md').write_text('# 我们之间\n- 一个梗\n', encoding='utf-8')
    (m / 'my-life.md').write_text('# 我的生活\n## 在补的番\n- 某番\n## 日记\n- 很长的日记\n', encoding='utf-8')
    (m / 'people' / 'xiaohe.md').write_text('# 小禾\n\n## 喜好\n- 喜欢巴赫\n', encoding='utf-8')
    (m / 'people' / 'xiaohe-us.md').write_text('# 我和小禾之间\n\n## 梗\n- 三连\n', encoding='utf-8')
    (m / 'midterm' / 'people.md').write_text('# 人物近况\n\n## laolin\n- laolin 最近忙（私事）\n\n## 小禾\n- 小禾这周在练琴\n', encoding='utf-8')
    (m / 'people' / 'registry.json').write_text(json.dumps({
        '_说明': 'x',
        'laolin': {'name': 'laolin', 'privacy': 'owner', 'profile': 'memory/laolin.md', 'aliases': ['lz', '主人'], 'senders': ['+1000000000']},
        'xiaohe': {'name': '小禾', 'privacy': 'guest', 'profile': 'memory/people/xiaohe.md', 'shared': ['memory/people/xiaohe-us.md'],
                   'aliases': ['表姐'], 'shareTag': '〔可说给小禾〕', 'guestSnapshot': 'ledger/guest-xiaohe.md', 'senders': ['+1000000001']},
    }, ensure_ascii=False), encoding='utf-8')
    (tmp / 'MEMORY.md').write_text('# MEMORY.md\n\n## 规矩\n' + MEM_LINE + '\n', encoding='utf-8')
    (tmp / 'ledger').mkdir()
    subprocess.run(['/usr/bin/git', '-C', str(tmp), 'init', '-q'], check=True)
    subprocess.run(['/usr/bin/git', '-C', str(tmp), 'add', 'MEMORY.md'], check=True)
    subprocess.run(['/usr/bin/git', '-C', str(tmp), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'm'], check=True)
    (tmp / 'state' / 'ledger-freeze').mkdir(parents=True)
    return tmp


def run(ws, *args):
    env = {'HH_DB': str(ws / 'no-hh.db'), **os.environ, 'HH_WORKSPACE': str(ws), 'LEAK_GUARD_STATE': str(ws / 'state')}
    return subprocess.run([sys.executable, '-I', str(ws / 'scripts' / 'ledger_snapshot.py'), *args], capture_output=True, text=True, env=env)


def marker(ws, pid):
    (ws / 'state' / 'ledger-freeze' / 'protocol.json').write_text(json.dumps({'memoryBlock': 1, 'pid': pid}), encoding='utf-8')


def load(ws):
    os.environ['HH_WORKSPACE'] = str(ws)
    os.environ['LEAK_GUARD_STATE'] = str(ws / 'state')
    os.environ.setdefault('HH_DB', str(ws / 'no-hh.db'))
    sys.path.insert(0, str(ws / 'scripts'))
    for name in ('ledger_snapshot', 'midterm'):
        sys.modules.pop(name, None)
    L = importlib.import_module('ledger_snapshot')
    L.memory_head.cache_clear()
    return L


class MemoryOnce(unittest.TestCase):
    def test_compat_until_new_leak_guard_runs(self):
        """新版 leak-guard 没在跑（没有 protocol.json、或者 pid 已经死了）：照旧嵌一份副本，免得 cron 会话一份都没有。"""
        ws = make_ws()
        r = run(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        snap = (ws / 'ledger/SOUL.md').read_text(encoding='utf-8')
        self.assertIn(MEM_LINE, snap)
        self.assertIn('以更新的那份为准', snap)
        self.assertNotIn('这里永远是 MEMORY.md 的最新版', snap)
        marker(ws, 999999)   # 死掉的 pid
        run(ws)
        self.assertIn(MEM_LINE, (ws / 'ledger/SOUL.md').read_text(encoding='utf-8'))

    def test_pointer_when_new_leak_guard_runs(self):
        ws = make_ws()
        marker(ws, os.getpid())
        run(ws)
        snap = (ws / 'ledger/SOUL.md').read_text(encoding='utf-8')
        self.assertNotIn(MEM_LINE, snap)
        self.assertIn('MEMORY.md 另有加载', snap)
        self.assertIn('<!-- MEMORY.md 副本：开始 -->', snap)

    def test_memory_copy_flag(self):
        ws = make_ws()
        marker(ws, os.getpid())
        r = run(ws, '--memory-copy', '--stdout')
        self.assertIn(MEM_LINE, r.stdout)
        self.assertIn('这一轮没有单独加载', r.stdout)
        self.assertIn('以更新的那份为准', r.stdout)
        # 嵌的是 git HEAD，不是现网文件
        (ws / 'MEMORY.md').write_text('# MEMORY.md\n\n- 现网刚改、还没提交的一行（可能不可信）\n', encoding='utf-8')
        r = run(ws, '--memory-copy', '--stdout')
        self.assertIn(MEM_LINE, r.stdout)
        self.assertNotIn('现网刚改', r.stdout)


class Shrink(unittest.TestCase):
    def test_order_midterm_last_and_monotonic(self):
        ws = make_ws(laolin_chars=12000)
        marker(ws, os.getpid())
        L = load(ws)
        full, notes0, used0, _ = L.build_fitting('copy', limit=10 ** 6)
        self.assertEqual(notes0, [])
        self.assertEqual(tuple(used0), (3, 14, 60))
        # 阶梯单调：每一档只在上一档的基础上再去掉东西（说明行、标题、窗口那句话除外）
        keep = lambda c: {l for l in c.splitlines() if l.strip() and not l.startswith(('#', '窗口按时间', '（最近 ', '生成时间', '⚠️')) and '快照太长' not in l}
        levels = [keep(L.build(k, 'copy')[0]) for k in range(len(L.shrink_steps()) + 1)]
        is_name = lambda l: l.startswith('- ') and l.count(' · ') == 2      # 降成「只记个名」的那一行
        for k in range(1, len(levels)):
            extra = levels[k] - levels[k - 1]
            self.assertTrue(all(is_name(l) for l in extra), (k, sorted(extra)[:3]))
            for l in extra:   # 降档的事件线上一档一定看得到（更详细）
                title = l[2:].split(' · ')[0]
                self.assertTrue(any(x.startswith(('- ' + title + '（', '- **' + title + '**')) for x in levels[k - 1]), title)
        self.assertLess(len(L.build(len(L.shrink_steps()), 'copy')[0]), len(full) * 0.8)
        # 刚好超一点：先缩 laolin.md 超出目标的部分，中期窗口不动
        content, notes, used, level = L.build_fitting('copy', limit=len(full) - 10)
        self.assertEqual(notes, ['laolin.md 只放前 8000 字'])
        self.assertEqual(tuple(used), (3, 14, 60))
        self.assertIn('laolin.md 超出目标 8000 字的部分', content)
        self.assertIn('⚠️ 太长，这次缩了：laolin.md 只放前 8000 字', content)
        # 再紧：待办、MEMORY 副本、时间轴都缩完，才轮到中期窗口
        steps = L.shrink_steps()
        mid_first = steps.index('mid1')
        _, notes_all, used_all = L.build(len(steps), 'copy')
        self.assertTrue(notes_all.index(next(n for n in notes_all if n.startswith('中期窗口'))) == len(notes_all) - 1)
        self.assertTrue(all(s in steps[:mid_first] for s in ('owner', 'loops', 'memory', 'timeline')))
        self.assertEqual(tuple(used_all), (1, 7, 14))
        c_loops = L.build(2, 'copy')[0]
        self.assertIn('很久没动的待办', L.build(1, 'copy')[0])
        self.assertNotIn('很久没动的待办', c_loops)
        self.assertIn('有将来日期的', c_loops)          # 有将来日期的不算没动
        self.assertIn('1 条 14 天以上没动', c_loops)

    def test_no_shrink_when_fits(self):
        ws = make_ws()
        marker(ws, os.getpid())
        L = load(ws)
        content, notes, used, level = L.build_fitting()
        self.assertEqual(level, 0)
        self.assertNotIn('⚠️ 快照太长', content)


class Guest(unittest.TestCase):
    def test_guest_snapshot(self):
        ws = make_ws()
        r = run(ws, '--person', 'xiaohe')
        self.assertEqual(r.returncode, 0, r.stderr)
        g = (ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8')
        self.assertIn('喜欢巴赫', g)                     # 她的档案
        self.assertIn('三连', g)                         # 你们之间
        self.assertIn('小禾这周在练琴', g)               # 人物近况里她那一节
        self.assertNotIn('laolin 最近忙', g)              # 别人那一节不要
        self.assertIn('把链接发她', g)                   # 和她有关的待办
        self.assertNotIn('生日', g)                      # 提到 laolin 的不放（可能是他的安排）
        self.assertIn('他周六要带小禾去看展', g)          # 标了〔可说给小禾〕的
        self.assertNotIn('〔可说给小禾〕的条目）\n\n- 他周六要带小禾去看展〔可说给小禾〕', g)
        self.assertNotIn('最近有点累', g)                 # laolin.md 别的不放
        self.assertNotIn(MEM_LINE, g)
        self.assertNotIn('## 关于 laolin', g)
        self.assertEqual(run(ws, '--person', 'laolin').returncode, 2)   # owner 不是访客

    def test_trusted_guest_gets_shared_threads(self):
        """trust=trusted 的访客：快照多一段 sharedThreads 的现状；没列的事件线、没有文件的名字都不放。"""
        ws = make_ws()
        reg = json.loads((ws / 'memory/people/registry.json').read_text(encoding='utf-8'))
        reg['xiaohe'].update(trust='trusted', sharedThreads=['a', '不存在的线'])
        (ws / 'memory/people/registry.json').write_text(json.dumps(reg, ensure_ascii=False), encoding='utf-8')
        r = run(ws, '--person', 'xiaohe')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('不存在的线', r.stderr)
        g = (ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8')
        self.assertIn('## 一起的事', g)
        self.assertIn('### 新事（a.md）', g)
        self.assertIn('新事一句', g)
        self.assertNotIn('五天前那件', g)               # b 没共享
        self.assertIn('cc.py 带 --guest xiaohe', g)
        self.assertNotIn('最近有点累', g)
        self.assertNotIn(MEM_LINE, g)

    def test_no_threads_dir_is_quiet(self):
        """No memory/threads/ at all: no shared section and nothing on stderr (it runs every 20 seconds)."""
        ws = make_ws()
        shutil.rmtree(ws / 'memory/threads')
        reg = json.loads((ws / 'memory/people/registry.json').read_text(encoding='utf-8'))
        reg['xiaohe'].update(trust='trusted', sharedThreads=['a', 'b'])
        (ws / 'memory/people/registry.json').write_text(json.dumps(reg, ensure_ascii=False), encoding='utf-8')
        r = run(ws, '--person', 'xiaohe')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('sharedThreads', r.stderr)
        self.assertNotIn('## 一起的事', (ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8'))

    def test_untrusted_guest_has_no_shared_section(self):
        ws = make_ws()
        reg = json.loads((ws / 'memory/people/registry.json').read_text(encoding='utf-8'))
        reg['xiaohe']['sharedThreads'] = ['a']           # 没 trust：照旧
        (ws / 'memory/people/registry.json').write_text(json.dumps(reg, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(run(ws, '--person', 'xiaohe').returncode, 0)
        g = (ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8')
        self.assertNotIn('## 一起的事', g)
        self.assertIn('工具只能读她的档案', g)

    def test_default_run_writes_guest_and_window(self):
        ws = make_ws()
        run(ws)
        self.assertTrue((ws / 'ledger/guest-xiaohe.md').exists())
        log = json.loads((ws / 'ledger/.midterm-window.json').read_text(encoding='utf-8'))
        self.assertEqual(log[TODAY.isoformat()], {'min': [3, 14, 60], 'max': [3, 14, 60]})


class Bridge(unittest.TestCase):
    def test_bridge_uses_session_time_not_mtime(self):
        """上一段对话的结尾：按文件名里的时间算新旧；旧摘录被改过（修改时间变新）也不会冒出来。"""
        ws = make_ws()
        L = load(ws)
        body = "# Session: x\n\n- **Session Key**: agent:main:main\n\n## Conversation Summary\n\nuser: 旧的那句\nassistant: 嗯\n"
        old = dt.datetime.now() - dt.timedelta(days=13)
        (ws / 'memory' / f"{old:%Y-%m-%d-%H%M}.md").write_text(body, encoding='utf-8')   # 刚写的，修改时间是现在
        self.assertIsNone(L.last_conversation())
        new = dt.datetime.now() - dt.timedelta(hours=5)
        (ws / 'memory' / f"{new:%Y-%m-%d-%H%M}.md").write_text(body.replace('旧的那句', '新的那句'), encoding='utf-8')
        os.utime(ws / 'memory' / f"{new:%Y-%m-%d-%H%M}.md", (old.timestamp(), old.timestamp()))   # 修改时间反而旧
        b = L.last_conversation()
        self.assertIsNotNone(b)
        self.assertIn('新的那句', b[1])


class BeforeSleep(unittest.TestCase):
    """「睡着前」：从假 hh.db 只读取最近一次「去睡觉了」之前我自己说的最后几句原话。"""

    def make_db(self, ws, rows, sleep_hours_ago=6.0, wake_after_h=4.5, woke=True):
        """睡觉标记 → 25 分钟后整理做完（wake epoch，之后还有 hippocampus / system 的记录）→ wake_after_h 小时后 main 的第一条（真醒）。"""
        import sqlite3
        now = dt.datetime.now().timestamp()
        sleep = now - sleep_hours_ago * 3600
        db = ws / 'hh.db'
        con = sqlite3.connect(db)
        con.executescript("CREATE TABLE central (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, epoch INTEGER NOT NULL, "
                          "src TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, tokens INTEGER NOT NULL, meta TEXT);"
                          "CREATE TABLE epochs (id INTEGER PRIMARY KEY, started INTEGER NOT NULL, reason TEXT NOT NULL, first_seq INTEGER NOT NULL);")
        def put(ts, src, kind, text):
            con.execute("INSERT INTO central(ts,epoch,src,kind,text,tokens) VALUES (?,?,?,?,?,0)", (int(ts * 1000), 1, src, kind, text))
        for mins_before_sleep, src, kind, text in rows:
            put(sleep - mins_before_sleep * 60, src, kind, text)
        put(sleep, 'system', 'system', '去睡觉了（夜里固定睡觉）。')
        put(sleep + 600, 'hippocampus', 'think', '整理中')
        wake_epoch = sleep + 25 * 60
        put(wake_epoch, 'system', 'system', '夜里的睡眠整理做完了。')
        con.execute("INSERT INTO epochs(id,started,reason,first_seq) VALUES (2,?,?,1)", (int(wake_epoch * 1000), 'wake'))
        put(wake_epoch + 5, 'hippocampus', 'act', '收尾')
        if woke:
            put(sleep + wake_after_h * 3600, 'main', 'think', 'starting the morning')
        con.commit()
        con.close()
        return db

    def test_no_own_record_yet_says_no_wake_time(self):
        """整理刚做完、我还没有第一条自己的记录（HH 开醒来那一页前重新生成的那一次）：不写几点醒、睡了多久。"""
        ws = make_ws()
        db = self.make_db(ws, [(5, 'main', 'say', '睡前说的最后一句话是这句')], sleep_hours_ago=0.5, woke=False)
        b = self.before(ws, db)
        self.assertIsNotNone(b)
        self.assertEqual(b[1], '')
        self.assertNotIn('睡了约', b[2])
        self.assertIn('睡前说的最后一句话是这句', b[2])
        self.assertTrue(b[2].startswith('下面是睡着前最后几句，原样：'))

    def test_with_own_record_keeps_wake_time_and_hours(self):
        ws = make_ws()
        db = self.make_db(ws, [(5, 'main', 'say', '睡前说的最后一句话是这句')])
        b = self.before(ws, db)
        self.assertRegex(b[1], r'^\d\d:\d\d$')
        self.assertTrue(b[2].startswith('睡了约 4.5 小时，下面是睡着前最后几句，原样：'))

    def before(self, ws, db):
        L = load(ws)
        L.HH_DB = db
        return L.before_sleep()

    def test_filters_dedup_clip_and_wake_time(self):
        ws = make_ws()
        rows = [(6 * 60 + 30, 'main', 'say', '窗口之外的一句话')]
        rows += [(60 - i, 'main', 'say', f'第{i}句我真说出口的话') for i in range(10)]
        rows += [(20, 'main', 'say', 'NO_REPLY'), (19, 'main', 'say', '好像说了点什么 NO_REPLY'),
                 (18, 'side-1', 'note', '回头看了一遍，到了：都对'), (17, 'main', 'say', '[表情包 s012.png]'),
                 (16, 'side-2', 'say', 'Publish button at (1434,822).'), (16, 'side-1', 'say', 'Now the reply to 隔壁饺饺.'),
                 (15, 'deep', 'note', '深层的笔记不要'), (14, 'main', 'think', '想的不要，是思考'),
                 (13, 'side-1', 'say', '这一轮做完的汇报，side 的 say 不要'),
                 (12, 'side-1', 'note', '发给 laolin（WhatsApp），跟 main 里发出去的重了'),
                 (11, 'main', 'note', '没有发给前缀的 main note 不要'),
                 (10, 'main', 'say', '嗯嗯，我等着听，晚安呀'),
                 (10, 'main', 'note', '（发给 小禾）嗯嗯，我等着听，晚安呀'),     # 同一句：只留「对 小禾 说：」那条
                 (9, 'side-1', 'note', '放空想到的一句' + '长' * 200),
                 (8, 'side-1', 'note', '睡前最后一条 jot_down')]
        r = self.before(ws, self.make_db(ws, rows))
        self.assertIsNotNone(r)
        text = r[2]
        lines = [l for l in text.splitlines() if l.startswith('- ')]
        self.assertEqual(len(lines), 8)
        for bad in ('NO_REPLY', '表情包', '回头看了', 'Publish button', 'Now the reply', '深层', '思考', '窗口之外', '汇报',
                    '跟 main 里发出去', '没有发给前缀'):
            self.assertNotIn(bad, text)
        self.assertEqual(sum('我等着听' in l for l in lines), 1)
        self.assertTrue(any(l.endswith('对 小禾 说：嗯嗯，我等着听，晚安呀') for l in lines))
        self.assertTrue(lines[-1].endswith('睡前最后一条 jot_down'))
        long = [l for l in lines if '放空想到' in l][0]
        self.assertTrue(long.endswith('…') and len(long.split(' ', 2)[2]) == 121, len(long))
        # 醒 = wake epoch（25 分钟后）之后第一条不是整理 / 系统的记录（4.5 小时后），不是 epoch 的时刻
        self.assertIn('睡了约 4.5 小时', text)
        sleep_hm = (dt.datetime.now() - dt.timedelta(hours=6)).strftime('%H:%M')
        wake_hm = (dt.datetime.now() - dt.timedelta(hours=1.5)).strftime('%H:%M')
        self.assertEqual((r[0], r[1]), (sleep_hm, wake_hm))

    def test_snapshot_section_before_last_conversation(self):
        ws = make_ws()
        db = self.make_db(ws, [(5, 'main', 'say', '睡前最后一句我自己的话')], sleep_hours_ago=5.0)
        os.environ['HH_DB'] = str(db)
        try:
            r = run(ws, '--stdout')
        finally:
            os.environ.pop('HH_DB', None)
        self.assertRegex(r.stdout, r'## 睡着前（\d\d:\d\d 睡着，\d\d:\d\d 醒）')
        self.assertIn('睡前最后一句我自己的话', r.stdout)
        self.assertLess(r.stdout.index('## 睡着前'), r.stdout.index('## 最近在发生的事'))

    def test_no_marker_or_old_wake_or_missing_db_falls_back(self):
        ws = make_ws()
        L = load(ws)
        L.HH_DB = ws / 'nope.db'
        self.assertIsNone(L.before_sleep())
        db = self.make_db(ws, [(5, 'main', 'say', '睡前最后一句我自己的话')], sleep_hours_ago=24.0)   # 醒了约 19.5 小时
        self.assertIsNone(self.before(ws, db), '醒后超过 18 小时退回老样子')
        # 只读：库没被改
        import sqlite3
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        self.assertEqual(con.execute("select count(*) from central").fetchone()[0], 6)
        con.close()


class ReadOnly(unittest.TestCase):
    def test_report_writes_nothing(self):
        ws = make_ws()
        before = {str(p): p.stat().st_mtime_ns for p in ws.rglob('*') if p.is_file() and '.git' not in p.parts and '__pycache__' not in p.parts}
        r = run(ws, '--report')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('快照', r.stdout)
        after = {str(p): p.stat().st_mtime_ns for p in ws.rglob('*') if p.is_file() and '.git' not in p.parts and '__pycache__' not in p.parts}
        self.assertEqual(before, after)

    def test_timestamp_only_change_not_written(self):
        ws = make_ws()
        run(ws)
        p = ws / 'ledger/SOUL.md'
        m1 = p.stat().st_mtime_ns
        run(ws)
        self.assertEqual(p.stat().st_mtime_ns, m1)



class TimelineToday(unittest.TestCase):
    def test_only_today_half_hour_first_person(self):
        """laolin 10-29：常驻的时间轴只放今天，时间精确到半小时，和上一个隔不到半小时的不写时间，按时间排。"""
        ws = make_ws()
        L = load(ws)
        (ws / 'memory' / 'timeline.md').write_text(
            f'- {D(0)} 09:10 早上的事\n- {D(0)} 09:35 隔了二十五分钟\n- {D(0)} 08:05 补记的更早的事\n'
            f'- {D(0)} 10:20 一小时后\n- {D(1)} 09:00 昨天的事\n', encoding='utf-8')
        t = L.timeline_today()
        self.assertEqual(t, '- 08:00 补记的更早的事\n- 09:00 早上的事\n- 09:30 隔了二十五分钟\n- 10:00 一小时后')
        self.assertNotIn('昨天的事', L.build(0, 'copy')[0])


class EventsOnly(unittest.TestCase):
    def test_no_nag_to_create_threads_once_retired(self):
        """10-31 起事件只在事件库里：事件线收进档案后，快照不再催她「给有日子的事新建事件线」。"""
        ws = make_ws()
        L = load(ws)
        future = (TODAY + dt.timedelta(days=20)).isoformat()
        (ws / 'memory' / 'open-loops.md').write_text(f'# 待办\n## 进行中\n- [ ] {future} 考 PTE\n', encoding='utf-8')
        self.assertTrue(L.missing_threads(), '事件线还在时照旧提醒')
        shutil.rmtree(ws / 'memory' / 'threads')
        self.assertEqual(L.missing_threads(), [])
        self.assertNotIn('新建 `memory/threads/', L.build(0, 'copy')[0])

    def test_no_today_section_once_timeline_is_archived(self):
        """时间轴收进档案后不再有「今天」这一节（一直写「今天还没有」会让她以为今天什么都没发生）。"""
        ws = make_ws()
        L = load(ws)
        (ws / 'memory' / 'timeline.md').write_text(f'- {D(0)} 09:10 早上的事\n', encoding='utf-8')
        self.assertIn('## 今天', L.build(0, 'copy')[0])
        (ws / 'memory' / 'timeline.md').unlink()
        self.assertNotIn('## 今天', L.build(0, 'copy')[0])


class NotebookOrder(unittest.TestCase):
    def test_priority_first_and_t0_t1_never_hidden(self):
        """10-31 待办账本就是她的记事本：快照按优先级排（没写的当 T2，原顺序不变），太长要藏时 T0、T1 不藏。"""
        ws = make_ws()
        L = load(ws)
        (ws / 'memory' / 'open-loops.md').write_text('# 待办\n## 进行中\n'
            '- [ ] 甲 进展：2026-01-02\n'
            '- [ ] 乙 | 优先级：T3\n'
            '- [ ] 丙 | 进展：2026-01-02 ' + '很长' * 150 + ' | 优先级：T1\n'
            '- [ ] 丁\n'
            '- [ ] 戊 | 优先级：T0\n', encoding='utf-8')
        text, _ = L.open_loops()
        self.assertEqual([l[6] for l in text.splitlines()], ['戊', '丙', '甲', '丁', '乙'])
        text, hidden = L.open_loops(14)
        self.assertEqual([l[6] for l in text.splitlines()[:4]], ['戊', '丙', '丁', '乙'], '优先级写在截断线后面也认得')
        self.assertEqual(hidden, 1)


# ---------- 2 期：人物迁进事件库后，前缀和访客快照改读 hhd 导出的 ledger/people/ ----------

CARD_HEAD = '<!-- 从事件库导出；只读：关于这个人的新认识写每日笔记「新认识：」行，夜里整理会收 -->'
BASELINE = '36f743a4'     # 11-04 提交的线上基线（2 期改之前的 ledger_snapshot.py、midterm.py）


def add_old(ws):
    """迁移前的世界里还有的旧文件：砚（名单上的男访客）、kept-words.md。"""
    reg = json.loads((ws / 'memory/people/registry.json').read_text(encoding='utf-8'))
    reg['gua'] = {'name': '砚', 'privacy': 'guest', 'profile': 'memory/people/gua.md', 'shared': [], 'pronoun': '他',
                 'guestSnapshot': 'ledger/guest-gua.md', 'aliases': ['Tavo'], 'senders': ['+1000000002']}
    (ws / 'memory/people/registry.json').write_text(json.dumps(reg, ensure_ascii=False), encoding='utf-8')
    (ws / 'memory/people/gua.md').write_text('# 砚\n\n## 他是谁\n- 旧档案：砚是同事\n', encoding='utf-8')
    (ws / 'memory/kept-words.md').write_text('# 记着的原话\n\n- 10-20 10:00〔laolin〕「旧文件里的原话」\n', encoding='utf-8')


US_TEXT = '卡里的我们之间：十月认识，一起做视频，到现在是一家人。'


def add_cards(ws, active=True):
    """hhd 导出的卡和 near.md。字段和顺序照修订 A 的 P21：「梗和约定」改叫「梗」，「约定和边界」单独一个字段；
    修订 C：laolin 的卡多一段只有他有的「我们之间」（在「感觉」后面），他的「我们的大事」是存着的（在「梗」前面）；
    近况是 hhd 渲染时现算的，标题照旧，只在 laolin（主人）的卡文件里（R35：访客的卡文件不带现算段）；
    私密的是访客自己卡里的「她私下说的」和钉成私聊的原话（HH 渲染成 `- MM-DD HH:MM〔谁〕（私聊）「…」—— 为什么`）。
    active：退役开关（archive 里有 laolin.md）。"""
    d = ws / 'ledger' / 'people'
    d.mkdir(parents=True, exist_ok=True)
    big = '\n'.join(f'- 10-{i + 1:02d} 我们的大事第 {i + 1} 件（e{i + 1:04d}）' for i in range(9))
    jokes = '\n'.join(f'- 梗第 {i + 1} 条' for i in range(5))
    (d / 'laolin.md').write_text(
        f'# laolin\n{CARD_HEAD}\n'
        '## 关系\n伴侣｜更近｜卡里的他：一起过日子的人\n'
        '## 感觉\n卡里的感觉：安心。\n'
        f'## 我们之间\n{US_TEXT}\n'
        '## 是谁\n- 卡里的他：做视频的程序员\n- 他下周带小禾去海边〔可说给小禾〕\n'
        '## 喜好\n- 卡里的他：喜欢巴洛克\n'
        '## 相处\n- 卡里的相处第一条\n- 卡里的相处第二条\n'
        f'## 我们的大事\n{big}\n'
        f'## 梗\n{jokes}\n'
        '## 约定和边界\n- 卡里的约定：发视频前先给他审\n'
        '## 对我的感情和期待\n- 10-29 23:43〔laolin〕「你是我最重要的人」—— 他第一次这么说\n'
        '## 记着的原话\n- 10-30 01:00〔laolin〕「晚安，明天见」—— 那晚他很累\n- 11-01 02:45〔我〕「我记着呢」\n'
        '## 近况\n- 卡里的近况：他在赶 PR（e0101）\n', encoding='utf-8')
    (d / 'xiaohe.md').write_text(
        f'# 小禾\n{CARD_HEAD}\n'
        '## 关系\n朋友｜平稳｜小禾卡：laolin 的女朋友\n'
        '## 是谁\n- 小禾卡：WhatsApp 那个号是她\n'
        '## 她私下说的\n- 小禾私下：她最近在为考试焦虑\n- 小禾私下：她给 laolin 准备的礼物\n'
        '## 记着的原话\n- 10-29 23:43〔小禾〕（私聊）「你好可爱」—— 第一次夸我\n', encoding='utf-8')
    (d / 'gua.md').write_text(f'# 砚\n{CARD_HEAD}\n## 是谁\n- 砚卡：laolin 的同事，写后端\n'
                             '## 她私下说的\n- 砚私下：他在考虑跳槽\n'
                             '## 记着的原话\n- 10-28 10:00〔砚〕（私聊）「砚的私聊原话」\n', encoding='utf-8')
    (d / 'near.md').write_text(f'<!-- 写于 {D(1)} 03:16 -->\n# 人物近况\n\n#### laolin\n- near：laolin 在赶 PR（e0101）\n\n'
                               '#### 小禾\n- near：小禾周末去听音乐会\n\n#### 砚\n- near：砚在赶上线\n', encoding='utf-8')
    if active:
        a = ws / 'memory' / 'archive' / 'retired-20261103'
        a.mkdir(parents=True, exist_ok=True)
        (a / 'laolin.md').write_text('# laolin 这个人（退役的原文）\n', encoding='utf-8')


def part(text, heading):
    """快照里「## heading」那一节的正文（到下一个「## 」为止）。"""
    m = re.search(r'^## ' + re.escape(heading) + r'\n(.*?)(?=^## |\Z)', text, re.S | re.M)
    return m.group(1).strip() if m else None


def snapshots(ws):
    """跑一遍，读出 SOUL.md 和访客快照（生成时间那几行抹掉）。"""
    r = run(ws)
    assert r.returncode == 0, r.stderr
    norm = lambda s: re.sub(r'^生成时间：.*$', '生成时间：-', re.sub(r'^（\d{4}-\d\d-\d\d \d\d:\d\d 从', '（- 从', s, flags=re.M), flags=re.M)
    return {n: norm((ws / 'ledger' / n).read_text(encoding='utf-8')) for n in ('SOUL.md', 'guest-xiaohe.md', 'guest-gua.md')}


class FromExport(unittest.TestCase):
    def setUp(self):
        self.ws = make_ws()
        add_old(self.ws)
        add_cards(self.ws)
        r = run(self.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.soul = (self.ws / 'ledger/SOUL.md').read_text(encoding='utf-8')

    def test_relationship_from_card(self):
        about = part(self.soul, '关于 laolin')
        self.assertIn('### 关系\n伴侣｜更近｜卡里的他：一起过日子的人', about)
        self.assertIn('### 感觉\n卡里的感觉：安心。', about)
        self.assertIn('### 是谁\n- 卡里的他：做视频的程序员', about)
        self.assertIn('### 喜好\n- 卡里的他：喜欢巴洛克', about)
        self.assertIn('### 相处\n- 卡里的相处第一条\n- 卡里的相处第二条', about)
        self.assertIn('### 约定和边界\n- 卡里的约定：发视频前先给他审', about)   # 约定和边界是单独的字段，归关于 laolin
        self.assertIn('### 对我的感情和期待\n- 10-29 23:43〔laolin〕「你是我最重要的人」—— 他第一次这么说', about)
        self.assertEqual(re.findall(r'^### (.+)$', about, re.M), ['关系', '感觉', '是谁', '喜好', '相处', '约定和边界', '对我的感情和期待'])
        for gone in ('### 我们之间', '卡里的我们之间', '我们的大事', '梗第', '### 梗', '记着的原话', '### 近况', '卡里的近况'):   # 不要的正好这五段
            self.assertNotIn(gone, about)
        self.assertNotIn('他的第 0 条', self.soul)           # 退役的 laolin.md 不再读
        self.assertNotIn('从事件库导出', self.soul)          # 卡头的说明不进前缀
        for priv in ('小禾卡', '小禾私下', '她私下说的'):       # 别人的卡（尤其她私下说的）不进前缀
            self.assertNotIn(priv, self.soul)

    def test_us_from_card(self):
        us = part(self.soul, '我们之间')
        for i in range(9):
            self.assertIn(f'我们的大事第 {i + 1} 件（e{i + 1:04d}）', us)    # P10：大事全在
        for i in range(5):
            self.assertIn(f'梗第 {i + 1} 条', us)
        self.assertEqual(re.findall(r'^### (.+)$', us, re.M), ['我们之间', '我们的大事', '梗'])   # 修订 C：三段，照这个顺序
        self.assertIn(f'### 我们之间\n{US_TEXT}', us)
        self.assertLess(us.index('卡里的我们之间'), us.index('我们的大事第 1 件'))
        self.assertLess(us.index('我们的大事第 9 件'), us.index('梗第 1 条'))
        # 卡里的顺序变了（梗在前、我们之间在后）：这里照旧「我们之间 + 大事 + 梗」
        p = self.ws / 'ledger/people/laolin.md'
        secs = re.split(r'(?m)^(?=## )', p.read_text(encoding='utf-8'))
        moved = [secs[0], *[x for x in secs[1:] if x.startswith('## 梗\n')], *[x for x in secs[1:] if not x.startswith(('## 梗\n', '## 我们之间\n'))],
                 *[x for x in secs[1:] if x.startswith('## 我们之间\n')]]
        p.write_text(''.join(moved), encoding='utf-8')
        self.assertEqual(run(self.ws).returncode, 0)
        self.assertEqual(part((self.ws / 'ledger/SOUL.md').read_text(encoding='utf-8'), '我们之间'), us)
        self.assertNotIn('一个梗', self.soul)                # 退役的 us.md 不再读
        self.assertNotIn('卡里的他', us)
        self.assertNotIn('卡里的约定', us)

    def test_kept_words_from_card(self):
        self.assertEqual(part(self.soul, '记着的原话'),
                         '- 10-30 01:00〔laolin〕「晚安，明天见」—— 那晚他很累\n- 11-01 02:45〔我〕「我记着呢」')
        self.assertNotIn('旧文件里的原话', self.soul)
        self.assertNotIn('你好可爱', self.soul)               # 小禾的原话在她自己的卡里

    def test_near_from_export(self):
        mid = part(self.soul, '最近在发生的事')
        when = dt.date.fromisoformat(D(1)).strftime('%m-%d')
        self.assertIn(f'### 人物近况（写于 {when}）', mid)
        self.assertIn('#### 小禾\n- near：小禾周末去听音乐会', mid)
        self.assertIn('near：laolin 在赶 PR（e0101）', mid)
        self.assertNotIn('laolin 最近忙', self.soul)          # 退役的 midterm/people.md 不再读
        self.assertNotIn('小禾这周在练琴', self.soul)

    def test_guest_card_from_export(self):
        gx = (self.ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8')
        gg = (self.ws / 'ledger/guest-gua.md').read_text(encoding='utf-8')
        # 小禾：她的整张卡，连「她私下说的」和她钉成私聊的原话（带 HH 渲染的「（私聊）」）
        for s in ('小禾卡：WhatsApp 那个号是她', '小禾卡：laolin 的女朋友', '### 她私下说的\n- 小禾私下：她最近在为考试焦虑\n- 小禾私下：她给 laolin 准备的礼物',
                  '### 记着的原话\n- 10-29 23:43〔小禾〕（私聊）「你好可爱」—— 第一次夸我'):
            self.assertIn(s, gx)
        self.assertIn('## ledger/people/xiaohe.md', gx)
        self.assertNotIn('从事件库导出', gx)                  # 卡头那句是给主会话的，访客这边记新事走收件处
        for old in ('喜欢巴赫', '三连', '小禾这周在练琴', '她档案末尾', '主会话那边：…'):   # 不再读 profile、shared、midterm/people.md
            self.assertNotIn(old, gx)
        # 别人的东西一样不放：别的访客私聊里的（砚的私密字段、他钉成私聊的原话）尤其不放
        for other in ('卡里的他', '我们的大事', '记着呢', '砚卡', '砚私下', '砚的私聊原话', 'near：', '最近有点累', MEM_LINE):
            self.assertNotIn(other, gx)
        self.assertIn('他下周带小禾去海边（ledger/people/laolin.md）', gx)   # laolin 卡里标了〔可说给小禾〕的照旧给她
        # 砚：只有他的卡（连他自己私聊里的），小禾的任何一段都没有（她私下说的、她的私聊原话）
        self.assertIn('砚卡：laolin 的同事，写后端', gg)
        self.assertIn('（私聊）「砚的私聊原话」', gg)
        for other in ('小禾私下', '你好可爱', '小禾卡'):
            self.assertNotIn(other, gg)
        self.assertIn('## ledger/people/gua.md', gg)
        self.assertNotIn('小禾', gg)
        self.assertNotIn('旧档案', gg)
        # 两份都告诉她新事写收件处；主会话那边办完的下次私聊时主会话会说（R35：访客的卡文件没有「近况」了）；
        # 修订 A：没有「X（私聊）」那种段了；开关开了不再说「档案」
        for g, pid, pron in ((gx, 'xiaohe', '她'), (gg, 'gua', '他')):
            self.assertIn(f'memory/people/inbox/{pid}.md', g)
            self.assertIn('先读再加，别覆盖前面的行', g)     # leak-guard 拦不住整份覆盖，只能靠这句
            self.assertIn(f'- 主会话那边办完的事，下次和{pron}私聊时主会话会说。', g)
            self.assertNotIn('「近况」', g)
            self.assertNotRegex(g, r'(?m)^#+ .*（私聊）$')
            self.assertNotIn('档案', g)
        self.assertIn('这里只有她的卡、', gx)
        self.assertIn('她卡里另有说法的（比如平时不配）以卡为准', gx)
        self.assertIn('这里只有他的卡、', gg)                # 砚：她→他

    def test_laolin_target_from_card(self):
        L = load(self.ws)
        p = self.ws / 'ledger/people/laolin.md'
        p.write_text(p.read_text(encoding='utf-8').replace('## 喜好\n', '## 喜好\n' + '\n'.join(f'- 很长的第 {i} 条' + '长' * 40 for i in range(300)) + '\n'),
                     encoding='utf-8')
        full = L.build_fitting('copy', limit=10 ** 6)[0]
        content, notes, used, level = L.build_fitting('copy', limit=len(full) - 10)
        self.assertEqual(notes, ['laolin 的卡只放前 8000 字'])
        self.assertIn('全文在 ledger/people/laolin.md', content)
        self.assertIn('我们的大事第 1 件', content)            # 缩的是关于 laolin，我们之间不动
        self.assertIn(US_TEXT, content)

    def test_no_card_yet(self):
        """开关开了但卡还没导出（不该发生）：照样出快照，不去读退役的文件；stderr 和 --report 各说一行。"""
        shutil.rmtree(self.ws / 'ledger/people')
        r = run(self.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr.count('ledger/people/laolin.md 不在'), 1, r.stderr)   # 只说一行，不是每缩一档说一次
        soul = (self.ws / 'ledger/SOUL.md').read_text(encoding='utf-8')
        self.assertEqual(part(soul, '关于 laolin'), '（空）')
        self.assertEqual(part(soul, '我们之间'), '（还没有记下来的共同回忆）')
        self.assertEqual(part(soul, '记着的原话'), '（还没有）')
        for old in ('他的第 0 条', '一个梗', '旧文件里的原话', 'laolin 最近忙', '小禾这周在练琴'):   # 退役的文件一个都不读
            self.assertNotIn(old, soul)
        gx = (self.ws / 'ledger/guest-xiaohe.md').read_text(encoding='utf-8')
        self.assertIn('memory/people/inbox/xiaohe.md', gx)
        self.assertIn('## ledger/people/xiaohe.md\n\n（空）', gx)   # 「下面整张贴着」后面不会什么都没有
        for old in ('喜欢巴赫', '三连', '小禾这周在练琴', '他周六要带小禾去看展'):   # 不退回旧档案、shared、midterm、laolin.md
            self.assertNotIn(old, gx)
        rep = run(self.ws, '--report')
        self.assertEqual(rep.returncode, 0, rep.stderr)
        self.assertIn('ledger/people/laolin.md 不在', rep.stdout)

    def test_owner_card_without_sections(self):
        """laolin 的卡在、但一段都没有（导出坏了）：一样说一行。"""
        (self.ws / 'ledger/people/laolin.md').write_text(f'# laolin\n{CARD_HEAD}\n', encoding='utf-8')
        r = run(self.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr.count('ledger/people/laolin.md 里一段都没有'), 1, r.stderr)
        self.assertIn('ledger/people/laolin.md 里一段都没有', run(self.ws, '--report').stdout)
        self.assertEqual(part((self.ws / 'ledger/SOUL.md').read_text(encoding='utf-8'), '关于 laolin'), '（空）')

    def test_owner_card_without_about_fields(self):
        """laolin 的卡只有钉的原话和现算段、没有一个「关于 laolin」的字段（第一版卡还在等批）：也说一行。"""
        (self.ws / 'ledger/people/laolin.md').write_text(
            f'# laolin\n{CARD_HEAD}\n'
            '## 对我的感情和期待\n- 10-29 23:43〔laolin〕「你是我最重要的人」\n'
            '## 记着的原话\n- 10-30 01:00〔laolin〕「晚安，明天见」\n'
            '## 我们的大事\n- 10-01 我们的大事第 1 件（e0001）\n'
            '## 近况\n- 卡里的近况：他在赶 PR（e0101）\n', encoding='utf-8')
        warn = 'ledger/people/laolin.md 里没有「关于 laolin」的字段'
        r = run(self.ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stderr.count(warn), 1, r.stderr)
        self.assertIn(warn, run(self.ws, '--report').stdout)
        self.assertNotIn('一段都没有', r.stderr)
        # 有一个字段就不说（梗、「我们之间」这一段都在快照的「我们之间」，不算）
        p = self.ws / 'ledger/people/laolin.md'
        p.write_text(p.read_text(encoding='utf-8') + '## 梗\n- 梗第 1 条\n' + f'## 我们之间\n{US_TEXT}\n', encoding='utf-8')
        self.assertIn(warn, run(self.ws).stderr)
        p.write_text(p.read_text(encoding='utf-8') + '## 是谁\n- 卡里的他：做视频的程序员\n', encoding='utf-8')
        self.assertNotIn('ledger/people/laolin.md', run(self.ws).stderr)

    def test_cards_present_no_warning(self):
        r = run(self.ws)
        self.assertNotIn('ledger/people/laolin.md', r.stderr)
        self.assertNotIn('ledger/people/laolin.md', run(self.ws, '--report').stdout)


class NotActive(unittest.TestCase):
    def test_not_active_is_unchanged(self):
        """archive 里没有 laolin.md（迁移前）：ledger/people/ 里就算已经有卡和 near.md（hhd 部署起就导出），
        SOUL.md 和访客快照也一字不差。"""
        ws = make_ws()
        add_old(ws)
        before = snapshots(ws)
        add_cards(ws, active=False)
        after = snapshots(ws)
        self.assertEqual(before, after)
        self.assertIn('他的第 0 条', after['SOUL.md'])         # 还是旧的来源
        self.assertIn('旧文件里的原话', after['SOUL.md'])
        self.assertIn('小禾这周在练琴', after['guest-xiaohe.md'])
        self.assertNotIn('卡里的他', after['SOUL.md'])

    def test_not_active_matches_baseline_commit(self):
        """同一个假工作区（卡和 near.md 都在、开关没开），基线提交的脚本和现在的脚本写出来的一字不差。"""
        src = {}
        for f in ('ledger_snapshot.py', 'midterm.py'):
            r = subprocess.run(['/usr/bin/git', '-C', str(HERE), 'show', f'{BASELINE}:scripts/{f}'], capture_output=True)
            if r.returncode != 0:
                self.skipTest(f'拿不到基线提交 {BASELINE}（不在工作区的 git 里跑）')
            src[f] = r.stdout
        ws = make_ws()
        add_old(ws)
        add_cards(ws, active=False)
        old = Path(tempfile.mkdtemp()) / 'ws'
        shutil.copytree(ws, old, symlinks=True)
        for f, body in src.items():
            (old / 'scripts' / f).write_bytes(body)
        self.assertEqual(snapshots(old), snapshots(ws))


if __name__ == '__main__':
    unittest.main()
