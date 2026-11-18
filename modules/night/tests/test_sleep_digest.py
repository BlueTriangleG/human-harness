#!/usr/bin/python3
"""sleep_digest.py 的测试：假的工作目录 + 假的 OpenClaw 对话库（人名、号码、密码全是编的），不碰真文件。

  /usr/bin/python3 scripts/test_sleep_digest.py
"""
import contextlib
import datetime as dt
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
sys.path.insert(0, str(HERE))
import sleep_digest as S  # noqa: E402
S.HH_CONFIG = Path(tempfile.mkdtemp()) / 'no-hh-config.json'   # 测试不读真的 ~/.hh/config.json（折叠表 memory.promptFolds，运维 11-13）

TZ = S.TZ
G, X = '+1000000011', '+1000000012'          # 假号码：laolin、小禾
DEAD = 'http://127.0.0.1:9'                        # 不通的端口：Honcho 读不到
ZSTD = shutil.which('zstd') or '/opt/homebrew/bin/zstd'


def ms(s):
    return int(dt.datetime.fromisoformat(s).replace(tzinfo=TZ).timestamp() * 1000)


def write(root, rel, text):
    p = Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')


def make_ws(ws):
    reg = {
        '_说明': 'test',
        'laolin': {'name': 'laolin', 'privacy': 'owner', 'senders': [G, G.lstrip('+'), 'laolin'],
                  'sessionKeys': ['agent:main:main'], 'honchoPeers': ['laolin'],
                  'honchoSessions': {'laolin-main': S.honcho_session_id('agent:main:main')}},
        'xiaohe': {'name': '小禾', 'privacy': 'guest', 'senders': [X], 'sessionKeys': [f'agent:main:direct:{X}'],
                   'honchoPeers': ['_' + X.lstrip('+')],
                   'honchoSessions': {'xiaohe-dm': S.honcho_session_id(f'agent:main:direct:{X}')}},
    }
    write(ws, 'memory/people/registry.json', json.dumps(reg, ensure_ascii=False))
    write(ws, 'memory/compactions/2026-10-24-1328.md',
          '# 主会话压缩 2026-10-24-1328\n\n- 会话：s-main\n- 压掉的范围：2026-10-24 09:00 → 2026-10-24 12:00（9 条）\n\n'
          '## 摘要\n\n# 之前聊过的\n## 发生了什么\n- 早上聊了视频\n\n## 原始对话（压掉的部分，供搜索）\n\n'
          '[10-24 09:10] 用户: 早上好，视频今天发吗\n'
          '  第二行：记得先给我看\n'
          '[10-24 09:11] 阿青: 发！我先把稿子给你\n'
          '[10-24 09:12] 用户: [感官] 有新动静（重复提醒）\n'
          '[10-24 09:15] 阿青调用 message: {"action": "send", "target": "' + G + '", "message": "稿子在这"}\n'
          '[10-24 11:59] 用户: 我的抖音密码是 FakePass123\n')
    write(ws, 'memory/2026-10-24.md', '- 00:2x 前一天凌晨的事（算 10-23）\n- 08:10 早上开工\n  - 子项跟着上一行\n'
          '- 09:1x laolin 说「早上好，视频今天发吗」\n- 10:00 laolin 原话：「这句对话里没有过」\n# 笔记里的标题\n')
    write(ws, 'memory/2026-10-25.md', '- 00:1x 凌晨还在弄（算 10-24）\n- 01:05 睡前记一笔\n- 08:00 第二天早上（不算）\n')
    write(ws, 'memory/my-life.md', '# 我的生活\n- 喜欢的东西（没日期）\n- 2026-10-25 01:17 今日小结（10-24）\n'
          '- 2026-10-25 08:30 第二天早上的日记（不算）\n- 2026-10-24 02:00 前一天凌晨（不算）\n- 2026-10-24 14:00 下午看番\n')
    write(ws, 'memory/timeline.md', '- 2026-10-24 10:00 发了视频\n- 2026-10-25 00:1x 凌晨的事（算 10-24）\n- 2026-10-23 12:00 昨天\n')
    write(ws, 'memory/open-loops.md', '# 待办\n## 进行中\n- [ ] 做第二条视频\n- [x] 做完的\n## 最近完成\n')
    write(ws, 'memory/threads/视频.md',
          '# 视频\n<!-- 事件线 开始=2026-10-20 最近进展=2026-10-24 10:00 状态=进行中 -->\n## 一句话\n做视频\n## 简述\n一段。\n'
          '## 现在的状态\n- 2026-10-24 10:00 已发\n## 经过\n- 2026-10-24 10:00 发了第一条\n- 2026-10-22 写稿\n'
          '## 因果和判断\n- 2026-10-24 11:00 laolin 说要多看反应（误写在这里）\n')
    write(ws, 'memory/midterm/self.md', '# 这两天的我\n## 一个二级标题\n你这两天在做视频。\n')
    write(ws, 'memory/midterm/people.md', '# 人物近况\n## laolin\n- 最近在忙\n## 小禾\n- 刚下班\n')
    write(ws, 'soul/20-性格.md', '# 性格\n')
    write(ws, 'skills/x/SKILL.md', '# x\n')
    write(ws, 'MEMORY.md', '# MEMORY\n')
    write(ws, 'memory/sleep/old/input.md', '不该进 sources.json\n')
    write(ws, 'sleep/old/input.md', '不该进 sources.json\n')


def zstd(data):
    r = subprocess.run([ZSTD, '-q', '-c'], input=data, capture_output=True)
    r.check_returncode()
    return r.stdout


def make_db(path, with_zstd=True):
    c = sqlite3.connect(path)
    c.execute('create table session_windows (session_id text primary key, session_key text)')
    c.execute('create table transcript_events (session_id text, seq integer, event_json text, created_at integer, '
              'event_zstd blob, event_utf8_bytes integer, navigation_json text, primary key (session_id, seq))')
    c.execute("insert into session_windows values ('s-main', 'agent:main:main')")
    c.execute("insert into session_windows values ('s-xe', ?)", (f'agent:main:direct:{X}',))
    c.execute("insert into session_windows values ('s-life', 'agent:main:role-life')")
    seq = [0]

    def ev(sid, when, msg, compress=False):
        seq[0] += 1
        e = {'type': 'message', 'id': f'e{seq[0]}', 'message': msg}
        js = json.dumps(e, ensure_ascii=False)
        if compress:
            nav = json.dumps({'navigation': {'message': {'role': msg.get('role')}}})
            b = js.encode('utf-8')
            c.execute('insert into transcript_events values (?,?,?,?,?,?,?)', (sid, seq[0], None, ms(when), zstd(b), len(b), nav))
        else:
            c.execute('insert into transcript_events values (?,?,?,?,?,?,?)', (sid, seq[0], js, ms(when), None, None, None))

    def user(sid, when, text, sender, owner=False, steer=False, channel='whatsapp', compress=False):
        oc = {'senderIsOwner': owner, **({'senderId': sender} if sender else {}),
              **({'transport': {'channel': channel}} if channel else {}), **({'steerTargetRunId': 'r1'} if steer else {})}
        ev(sid, when, {'role': 'user', 'content': text, 'timestamp': ms(when), '__openclaw': oc}, compress)

    def her(sid, when, text):
        ev(sid, when, {'role': 'assistant', 'content': [{'type': 'thinking', 'thinking': 'secret thoughts'},
                                                        {'type': 'text', 'text': text}], 'timestamp': ms(when)})

    def send(sid, when, text, target):
        ev(sid, when, {'role': 'custom', 'customType': 'openclaw.nested-tool.v1', 'content': '', 'timestamp': ms(when),
                       'details': {'toolName': 'message', 'input': {'action': 'send', 'target': target, 'message': text}}})

    user('s-xe', '2026-10-24T18:04:53', '看到你的新视频太高兴了！！三连关注了', X)
    user('s-xe', '2026-10-24T18:04:59', '回去给你提供灵感', X, steer=True)
    her('s-xe', '2026-10-24T18:05:10', '啊啊谢谢你！你是我第一个三连的观众')
    send('s-xe', '2026-10-24T18:06:00', '小禾刚才给我三连了', G)
    user('s-xe', '2026-10-24T19:00:00', '控制台里随手一问', 'gateway-owner', owner=True, channel=None)
    user('s-main', '2026-10-24T17:38:48', '下一步你打算做什么', G, owner=True)
    user('s-main', '2026-10-24T17:40:00', '[感官] 有新动静', None, owner=True, channel=None)
    user('s-main', '2026-10-24T17:41:00', '[OpenClaw heartbeat] ping', None, channel='whatsapp')
    her('s-main', '2026-10-24T17:41:30', 'NO_REPLY')
    her('s-main', '2026-10-24T17:41:40', 'Let me check the files first.')
    send('s-main', '2026-10-24T17:42:00', '我先去看漫画', G)
    if with_zstd:
        user('s-main', '2026-10-24T20:00:00', '这条消息比较长，被 zstd 压过了。' * 3, G, owner=True, compress=True)
    user('s-main', '2026-10-24T09:10:30', '早上好，视频今天发吗\n第二行：记得先给我看', G, owner=True)   # 和存档里那条重复
    user('s-main', '2026-10-24T21:00:00', '[Queued messages while agent was busy]\n\n---\nQueued #1 (from Laolin)\n排队的第一句\n'
         '---\nQueued #2 (from Laolin)\n排队的第二句', G, owner=True)
    user('s-main', '2026-10-24T21:05:00', '[System] Your previous turn was interrupted by a gateway restart.', G, owner=True)
    user('s-main', '2026-10-25T05:00:00', '第二天的消息（不算 10-24）', G, owner=True)
    user('s-main', '2026-10-17T13:07:55', '哈咯', None, channel='openclaw-weixin')
    user('s-life', '2026-10-24T10:00:00', '空闲会话里的东西不进对话', None)
    c.commit()
    c.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.ws, self.root, self.db = self.tmp / 'ws', self.tmp / 'root', self.tmp / 'oc.sqlite'
        make_ws(self.ws)
        make_db(self.db, with_zstd=Path(ZSTD).exists())
        self._saved = (S.WS, S.ROOT, S.DB, S.NOW, S.M.WS, S.R.WS, S.R.REG, S.R.BASE)
        self._learn = S.HH_LEARN
        S.HH_LEARN = self.tmp / 'hh-learn'                 # HH 的学习记录：不读真的 ~/.hh/learn
        self._repair = (S.HH_LOG, S.HH_REPAIR_LOG, S.HH_LIVE)
        S.HH_LOG, S.HH_REPAIR_LOG, S.HH_LIVE = self.tmp / 'hh.jsonl', self.tmp / 'repair.jsonl', self.tmp / 'no-hh'   # 第 9 节：不读真的日志、不跑线上核对

    def tearDown(self):
        S.WS, S.ROOT, S.DB, S.NOW, S.M.WS, S.R.WS, S.R.REG, S.R.BASE = self._saved
        S.HH_LEARN = self._learn
        S.HH_LOG, S.HH_REPAIR_LOG, S.HH_LIVE = self._repair
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args, now='2026-10-25T03:00', db=None):
        argv = list(args) + ['--ws', str(self.ws), '--root', str(self.root), '--db', str(db or self.db),
                             '--honcho', DEAD, '--now', now]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = S.main(argv)
        return code, out.getvalue(), err.getvalue()

    def input_md(self, day='2026-10-24'):
        return (self.root / f'sleep/{day}/input.md').read_text(encoding='utf-8')

    def state(self):
        p = self.root / 'sleep/state.json'
        return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}

    def set_state(self, st):
        p = self.root / 'sleep/state.json'
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(st, ensure_ascii=False), encoding='utf-8')


class TestBuild(Base):
    def test_diary_from_diary_dir(self):
        """日记也写在 memory/diary/<月>.md 里：这一天所在月和下个月两份都要读。"""
        write(self.ws, 'memory/diary/2026-10.md',
              '- 2026-10-24 21:1x 日记甲\n- 2026-10-25 02:3x 日记乙\n- 2026-10-25 09:0x 日记丙\n')
        write(self.ws, 'memory/diary/2026-11.md', '- 2026-10-24 23:5x 日记丁\n')
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        got = '\n'.join(S.diary_lines(dt.date(2026, 10, 24)))
        for s in ('日记甲', '日记乙', '日记丁'):
            self.assertIn(s, got)
        self.assertNotIn('日记丙', got)
        md = self.input_md()
        self.assertIn('日记甲', md)
        self.assertIn('#### 日记（memory/diary/ 和 my-life.md 里今天的条目）', md)

    def test_taste_material(self):
        """11-03 起口味不再按日期抓 taste.md：材料第 3 节末尾一节是每日笔记里「口味：」那几行，加 B站这一天（按 4 点归属）看过的评级。"""
        write(self.ws, 'memory/2026-10-24.md', '- 08:10 早上开工\n- 21:1x 口味：〔史记〕高渐离那句…｜像我\n- 21:30 普通笔记：改了稿子\n')
        seen = [{'ts': 1, 'time': '2026-10-24 20:05', 'bvid': 'BV1a', 'title': '当天的视频', 'up': '某UP', 'verdict': '值得看',
                 'note': '一句话为什么'},
                {'ts': 2, 'time': '2026-10-25 01:30', 'bvid': 'BV1b', 'title': '凌晨看的', 'up': '另一个UP', 'verdict': '可以看'},
                {'ts': 3, 'time': '2026-10-24 22:10', 'bvid': 'BV1d', 'title': '只看过的视频', 'up': '某UP', 'verdict': '看过',
                 'how': 'subtitle'},
                {'ts': 4, 'time': '2026-10-24 22:20', 'bvid': 'BV1e', 'title': '看过还说了话', 'up': '某UP', 'verdict': '看过',
                 'note': '有一句'},
                {'ts': 5, 'time': '2026-10-23 22:00', 'bvid': 'BV1c', 'title': '前一天的视频', 'up': '某UP', 'verdict': '可以看',
                 'note': '昨天的'},
                {'ts': 6, 'time': '2026-10-23 23:00', 'bvid': 'BV1f', 'title': '前一天只看过', 'up': '某UP', 'verdict': '看过'}]
        write(self.ws, 'memory/bili/seen.jsonl', ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in seen))
        write(self.ws, 'memory/life/taste.md', '# 口味日记\n- 10-24 21:00 旧口味日记里的一行\n- 2026-10-24 22:00 带年份的旧行\n')
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        md = self.input_md()
        head = '#### 口味（每日笔记里「口味：」那几行，和 B站看过的评级）〔她说的〕'
        self.assertIn(head, md.split('## 3. 她自己的一天')[1].split('\n## 4.')[0])
        sec = md.split(head)[1].split('\n## ')[0]
        self.assertIn('- 21:1x 口味：〔史记〕高渐离那句…｜像我', sec)
        self.assertIn('- 20:05 《当天的视频》（某UP）：值得看｜一句话为什么', sec)
        self.assertIn('- 01:30 《凌晨看的》（另一个UP）：可以看\n', sec + '\n')   # 凌晨算前一天；没有 note 就不写「｜」
        self.assertIn('- 22:20 《看过还说了话》（某UP）：看过｜有一句', sec)
        self.assertNotIn('只看过的视频', md)                               # 只标了「看过」、没写一句话的不逐条列……
        self.assertIn('- 另外只标了「看过」、没写一句话的 1 条', sec)        # ……只给个条数（前一天的不算）
        self.assertNotIn('普通笔记', sec)
        self.assertNotIn('前一天的视频', md)
        self.assertNotIn('前一天只看过', md)
        self.assertNotIn('旧口味日记里的一行', md)                        # taste.md 11-03 起只读，不再按日期抓
        self.assertNotIn('带年份的旧行', md)
        self.assertEqual(S.taste_lines(dt.date(2026, 10, 25)), [])         # 都没有就不出这一节

    def test_complete_material(self):
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        md = self.input_md()
        lines = md.splitlines()
        self.assertEqual(lines[1], '材料：完整')
        self.assertIn('捕获覆盖率', lines[2])
        self.assertIn('不再算（Honcho 10-31 关了', lines[2])      # Honcho 关了：不再去连它
        conv = md.split('## 1b.')[0]
        self.assertIn('[10-24 18:04] 小禾：看到你的新视频太高兴了！！三连关注了', conv)   # 连发的第一条
        self.assertIn('回去给你提供灵感', conv)
        self.assertIn('我：啊啊谢谢你', conv)
        self.assertNotIn('secret thoughts', md)                  # thinking 不算她说的话
        self.assertIn('laolin（控制台）：控制台里随手一问', conv)
        self.assertNotIn('[感官]', conv)
        self.assertNotIn('OpenClaw heartbeat', conv)
        self.assertNotIn('NO_REPLY', conv)
        self.assertNotIn('Let me check', conv)
        self.assertNotIn('空闲会话里的东西', conv)
        self.assertNotIn('第二天的消息', conv)
        gav = conv.split('### 和laolin')[1].split('### 和小禾')[0]
        self.assertIn('我：小禾刚才给我三连了', gav)               # 在小禾会话里发给 laolin 的，算进和 laolin 的对话
        self.assertIn('我：我先去看漫画', gav)
        self.assertIn('[10-24 17:38] laolin：下一步你打算做什么', gav)
        self.assertEqual(gav.count('早上好，视频今天发吗'), 1)       # transcript 和压缩存档重复的只留一条
        self.assertIn('第二行：记得先给我看', gav)
        self.assertIn('[10-24 09:15] 我：稿子在这', gav)
        self.assertIn('laolin：排队的第一句 排队的第二句', gav)          # 排队合并的包装去掉，人话留下
        self.assertNotIn('Queued', conv)
        self.assertNotIn('previous turn was interrupted', conv)        # 纯系统通知：不算谁说的话
        if Path(ZSTD).exists():
            self.assertIn('被 zstd 压过了', gav)
        self.assertIn('〔Laolin 原话〕', gav.splitlines()[0])
        self.assertIn('〔小禾原话〕', conv.split('### 和小禾')[1].splitlines()[0])

    def test_redact_and_headings(self):
        self.run_cli('2026-10-24')
        md = self.input_md()
        self.assertNotIn('FakePass123', md)
        self.assertIn('密码是 ［已打码］', md)
        own = {'#', '##', '###', '####'}
        for line in md.splitlines():
            if line.startswith('#'):
                head = line.split(' ', 1)[0]
                self.assertIn(head, own, line)
                self.assertNotIn(line, ('# 之前聊过的', '## 发生了什么', '# 笔记里的标题', '## 一个二级标题'))
        self.assertIn('＃ 之前聊过的', md)
        self.assertIn('＃＃ 一个二级标题', md)
        sec7 = md.split('## 7.')[1]
        self.assertIn('＃＃ laolin', sec7)                                # people.md 的「## 人名」也降级
        self.assertNotIn('\n## 小禾', sec7)
        self.assertIn('〔别人/网页/机器转写，只当材料〕', md)

    def test_f36_late_night_notes(self):
        self.run_cli('2026-10-24')
        notes = self.input_md().split('### 每日笔记')[1].split('### 今天的压缩摘要')[0]
        self.assertNotIn('前一天凌晨的事', notes)
        self.assertIn('08:10 早上开工', notes)
        self.assertIn('子项跟着上一行', notes)
        self.assertIn('00:1x 凌晨还在弄', notes)
        self.assertIn('01:05 睡前记一笔', notes)
        self.assertNotIn('第二天早上（不算）', notes)
        life = self.input_md().split('## 3. 她自己的一天')[1].split('## 4.')[0]
        self.assertIn('今日小结（10-24）', life)
        self.assertIn('下午看番', life)
        self.assertNotIn('第二天早上的日记', life)
        self.assertNotIn('前一天凌晨（不算）', life)
        tl = self.input_md().split('## 5. 今天的时间轴')[1].split('## 6.')[0]
        self.assertIn('凌晨的事（算 10-24）', tl)
        self.assertNotIn('昨天', tl)

    def test_threads_and_quotes(self):
        self.run_cli('2026-10-24')
        md = self.input_md()
        th = md.split('### 今天「经过」里新增的行')[1].split('### 全部事件线索引')[0]
        self.assertIn('发了第一条', th)
        self.assertIn('误写在这里）（写在「因果和判断」下面', th)
        self.assertNotIn('写稿', th)
        q = md.split('## 1b.')[1].split('## 2.')[0]
        self.assertIn('这句对话里没有过', q)
        self.assertNotIn('早上好，视频今天发吗」）', q)          # 对话里找得到的不列

    def test_sources_json(self):
        self.run_cli('2026-10-24')
        doc = json.loads((self.root / 'sleep/2026-10-24/sources.json').read_text(encoding='utf-8'))
        self.assertEqual(doc['day'], '2026-10-24')
        self.assertRegex(doc['generated_at'], r'^2026-10-25T03:00:00\+11:00$')
        files = doc['files']
        self.assertIn('memory/threads/视频.md', files)
        self.assertIn('soul/20-性格.md', files)
        self.assertIn('skills/x/SKILL.md', files)
        self.assertIsNone(files['SOUL.md'])
        self.assertIsNone(files['USER.md'])
        self.assertRegex(files['MEMORY.md'], r'^[0-9a-f]{64}$')
        self.assertFalse(any(k.startswith(('memory/sleep/', 'sleep/')) for k in files))
        self.assertFalse(any(not k.endswith('.md') for k in files))

    def test_honcho_not_contacted(self):
        """Honcho 10-31 关了（laolin）：建材料时一次都不去连它，覆盖率那一行写不再算。"""
        calls = []
        saved = S.R.list_msgs
        S.R.list_msgs = lambda *a, **k: calls.append(a) or []
        try:
            self.run_cli("2026-10-24")
        finally:
            S.R.list_msgs = saved
        self.assertEqual(calls, [])
        self.assertIn("不再算（Honcho 10-31 关了", self.input_md().splitlines()[2])


class TestEventsOnly(Base):
    def test_no_threads_points_to_event_store(self):
        """10-31 起事件只在事件库里：事件线和时间轴收进档案后，材料里那几节指向工作单，不再列空的事件线索引。"""
        shutil.rmtree(self.ws / 'memory/threads')
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        md = self.input_md()
        sec4 = md.split('## 4.')[1].split('\n## ')[0]
        self.assertIn('mem_worklist', sec4)
        self.assertNotIn('全部事件线索引', sec4)
        self.assertIn('第 6 节', md.split('## 6b.')[1].split('\n## ')[0])


PEOPLE_HEAD = '#### 白天记下的人（每日笔记「新认识」「记着」「主会话那边」那几行）'
REAPPEARED_HEAD = '白天误写进退役文件的（原路径、内容；照第 7 步收进库）'


class TestPeople2(Base):
    """2 期（人物迁进事件库）：标签行直接生效；兜底收件处、退役文件又冒出来、近况读 near.md 只在开关开了（archive 里有 laolin.md）才生效。"""
    D = dt.date(2026, 10, 24)

    def setUp(self):
        super().setUp()
        S.WS = S.M.WS = self.ws                       # 直接调函数时也读假工作区（tearDown 会换回来）

    def activate(self):
        """模拟迁移那天：退役文件挪进 memory/archive/retired-20261103/（假工作区里只有 midterm/people.md 一个）。"""
        write(self.ws, 'memory/archive/retired-20261103/laolin.md', '# 关于 laolin（退役的原文）\n')
        old = self.ws / 'memory/midterm/people.md'
        if old.exists():
            (self.ws / 'memory/archive/retired-20261103/midterm').mkdir(parents=True, exist_ok=True)
            old.rename(self.ws / 'memory/archive/retired-20261103/midterm/people.md')

    def life(self, md):
        return md.split('## 3. 她自己的一天')[1].split('\n## ')[0]

    def notes_with_tags(self):
        write(self.ws, 'memory/2026-10-24.md',
              '- 00:2x 新认识：〔laolin〕前一天凌晨的（算 10-23）\n- 08:10 早上开工\n'
              '- 09:15 新认识：〔小禾〕喜欢土方｜依据：原话 09:14\n'
              '- 记着：〔laolin 10-24 09:20〕「原话甲」——跟着 09:15 那行\n'
              '- 10:00 主会话那边：〔砚〕帮他查了奶茶\n- 11:00 普通笔记：改了稿子\n'
              '- 12:00 记着：〔laolin 10-24 12:00〕「带钟点的记着」——也算\n')
        write(self.ws, 'memory/2026-10-25.md',
              '- 记着：〔laolin 10-25 00:30〕「文件开头没钟点」——跟着文件的日子（10-25）\n'
              '- 01:05 新认识：〔laolin〕凌晨的（算 10-24）\n'
              '- 记着：〔laolin 10-25 01:06〕「跟着凌晨那行」——算 10-24\n'
              '- 08:00 新认识：〔laolin〕第二天早上（不算）\n'
              '- 记着：〔laolin 10-25 08:01〕「跟着第二天早上」——不算\n')

    def test_tag_lines(self):
        """三种标签都收；凌晨 4 点前的算前一天；「- 记着：」没钟点，跟上一行的日子。"""
        self.notes_with_tags()
        self.assertEqual(S.tag_lines(self.D, '新认识'),
                         ['- 09:15 新认识：〔小禾〕喜欢土方｜依据：原话 09:14', '- 01:05 新认识：〔laolin〕凌晨的（算 10-24）'])
        kept = '\n'.join(S.tag_lines(self.D, '记着'))
        for s in ('原话甲', '带钟点的记着', '跟着凌晨那行'):
            self.assertIn(s, kept)
        for s in ('跟着第二天早上', '文件开头没钟点'):
            self.assertNotIn(s, kept)
        self.assertEqual(S.tag_lines(self.D, '主会话那边'), ['- 10:00 主会话那边：〔砚〕帮他查了奶茶'])
        both = S.tag_lines(self.D, ('新认识', '记着', '主会话那边'))          # 几种一起：照笔记里的顺序
        self.assertEqual(len(both), 6, both)
        self.assertTrue(both[0].startswith('- 09:15 新认识') and both[-1].startswith('- 记着：〔laolin 10-25 01:06〕'), both)
        self.assertEqual(S.tag_lines(dt.date(2026, 10, 23), '新认识'), ['- 00:2x 新认识：〔laolin〕前一天凌晨的（算 10-23）'])
        code, out, _ = self.run_cli('2026-10-24')                          # 没开关也有这一小节（标签行可以先上）
        self.assertEqual(code, 0, out)
        life = self.life(self.input_md())
        self.assertIn(PEOPLE_HEAD, life)
        sec = life.split(PEOPLE_HEAD)[1].split('\n#### ')[0]
        for s in ('喜欢土方', '原话甲', '帮他查了奶茶', '带钟点的记着', '凌晨的（算 10-24）', '跟着凌晨那行'):
            self.assertIn(s, sec)
        for s in ('普通笔记', '早上开工', '前一天凌晨的', '第二天早上（不算）', '跟着第二天早上'):
            self.assertNotIn(s, sec)

    def test_no_tag_lines_no_subsection(self):
        """一行标签都没有（也没开关）：不出这一小节，材料和以前一样。"""
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        self.assertNotIn('白天记下的人', self.input_md())

    def inbox(self):
        write(self.ws, 'memory/people/inbox/xiaohe.md',
              '# 小禾那边记下的\n- 10-24 03:30 前一天凌晨的（算 10-23）\n- 10-24 18:10 她说下周考试\n  - 子项跟着上一行\n'
              '- 10-25 01:20 凌晨的（算 10-24）\n- 10-25 09:00 第二天的（不算）\n')
        write(self.ws, 'memory/people/inbox/gua.md', '- 10-24 20:00 砚说奶茶不用请了\n')

    def test_inbox_lines(self):
        """兜底访客的收件处 memory/people/inbox/<key>.md：这一天（按 4 点归属）的行，前面标〔兜底·<key>〕，并进「白天记下的人」。"""
        self.activate()
        self.inbox()
        got = S.inbox_lines(self.D)
        self.assertEqual(got, ['- 〔兜底·gua〕10-24 20:00 砚说奶茶不用请了', '- 〔兜底·xiaohe〕10-24 18:10 她说下周考试',
                               '  - 子项跟着上一行', '- 〔兜底·xiaohe〕10-25 01:20 凌晨的（算 10-24）'])
        self.assertEqual(S.inbox_lines(dt.date(2026, 10, 23)), ['- 〔兜底·xiaohe〕10-24 03:30 前一天凌晨的（算 10-23）'])
        write(self.ws, 'memory/people/inbox/gua.md', '- 01-01 02:00 跨年凌晨（算 12-31）\n- 12-31 23:00 年底\n')
        self.assertEqual(S.inbox_lines(dt.date(2026, 12, 31)),
                         ['- 〔兜底·gua〕01-01 02:00 跨年凌晨（算 12-31）', '- 〔兜底·gua〕12-31 23:00 年底'])
        self.inbox()
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        life = self.life(self.input_md())
        self.assertIn(PEOPLE_HEAD, life)                                    # 没有标签行，光有收件处也出这一小节
        sec = life.split(PEOPLE_HEAD)[1]
        self.assertIn('- 〔兜底·xiaohe〕10-24 18:10 她说下周考试', sec)
        self.assertIn('- 〔兜底·gua〕10-24 20:00 砚说奶茶不用请了', sec)
        self.assertNotIn('第二天的（不算）', sec)

    def test_inbox_not_read_before_migration(self):
        """开关没开：收件处不读（迁移前没有兜底写它）。"""
        self.inbox()
        self.assertEqual(S.inbox_lines(self.D), [])
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        self.assertNotIn('兜底', self.input_md())

    def test_reappeared_retired(self):
        """迁移以后退役的人物文件又出现在原路径（帮手写的）：整份内容进材料；不退役的（xiaohe-linxi.md）不算。"""
        write(self.ws, 'memory/laolin.md', '# 关于 laolin\n- 帮手写进来的一条（10-24）\n')
        write(self.ws, 'memory/people/gua.md', '# 砚\n- 砚的新事\n')
        write(self.ws, 'memory/people/xiaohe-linxi.md', '# 林夕的歌\n- 工作笔记\n')
        self.assertEqual(S.reappeared_retired(), [], '开关没开：这些就是正常的人物文件')
        self.activate()
        got = S.reappeared_retired()
        self.assertEqual([r for r, _ in got], ['memory/laolin.md', 'memory/people/gua.md'])
        self.assertEqual(got[0][1], '# 关于 laolin\n- 帮手写进来的一条（10-24）\n')
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        md = self.input_md()
        self.assertIn(REAPPEARED_HEAD, md)
        sec = md.split(REAPPEARED_HEAD)[1].split('\n## ')[0]
        self.assertIn('#### memory/laolin.md', sec)
        self.assertIn('帮手写进来的一条（10-24）', sec)
        self.assertIn('＃ 关于 laolin', sec)                                  # 文件里的标题照样降级
        self.assertIn('砚的新事', sec)
        self.assertNotIn('林夕', sec)

    def test_reappeared_none_no_section(self):
        """开关开了、没有冒出来的：不出这一节。"""
        self.activate()
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        self.assertNotIn(REAPPEARED_HEAD, self.input_md())

    def test_near_in_section7(self):
        """开关开了：第 7 节的人物近况读 hhd 导出的 ledger/people/near.md，不读 memory/midterm/people.md。"""
        write(self.ws, 'ledger/people/near.md',
              '<!-- 写于 2026-10-25 02:10 -->\n# 人物近况\n\n#### laolin\n- 近况从库里来（e0001）\n')
        self.activate()
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        sec7 = self.input_md().split('## 7.')[1].split('\n## 8.')[0]
        near = sec7.split('### 人物近况')[1]
        self.assertIn('近况从库里来（e0001）', near)
        self.assertIn('＃＃＃＃ laolin', near)
        self.assertNotIn('最近在忙', sec7)
        self.assertIn('你这两天在做视频', sec7)                              # 这两天的我照旧

    def test_not_active_material_unchanged(self):
        """开关没开：就算 near.md、收件处、laolin.md 都在，材料和改之前逐字一样（近况照旧读 midterm/people.md）。"""
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        before = self.input_md()
        write(self.ws, 'ledger/people/near.md', '<!-- 写于 2026-10-25 02:10 -->\n# 人物近况\n\n#### laolin\n- 近况从库里来\n')
        self.inbox()
        write(self.ws, 'memory/laolin.md', '# 关于 laolin\n- 一条\n')
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.input_md(), before)
        self.assertIn('最近在忙', before.split('## 7.')[1])


class TestIncomplete(Base):
    def test_transcript_failure(self):
        code, out, _ = self.run_cli('2026-10-24', db=self.tmp / 'nope.sqlite')
        self.assertEqual(code, 3)
        line2 = self.input_md().splitlines()[1]
        self.assertTrue(line2.startswith('材料：不完整（缺：对话记录'), line2)
        self.assertIn('早上好，视频今天发吗', self.input_md())       # 压缩存档照样进材料
        code, _, err = self.run_cli('done', '2026-10-24', db=self.tmp / 'nope.sqlite')
        self.assertEqual(code, 3, err)
        st = self.state()
        self.assertNotIn('2026-10-24', st.get('done', []))
        self.assertIn('2026-10-24', st['deferred'])
        # 第二晚：还是不完整，再推迟
        self.run_cli('2026-10-24', db=self.tmp / 'nope.sqlite', now='2026-10-26T03:00')
        code, _, _ = self.run_cli('done', '2026-10-24', db=self.tmp / 'nope.sqlite', now='2026-10-26T03:10')
        self.assertEqual(code, 3)
        # 第三晚：照样标完成，并在 deferred 里写明
        self.run_cli('2026-10-24', db=self.tmp / 'nope.sqlite', now='2026-10-27T03:00')
        code, out, _ = self.run_cli('done', '2026-10-24', db=self.tmp / 'nope.sqlite', now='2026-10-27T03:10')
        self.assertEqual(code, 0)
        st = self.state()
        self.assertIn('2026-10-24', st['done'])
        self.assertIn('照样标完成', st['deferred']['2026-10-24'])
        self.assertEqual(len(st['defer_nights']['2026-10-24']), 3)

    def test_same_night_counts_once(self):
        self.run_cli('2026-10-24', db=self.tmp / 'nope.sqlite')
        for t in ('2026-10-25T03:10', '2026-10-25T05:40'):
            code, _, _ = self.run_cli('done', '2026-10-24', db=self.tmp / 'nope.sqlite', now=t)
            self.assertEqual(code, 3)
        self.assertEqual(self.state()['defer_nights']['2026-10-24'], ['2026-10-24'])

    def test_done_refuses_unfinished_day(self):
        self.run_cli('2026-10-24', now='2026-10-25T03:00')
        code, _, err = self.run_cli('done', '2026-10-24', now='2026-10-24T22:54')
        self.assertEqual(code, 2)
        self.assertIn('还没到整理的时候', err)
        self.assertEqual(self.state().get('done', []), [])
        code, _, _ = self.run_cli('done', '2026-10-24', now='2026-10-25T03:10')
        self.assertEqual(code, 0)
        self.assertEqual(self.state()['last_done'], '2026-10-24')

    def test_done_without_input(self):
        code, _, err = self.run_cli('done', '2026-10-24')
        self.assertEqual(code, 2)
        self.assertIn('没有', err)

    def test_partial_day_is_incomplete(self):
        code, _, _ = self.run_cli('2026-10-24', now='2026-10-24T20:00')
        self.assertEqual(code, 3)
        self.assertIn('这一天还没过完', self.input_md().splitlines()[1])
        self.assertNotIn('defer_nights', self.state())

    def test_now_needs_root(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                S.main(['pending', '--now', '2026-10-25T03:00'])


class TestPending(Base):
    def test_backlog_oldest_first_and_empty(self):
        self.set_state({'last_done': '2026-10-19', 'note': '别动我', 'steps': {'x': 1}, 'last_applied_at': 'y'})
        code, out, _ = self.run_cli('pending', '--no-write')
        self.assertEqual(out.split(), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'])
        self.assertNotIn('empty', self.state())                  # --no-write 不记
        code, out, _ = self.run_cli('pending')
        days = out.split()
        # 假数据里 10-20、10-21 什么都没有 → 自动记成整理完；10-22 有「经过」，10-23 有笔记（00:2x），10-24 有对话
        self.assertEqual(days, ['2026-10-22', '2026-10-23', '2026-10-24'])
        st = self.state()
        self.assertEqual(st['empty'], ['2026-10-20', '2026-10-21'])
        self.assertEqual(st['last_done'], '2026-10-21')
        self.assertEqual((st['note'], st['steps'], st['last_applied_at']), ('别动我', {'x': 1}, 'y'))

    def test_no_cap_and_watermark(self):
        self.set_state({'last_done': '2026-10-21', 'done': ['2026-10-23']})
        code, out, _ = self.run_cli('pending', '--no-write')
        self.assertEqual(out.split(), ['2026-10-22', '2026-10-24'])   # 10-23 已做完；10-22 没做不会被跳过
        self.run_cli('2026-10-22')
        self.run_cli('done', '2026-10-22')
        st = self.state()
        self.assertEqual(st['last_done'], '2026-10-23')              # 10-22、10-23 都做完，水位线往前挪
        code, out, _ = self.run_cli('pending', '--no-write')
        self.assertEqual(out.split(), ['2026-10-24'])

    def test_unreadable_db_never_empty(self):
        self.set_state({'last_done': '2026-10-19'})
        code, out, _ = self.run_cli('pending', db=self.tmp / 'nope.sqlite')
        self.assertEqual(out.split(), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'])
        self.assertNotIn('empty', self.state())

    def test_no_legacy_db_a_day_with_nothing_is_empty(self):
        # a role that never had the old platform (no legacyAgentDb, no --db): HH's own records are all there is
        self.set_state({'last_done': '2026-10-19'})
        code, out, _ = self.run_cli('pending', db=S.NO_LEGACY)
        self.assertNotIn('2026-10-20', out.split())
        self.assertIn('2026-10-20', self.state().get('empty', []))

    def test_defer_command(self):
        code, out, _ = self.run_cli('defer', '2026-10-24', '省电模式', '推迟到', '05:30')
        self.assertEqual(code, 0)
        self.assertEqual(self.state()['deferred']['2026-10-24'], '省电模式 推迟到 05:30')


class TestHelpers(unittest.TestCase):
    def test_coverage_attachments(self):
        """图片消息、带附件的消息：Honcho 里存的是只有文字块、附件换成〔文件 名〕的写法，也要算存了。"""
        tmp = Path(tempfile.mkdtemp())
        try:
            make_ws(tmp)
            people = S.People(reg={k: v for k, v in json.loads((tmp / 'memory/people/registry.json').read_text()).items()
                                   if not k.startswith('_')})
            gm = S.honcho_session_id('agent:main:main')
            t1 = dt.datetime(2026, 10, 24, 10, 0, tzinfo=TZ)
            t2 = dt.datetime(2026, 10, 24, 11, 0, tzinfo=TZ)
            e1 = S.Entry(t1, 'laolin', 'laolin', 'laolin', 'human', '看看这张\n〔图片〕', 'tx', hsid=gm, match='看看这张')
            e2 = S.Entry(t2, 'laolin', 'laolin', 'laolin', 'human', '<file name="a.pdf">文件正文</file>\n看看这个文件', 'tx', hsid=gm,
                         match='<file name="a.pdf">文件正文</file>\n看看这个文件')
            fake = [{'created_at': '2026-10-23T23:00:03Z', 'peer_id': 'laolin', 'content': '看看这张'},
                    {'created_at': '2026-10-24T00:00:00Z', 'peer_id': 'laolin', 'content': '〔文件 a.pdf〕\n看看这个文件'}]
            saved = S.R.list_msgs
            S.R.list_msgs = lambda *a, **k: fake
            try:
                self.assertEqual(S.coverage(people, dt.date(2026, 10, 24), [e1, e2]), 'laolin 100%（2/2）')
            finally:
                S.R.list_msgs = saved
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_honcho_session_id(self):
        self.assertEqual(S.honcho_session_id('agent:main:main'), 'chat-main-main-51e0c73a01e539c2db8d11d2')

    def test_clean_content(self):
        raw = ('Conversation info (untrusted metadata):\n```json\n{"sender_id": "x"}\n```\n\n'
               'System: [2026-10-24] WhatsApp connected\n真正的话\n\n【只给你看】现在是下午\n')
        self.assertEqual(S.clean_content(raw), '真正的话')
        self.assertEqual(S.old_sender(raw), 'x')

    def test_line_day(self):
        d = dt.date(2026, 10, 25)
        self.assertEqual(S.line_day('- 00:1x 凌晨', d), dt.date(2026, 10, 24))
        self.assertEqual(S.line_day('- **03:59** 凌晨', d), dt.date(2026, 10, 24))
        self.assertEqual(S.line_day('- 04:00 早上', d), d)
        self.assertEqual(S.line_day('- 2026-10-26 01:00 跨天', d), dt.date(2026, 10, 25))
        self.assertIsNone(S.line_day('  - 子项', d))

    def test_strip_wrappers(self):
        q = ('[Queued messages while agent was busy]\n\n---\nQueued #1 (from Laolin Hao)\n第一句\n---\n'
             'Queued #2 (from Laolin Hao)\n第二句')
        self.assertEqual(S.strip_wrappers(q), '第一句\n第二句')
        self.assertEqual(S.strip_wrappers('[Queued user message from a previous active turn; preserved as context only.]\n真话'), '真话')
        self.assertEqual(S.strip_wrappers('[System] Your previous turn was interrupted'), '')
        self.assertEqual(S.strip_wrappers('普通的话\n---\n分隔线留着'), '普通的话\n---\n分隔线留着')
        self.assertEqual(S.canon(q), S.canon('第一句\n第二句'))

    def test_demote(self):
        self.assertEqual(S.demote('## 标题\n正文 # 不是标题\n   # 缩进的'), '＃＃ 标题\n正文 # 不是标题\n   ＃ 缩进的')


class TestHHWork(unittest.TestCase):
    """HH 中央记忆里她做事的过程（第 2 节）：折叠、去重、不放思考和下意识内部过程。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = str(Path(self.tmp) / 'hh.db')
        c = sqlite3.connect(self.db)
        c.execute('CREATE TABLE central (seq INTEGER PRIMARY KEY, ts INTEGER, epoch INTEGER, src TEXT, kind TEXT, text TEXT, tokens INTEGER, meta TEXT)')
        c.execute('CREATE TABLE blocks (id INTEGER PRIMARY KEY, epoch INTEGER, created INTEGER, text TEXT, tokens INTEGER, cleared INTEGER)')
        t = ms('2026-10-30 10:00')
        rows = [
            ('main', 'act', 'Bash ' + json.dumps({'command': 'ffmpeg -i a.mp4 b.mp4', 'description': '渲染小样'}), None),
            ('main', 'result', 'ok', None),
            ('main', 'act', 'Read ' + json.dumps({'file_path': '/tmp/x/p02.jpg'}), None),
            ('main', 'result', 'Error: 文件不存在 /tmp/x/p02.jpg', json.dumps({'error': True})),
            ('main', 'act', 'mcp__self__message ' + json.dumps({'channel': 'whatsapp', 'message': '好了'}), None),
            ('main', 'note', '（发给 laolin）好了，发你了', json.dumps({'sent': True, 'to': G})),
            ('main', 'say', '好了，发你了', None),
            ('main', 'say', '我先自己逐帧看一遍再发。', None),
            ('main', 'think', 'Let me check the frames.', None),
            ('main', 'act', 'mcp__self__hands ' + json.dumps({'task': '把嘴改成网格变形'}), None),
            ('perception-messages', 'say', '内部过程，不该出现', json.dumps({'inner': True})),
            ('perception-messages', 'note', '看了一眼刚才的动静：帮手交回了小样，交给主线。', None),
            ('main', 'say', 'NO_REPLY', None),
            ('system', 'system', '翻页：第 3 页开始。', None),
        ]
        for i, (src, kind, text, meta) in enumerate(rows):
            c.execute('INSERT INTO central VALUES (?,?,?,?,?,?,?,?)', (i + 1, t + i * 1000, 1, src, kind, text, 10, meta))
        c.execute('INSERT INTO blocks VALUES (1, 2, ?, ?, 100, NULL)', (t + 60000, '# 上午\n我改了五版脸。'))
        c.commit()
        c.close()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def section(self, cap=S.HH_WORK_CAP):
        rows, blocks = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        return S.hh_work(rows, cap), S.hh_blocks_text(blocks)

    def add_rows(self, rows, start='2026-10-30 11:00'):
        c = sqlite3.connect(self.db)
        base = c.execute('select max(seq) from central').fetchone()[0]
        t = ms(start)
        for i, (src, kind, text, meta) in enumerate(rows):
            c.execute('INSERT INTO central VALUES (?,?,?,?,?,?,?,?)', (base + i + 1, t + i * 60000, 1, src, kind, text, 10, meta))
        c.commit()
        c.close()

    def test_background_rows_labelled_by_what_she_was_doing(self):
        """并行大脑（10-31）：后台的记录按「弄什么时」标，不写「一心多用」这类结构词；查不到在弄什么就写「我」。"""
        c = sqlite3.connect(self.db)
        c.execute('CREATE TABLE tasks (id INTEGER PRIMARY KEY, topic TEXT, owner TEXT, started INTEGER, ended INTEGER)')
        c.execute('INSERT INTO tasks (topic, owner, started, ended) VALUES (?, ?, ?, ?)', ('剪祥子', 'side-1', ms('2026-10-30 11:00'), ms('2026-10-30 11:30')))
        c.commit()
        c.close()
        self.add_rows([('side-1', 'say', '第二段对上了时间', None), ('side-2', 'say', '这个先放着', None)])
        self.add_rows([('side-1', 'say', '收尾了', None)], start='2026-10-30 12:00')
        rows, _ = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        work = S.hh_work(rows, S.HH_WORK_CAP, S.hh_tasks(self.db))
        self.assertIn('我（弄剪祥子时）说] 第二段对上了时间', work)
        self.assertIn('[11:01 我说] 这个先放着', work)
        self.assertIn('[12:00 我说] 收尾了', work)
        self.assertNotIn('一心多用', work)

    def test_no_tasks_table_and_deep_insight(self):
        """还没有 tasks 表时后台记录写「我」；潜意识（deep）的结论算我记下的，它的过程不进材料。"""
        self.add_rows([('side-1', 'say', '后台说的', None),
                       ('deep', 'think', '潜意识的过程', json.dumps({'inner': True})),
                       ('deep', 'note', '我查清楚了：那篇论文是讲记忆再巩固的', json.dumps({'insight': True}))])
        self.assertEqual(S.hh_tasks(self.db), [])
        rows, _ = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        work = S.hh_work(rows, S.HH_WORK_CAP, S.hh_tasks(self.db))
        self.assertIn('[11:00 我说] 后台说的', work)
        self.assertIn('我记下] 我查清楚了：那篇论文是讲记忆再巩固的', work)
        self.assertNotIn('潜意识的过程', work)
        self.assertNotIn('一心多用', work)

    def test_fold_and_filter(self):
        work, blocks = self.section()
        self.assertIn('我做了 2 步] Bash、Read：渲染小样；/tmp/x/p02.jpg', work)
        self.assertIn('✗ Error: 文件不存在', work)
        self.assertIn('[10:00 我说] 我先自己逐帧看一遍再发。', work)
        self.assertIn('hands：', work)
        self.assertIn('把嘴改成网格变形', work)
        self.assertIn('我下意识记下] 看了一眼刚才的动静', work)
        self.assertIn('（系统）] 翻页', work)
        for bad in ('内部过程', 'Let me check', 'NO_REPLY', '好了，发你了', 'whatsapp'):
            self.assertNotIn(bad, work)
        self.assertIn('翻页压缩（第 2 页）', blocks)
        self.assertNotIn('\n# 上午', blocks)      # 标题降级，不打乱整份材料的层级

    def test_cap_keeps_the_whole_day(self):
        work, _ = self.section(cap=120)
        self.assertLessEqual(len(work), 120)
        self.assertIn('翻页', work)               # 降级时不砍掉后面的记录

    def test_before_cutover_is_empty(self):
        self.assertEqual(S.hh_section(dt.date(2026, 10, 27), []), '')

    def test_gate_digest_gets_its_own_section(self):
        """闸门每日总结（laolin 11-04）：睡前 03:0x 记的那条算前一天，整段进单独一小节，不在做事的过程里被截成 300 字。"""
        day = dt.date(2026, 10, 30)
        self.assertNotIn('今天下意识放下的', S.hh_section(day, [], db=self.db))
        body = '【各处放下的动静】\n' + '河边镇之家在聊苹果智能进中国。' * 40
        self.add_rows([('main', 'note', '（今天下意识放下的）' + body, json.dumps({'gateDigest': True}))], start='2026-10-31 03:05')
        sec = S.hh_section(day, [], db=self.db)
        self.assertIn('### 今天下意识放下的', sec)
        self.assertIn(body, sec)
        work = sec.split('### 今天下意识放下的')[0]
        self.assertNotIn('苹果智能', work)
        self.assertIn('#15]', sec)


class TestLearn(Base):
    """laolin 11-01 学习系统：材料第 8 节放 HH 记的：前一晚把关的结论；周日、或者回测比前一晚差时附上每周数字。"""
    WEEKLY = '# 最近 7 天的学习\n- 新教训：2 条\n- 回测通过率：80%（最近一晚）\n- 今晚回测：通过 8/10\n'
    DROP = '回测通过率比昨晚低：90%（9/10） → 80%（8/10）\n'

    def put(self, rel, text):
        write(S.HH_LEARN, rel, text)

    def section(self, day):
        S.ROOT = self.root
        return S.learn_section(dt.date.fromisoformat(day))

    def test_weekly_attached_on_sunday(self):
        self.put('weekly.md', self.WEEKLY)
        sun = self.section('2026-10-25')                  # 整理的那一天是周日（周一凌晨那一跑）
        self.assertIn('每周数字', sun)
        self.assertIn('- 新教训：2 条', sun)
        self.assertIn('＃ 最近 7 天的学习', sun)          # 标题降级，不打乱材料的分节
        self.assertNotIn('新教训', self.section('2026-10-24'))   # 平时、回测没变差：不附
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        sec8 = self.input_md().split('## 8. ')[1]
        self.assertNotIn('新教训', sec8)

    def test_weekly_attached_when_replay_dropped(self):
        self.put('weekly.md', self.DROP + self.WEEKLY)
        sat = self.section('2026-10-24')
        self.assertIn('回测通过率比昨晚低：90%（9/10） → 80%（8/10）', sat)
        self.assertIn('- 新教训：2 条', sat)
        self.put('weekly.md', self.WEEKLY + self.DROP)     # 不在第一行的不算
        self.assertNotIn('新教训', self.section('2026-10-24'))

    def test_checker_verdicts_in_next_material(self):
        """前一晚（整理前一天时）把关的结论：每种几条，不收的逐条带理由；别的日子的不列，读不了的说一句。"""
        verdicts = [
            {'i': 1, 'kind': '教训', 'page': 'p:0012', 'text': '截完先看一眼', 'verdict': 'add', 'into': None,
             'finalText': '截完先看一眼', 'why': '新的'},
            {'i': 2, 'kind': '做法', 'page': 'p:0012', 'text': '先亮屏', 'verdict': 'merge', 'into': '先亮屏再截',
             'finalText': '先亮屏再截，亮了再等一秒', 'why': '重叠'},
            {'i': 3, 'kind': '做成的', 'page': 'skills/日常/截图.md', 'text': '这次截图一次就成了', 'verdict': 'reject',
             'into': None, 'finalText': None, 'why': '一次性的事，下次照不着'},
            {'i': 4, 'kind': '教训', 'page': 'p:0020', 'text': '别猜', 'verdict': 'reject', 'into': None,
             'finalText': None, 'why': None},
            {'i': 5, 'kind': '做法', 'page': 'p:0020', 'text': '没看完的那条', 'verdict': 'unchecked', 'into': None,
             'finalText': None, 'why': None},
        ]
        self.put('check/2026-10-23.json', json.dumps(verdicts, ensure_ascii=False))
        self.put('check/2026-10-22.json', json.dumps([dict(verdicts[2], text='更早那晚的')], ensure_ascii=False))
        sec = self.section('2026-10-24')
        self.assertIn('10-23', sec)
        self.assertIn('新增 1 条；并进已有的 1 条；不收 2 条；没看完 1 条', sec)
        self.assertIn('- 不收：做成的 · skills/日常/截图.md「这次截图一次就成了」：一次性的事，下次照不着', sec)
        self.assertIn('- 不收：教训 · p:0020「别猜」：没写理由', sec)
        self.assertNotIn('截完先看一眼', sec)               # 收下的不逐条列（进了页，应用报告里有）
        self.assertNotIn('更早那晚的', sec)
        self.assertNotIn('新增', self.section('2026-10-26'))   # 前一天没交把关：不列
        # 前一天是空的日子（没整理）：再往前找那一晚的
        self.set_state({'empty': ['2026-10-24']})
        self.assertIn('这次截图一次就成了', self.section('2026-10-25'))
        self.put('check/2026-10-23.json', '[]')
        self.assertNotIn('把关的结论', self.section('2026-10-24'))
        self.put('check/2026-10-23.json', '{"verdict": "reject"}')
        self.assertIn('读不了', self.section('2026-10-24'))
        self.put('check/2026-10-23.json', '{坏的')
        self.assertIn('读不了', self.section('2026-10-24'))
        code, out, _ = self.run_cli('2026-10-24')
        self.assertEqual(code, 0, out)
        self.assertIn('读不了', self.input_md().split('## 8. ')[1])


class TestPromptFolds(unittest.TestCase):
    """进材料前过 HH 配置里的折叠表（memory.promptFolds，运维 11-13）：真人的话只换那几个字，别的命中就整条换；压缩块按行换；库里照原样。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = str(self.tmp / 'hh.db')
        c = sqlite3.connect(self.db)
        c.execute('CREATE TABLE central (seq INTEGER PRIMARY KEY, ts INTEGER, epoch INTEGER, src TEXT, kind TEXT, text TEXT, tokens INTEGER, meta TEXT)')
        c.execute('CREATE TABLE blocks (id INTEGER PRIMARY KEY, epoch INTEGER, created INTEGER, text TEXT, tokens INTEGER, cleared INTEGER)')
        t = ms('2026-10-30 10:00')
        rows = [
            ('外界', 'input', '红灯拦下的事修好了，你接着写稿', json.dumps({'from': 'laolin', 'human': True})),
            ('side-1', 'result', 'Error: Stopped By A Lamp, tools did not run', None),
            ('main', 'say', '刚才被红灯拦下了', None),
            ('main', 'say', '稿子写完了', None),
        ]
        for i, (src, kind, text, meta) in enumerate(rows):
            c.execute('INSERT INTO central VALUES (?,?,?,?,?,?,?,?)', (i + 1, t + i * 1000, 1, src, kind, text, 10, meta))
        c.execute('INSERT INTO blocks VALUES (1, 2, ?, ?, 100, NULL)', (t + 60000, '- 上午写稿（#1）\n- 被红灯拦下一次（#2）'))
        c.commit()
        c.close()
        self._cfg = S.HH_CONFIG
        S.HH_CONFIG = self.tmp / 'config.json'
        self.say = '（那一步没做成，先放着）'
        S.HH_CONFIG.write_text(json.dumps({'memory': {'promptFolds': [
            {'find': '红灯拦下', 'say': self.say, 'word': '那件事', 'note': '测试'},
            {'find': 'stopped by a lamp', 'say': self.say},
        ]}}), encoding='utf-8')

    def tearDown(self):
        S.HH_CONFIG = self._cfg
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_rows_and_blocks_folded_db_untouched(self):
        rows, blocks = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        texts = [r[4] for r in rows]
        self.assertEqual(texts[0], '那件事的事修好了，你接着写稿', '真人的话只换那几个字')
        self.assertEqual(texts[1], self.say, '工具结果整条换（不分大小写）')
        self.assertEqual(texts[2], self.say, '她说的整条换')
        self.assertEqual(texts[3], '稿子写完了', '没命中的照旧')
        self.assertEqual(blocks[0][2], f'- 上午写稿（#1）\n- {self.say}', '压缩块命中的行整行换，留着「- 」')
        c = sqlite3.connect(self.db)
        self.assertEqual(c.execute('select text from central where seq = 3').fetchone()[0], '刚才被红灯拦下了', '库里照原样')
        c.close()

    def test_time_window(self):
        """条目带 from / until：只认这段时间里的记录；压缩块按那一页的起止判（这段时间的第一块从这段开头算）"""
        S.HH_CONFIG.write_text(json.dumps({'memory': {'promptFolds': [
            {'find': '红灯拦下', 'say': self.say, 'word': '那件事', 'from': '2026-10-30 09:00', 'until': '2026-10-30 09:59'},
        ]}}), encoding='utf-8')
        rows, blocks = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        self.assertEqual(rows[2][4], '刚才被红灯拦下了', '记录在 10:00 以后，段外原样')
        self.assertEqual(rows[0][4], '红灯拦下的事修好了，你接着写稿', '真人的话段外也原样')
        self.assertIn(self.say, blocks[0][2], '那一页从这天开头算到 10:01，跟 09:00–09:59 有重叠：按行换')
        S.HH_CONFIG.write_text(json.dumps({'memory': {'promptFolds': [
            {'find': '红灯拦下', 'say': self.say, 'word': '那件事', 'from': '2026-10-30 10:00', 'until': '2026-10-30 23:59'},
            {'find': '坏时间', 'say': 'x', 'from': '看不懂'},
        ]}}), encoding='utf-8')
        rows, _ = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        self.assertEqual(rows[2][4], self.say, '段内整条换')
        self.assertEqual(rows[0][4], '那件事的事修好了，你接着写稿', '真人的话段内只换字')
        self.assertEqual(len(S.prompt_folds()), 1, '时间写坏的那条不用')

    def test_no_table_or_bad_config_unchanged(self):
        S.HH_CONFIG.write_text('{not json', encoding='utf-8')
        rows, blocks = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        self.assertEqual(rows[2][4], '刚才被红灯拦下了')
        self.assertIn('红灯拦下', blocks[0][2])
        S.HH_CONFIG.unlink()
        rows, _ = S.hh_rows(*S.bounds(dt.date(2026, 10, 30)), db=self.db)
        self.assertEqual(rows[0][4], '红灯拦下的事修好了，你接着写稿')


if __name__ == '__main__':
    unittest.main()
