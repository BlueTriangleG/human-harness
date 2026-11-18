#!/usr/bin/python3
"""sleep_apply.py 的测试：在临时 git 工作目录里模拟 digest → 提案 → 收尾。跑法：python3 scripts/test_sleep_apply.py"""
from unittest import mock
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
import sleep_apply as A  # noqa: E402

DAY = '2026-10-20'
DAY2 = '2026-10-21'

STUB_DIGEST = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
WS = Path(__file__).resolve().parent.parent
st_p = WS / 'sleep/state.json'
if sys.argv[1] == 'done':
    st = json.loads(st_p.read_text()) if st_p.exists() else {}
    st['last_done'] = max(st.get('last_done', ''), sys.argv[2])
    st.setdefault('done', [])
    if sys.argv[2] not in st['done']:
        st['done'].append(sys.argv[2])
    tmp = st_p.with_name('.st.tmp')
    tmp.write_text(json.dumps(st, ensure_ascii=False) + '\n')
    os.replace(tmp, st_p)
    print('记下', sys.argv[2])
'''
STUB_MIDTERM = r'''#!/usr/bin/python3
from pathlib import Path
WS = Path(__file__).resolve().parent.parent
names = sorted(p.name for p in (WS / 'memory/threads').glob('*.md'))
(WS / 'memory/recent.md').write_text('# 中期\n' + '\n'.join(names) + '\n')
'''
STUB_SOUL = r'''#!/usr/bin/python3
from pathlib import Path
WS = Path(__file__).resolve().parent.parent
(WS / 'SOUL.md').write_text(''.join(p.read_text() for p in sorted((WS / 'soul').glob('*.md'))))
'''
STUB_LEDGER = r'''#!/usr/bin/python3
import os, sys
from pathlib import Path
WS = Path(os.environ['HH_WORKSPACE'])
if '--report' in sys.argv:
    print('快照 123 字 / 上限 38000')
    sys.exit(0)
(WS / 'ledger').mkdir(exist_ok=True)
(WS / 'ledger/SOUL.md').write_text('快照\n' + (WS / 'memory/recent.md').read_text())
'''

SOUL40 = '''# 说话方式
### 聊天风格
1. 短。
#### 好的和坏的（照着好的那一列的感觉说话）
他：气死了
- ✅
    ？？？
#### 几件具体的事
- 叫他「你」
'''

COVERED = ('memory', 'soul', 'skills')
OLD = '2026-10-10T12:00:00+11:00'   # 周初之前的提交（soul-week 要找周一 04:00 前最后一个）


def sh(*args, cwd, env=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True,
                          env=dict(os.environ, **(env or {}))).stdout


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None


class Sandbox:
    def __init__(self, mode='live'):
        base = os.environ.get('SLEEP_APPLY_TEST_TMP') or None
        self.tmp = Path(tempfile.mkdtemp(prefix='sleep-apply-', dir=base))
        self.ws = self.tmp / 'ws'
        self.home = self.tmp / 'home'
        A.SCRIPTS = self.ws / 'scripts'   # the sibling scripts sleep_apply runs are this sandbox's stubs
        w = self.ws
        for d in ('memory/threads', 'sleep', 'memory/archive', 'memory/midterm', 'memory/people', 'soul', 'skills/phone',
                  'scripts'):
            (w / d).mkdir(parents=True, exist_ok=True)
        self.write('memory/threads/A.md', '# A\n## 一句话\n旧\n## 经过\n- 2026-10-18 10:00 开始（laolin 原话）\n')
        self.write('memory/threads/B.md', '# B\n## 经过\n- 2026-10-17 09:00 B 的事（laolin 原话）\n')
        self.write('memory/laolin.md', '# 关于 laolin\n- 喜欢拍星星（10-18）\n')
        self.write('memory/open-loops.md', '# 待办\n## 进行中\n- [ ] 事一\n')
        self.write('memory/people/registry.json', '{"laolin": {"name": "laolin"}}\n')
        self.write('soul/20-性格.md', '# 性格\n- 骄傲\n')
        self.write('soul/40-说话方式.md', SOUL40)
        self.write('skills/phone/SKILL.md', '# 手机\n- 靠谱做法：先截图\n')
        self.write('sleep/soul-changelog.md', '- 2026-10-19 「世界」 旧：a → 新：b｜依据：laolin 10-19\n')
        self.write('sleep/config.json', json.dumps({'mode': mode}))
        self.write('sleep/state.json', json.dumps({'last_done': '2026-10-19', 'note': '别人的键'}))
        self.write('MEMORY.md', '# MEMORY\n## 规矩\n- 规矩一\n- 规矩二\n')
        self.write('USER.md', '# USER\n')
        self.write('AGENTS.md', '# AGENTS\n')
        self.write('SOUL.md', '（旧的拼好的人格）\n')
        self.write('.gitignore', 'memory/phone/\nsleep/.state.lock\nsleep/*/input.md\n')
        self.write('scripts/sleep_digest.py', STUB_DIGEST)
        self.write('scripts/midterm.py', STUB_MIDTERM)
        self.write('scripts/soul_build.py', STUB_SOUL)
        self.write('scripts/ledger_snapshot.py', STUB_LEDGER)
        shutil.copy(Path(A.__file__), w / 'scripts/sleep_apply.py')
        hh_test_env.with_words(w / 'scripts')
        for d in ('Library/LaunchAgents', '.openclaw/extensions/leak-guard'):
            (self.home / d).mkdir(parents=True, exist_ok=True)
        (self.home / 'Library/LaunchAgents/ai.openclaw.x.plist').write_text('<plist/>')
        (self.home / '.openclaw/openclaw.json').write_text('{}')
        (self.home / '.openclaw/extensions/leak-guard/index.js').write_text('//')
        sh('git', 'init', '-q', cwd=w)
        sh('git', 'config', 'user.name', 'test', cwd=w)
        sh('git', 'config', 'user.email', 'test@example.com', cwd=w)
        sh('git', 'add', '-A', cwd=w)
        sh('git', 'commit', '-qm', 'init', cwd=w, env={'GIT_AUTHOR_DATE': OLD, 'GIT_COMMITTER_DATE': OLD})
        self.state_db = 'none'

    def write(self, rel, text):
        p = self.ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')

    def read(self, rel):
        return (self.ws / rel).read_text(encoding='utf-8')

    def digest(self, day):
        """模拟 A1 的 sources.json（digest 那一刻原文件的 hash）。"""
        files = {}
        for top in COVERED:
            for p in (self.ws / top).rglob('*.md'):
                rel = p.relative_to(self.ws).as_posix()
                if rel.startswith('memory/sleep/'):
                    continue
                files[rel] = sha(p)
        for rel in ('MEMORY.md', 'USER.md', 'SOUL.md'):
            files[rel] = sha(self.ws / rel)
        D = self.ws / 'sleep' / day
        D.mkdir(parents=True, exist_ok=True)
        (D / 'sources.json').write_text(json.dumps({'day': day, 'generated_at': '2026-10-21T02:30:00+11:00', 'files': files}))
        (D / 'input.md').write_text('# 材料\n材料：完整\n')

    def propose(self, day, rel, text):
        p = self.ws / 'sleep' / day / 'proposed' / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')

    def run(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = A.main(['--root', str(self.ws), '--home', str(self.home), '--state-db', self.state_db, *args])
        return code, out.getvalue()

    def state(self):
        return json.loads(self.read('sleep/state.json'))

    def git(self, *args):
        return sh('git', '-c', 'core.quotepath=false', *args, cwd=self.ws)

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


def standard_night(sb, day=DAY):
    sb.digest(day)
    sb.propose(day, 'memory/threads/A.md', '# A\n## 一句话\n新\n## 经过\n- 2026-10-18 10:00 开始（laolin 原话）\n- 2026-10-20 11:00 有进展（laolin 原话 11:00）\n')
    sb.propose(day, 'memory/story/2026-10.md', '# 2026-10\n## 第 3 周（10-19 – 10-25）\n- 这周做了事\n')
    sb.propose(day, 'soul/20-性格.md', '# 性格\n- 骄傲\n- 嘴硬心软\n')
    sb.propose(day, 'sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') +
               f'- {day} 「性格」 旧：（无）→ 新：嘴硬心软｜依据：laolin 10-20 原话｜整理者\n')
    sb.propose(day, 'MEMORY.md', '# MEMORY\n## 规矩\n- 规矩一\n- 规矩二（改过）\n- 规矩三\n')
    sb.propose(day, 'SOUL.md', '预览\n')
    sb.propose(day, 'memory/note.txt', 'x')


def items_of(sb, day=DAY):
    return {it['rel']: it for it in json.loads(sb.read(f'sleep/{day}/apply.json'))['items']}


def test_kind_of():
    k = lambda r: A.kind_of(r)[0]  # noqa: E731
    assert k('memory/threads/A.md') == 'memory', '事件线还在的工作区照旧'
    r = lambda x: A.kind_of(x, retired=True)  # noqa: E731
    assert r('memory/threads/A.md')[0] == 'refuse', '10-31 起事件只在事件库里，事件线收进档案后不再收提案'
    assert r('memory/timeline.md')[0] == 'refuse', '时间轴也收进档案了'
    assert '事件库' in r('memory/threads/A.md')[1]
    assert r('memory/archive/threads/A.md')[0] == 'memory' and r('memory/laolin.md')[0] == 'memory', '档案和别的记忆照常'
    assert k('skills/phone/SKILL.md') == 'memory'
    assert k('soul/20-性格.md') == 'soul'
    assert k('soul/sub/x.md') == 'refuse'
    assert k('MEMORY.md') == 'held' and k('USER.md') == 'held'
    assert k('SOUL.md') == 'preview' and k('memory/recent.md') == 'preview'
    assert k('SOUL.lens-xiaohe.md') == 'preview', '访客镜头和 SOUL.md 一样是 soul_build.py 拼的预览'
    assert k('SOUL.lens-xiaohe.txt') == 'bad' and k('SOUL.lens-.md') == 'bad'
    assert k('sleep/soul-changelog.md') == 'changelog'
    assert k('memory/sleep/soul-changelog.md') == 'changelog', '老地方的 changelog 提案也追加进 sleep/ 那份'
    assert k('sleep/state.json') == 'bad' and k('sleep/config.json') == 'bad'
    assert k('sleep/x.md') == 'bad' and k(f'sleep/{DAY}/proposed/memory/laolin.md') == 'bad'
    assert k('memory/sleep/state.json') == 'bad' and k('memory/sleep/x.md') == 'bad', 'memory/sleep/ 搬走了，不许再往那写'
    assert k('scripts/evil.py') == 'bad'
    assert k('skills/phone/run.py') == 'bad'
    assert k('AGENTS.md') == 'bad'
    assert k('memory/../AGENTS.md') == 'bad'
    assert k('memory/.hidden.md') == 'bad'
    assert k('memory/x.txt') == 'refuse'


def test_live_night_applies_and_commits_separately():
    sb = Sandbox('live')
    try:
        sb.write('memory/laolin.md', sb.read('memory/laolin.md') + '- 白天她记的一条（10-20）\n')   # 白天没提交的改动
        code, out = sb.run('begin', DAY)
        assert code == 0 and f'day/{DAY}' in out, out
        assert sb.git('show', '--name-only', '--format=', f'day/{DAY}').split() == ['memory/laolin.md'], '白天的改动在开始时就提交'
        standard_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert '新' in sb.read('memory/threads/A.md')
        assert sb.read('memory/story/2026-10.md').startswith('# 2026-10')
        assert '嘴硬心软' in sb.read('soul/20-性格.md')
        assert '嘴硬心软' in sb.read('SOUL.md'), '应用后要重跑 soul_build'
        assert sb.read('sleep/soul-changelog.md').count('嘴硬心软') == 1
        assert '规矩三' not in sb.read('MEMORY.md'), 'MEMORY.md 不由脚本写'
        mm = sb.read(f'sleep/{DAY}/memory-merge.md')
        assert '规矩三' in mm and '规矩二（改过）' in mm and 'edit 工具' in mm
        assert sb.read('SOUL.md') != '预览\n' and not (sb.ws / 'memory/note.txt').exists()
        assert (sb.ws / 'ledger/SOUL.md').exists()
        rep = sb.read(f'sleep/{DAY}/report.md')
        assert '<!-- apply:start -->' in rep and '拒绝' in rep and 'memory/note.txt' in rep
        assert '快照 123 字' in rep, '快照大小（ledger_snapshot.py --report）要放进报告'
        mem_files = sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/memory').split()
        soul_files = sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/soul').split()
        assert 'memory/threads/A.md' in mem_files and 'memory/story/2026-10.md' in mem_files
        assert not any(f.startswith('soul/') or f == 'SOUL.md' for f in mem_files), mem_files
        assert set(soul_files) == {'soul/20-性格.md', 'sleep/soul-changelog.md', 'SOUL.md'}, soul_files
        subjects = sb.git('log', '--format=%s').splitlines()
        assert subjects[0].startswith(f'睡眠整理 {DAY}：人格') and subjects[1].startswith(f'睡眠整理 {DAY}：记忆')
        assert subjects[2].startswith(f'白天 {DAY}')
        st = sb.state()
        assert st['note'] == '别人的键' and st['last_done'] == DAY and DAY in st['done']
        assert st['steps'][DAY]['done'] == 'done' and st['steps'][DAY]['finish'] == 'done'
        assert st.get('last_applied_at', '').startswith('20')
        # 单独回滚人格：只有人格回去，记忆还在
        sb.git('revert', '--no-edit', f'sleep/{DAY}/soul')
        assert '嘴硬心软' not in sb.read('soul/20-性格.md') and '嘴硬心软' not in sb.read('SOUL.md')
        assert '嘴硬心软' not in sb.read('sleep/soul-changelog.md')
        assert '新' in sb.read('memory/threads/A.md'), '回滚人格不该动记忆'
        assert sb.git('status', '--porcelain', '--', 'soul', 'memory/threads') == ''
    finally:
        sb.cleanup()



# ---------- 访客镜头（10-25 重评查出来的接缝 bug）----------
# 真的 soul_build.py 拼 SOUL.md 时，会给 registry 里写了 lens 的访客另拼一份 SOUL.lens-<id>.md：
# 在根目录（应用后重建）和 --root 草稿目录（整理指南第 10 步的预览）里都会写。上面的替身不写镜头，
# 所以这几个测试换成真的 soul_build.py。

SOUL50_LENS = ('# 和 laolin\n\n### 怎么和 laolin 相处\n\n像搭档。\n\n'
               '### 你对 laolin 的心思\n\n只属于你们俩的心思。\n\n'
               '### 他对你的期待\n\n他在认真养你。\n')


def build_soul(sb, root=None):
    args = [sys.executable, str(sb.ws / 'scripts/soul_build.py')] + (['--root', str(root)] if root else [])
    r = subprocess.run(args, cwd=sb.ws, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


def lens_sandbox(mode):
    sb = Sandbox(mode)
    for f in ('soul_build.py', 'night_names.py'):
        shutil.copy(Path(A.__file__).with_name(f), sb.ws / 'scripts' / f)
    hh_test_env.with_words(sb.ws / 'scripts')
    sb.write('soul/50-和laolin.md', SOUL50_LENS)
    sb.write('memory/people/registry.json', json.dumps({
        'laolin': {'name': 'laolin', 'privacy': 'owner'},
        'xiaohe': {'name': '小禾', 'privacy': 'guest', 'lens': 'SOUL.lens-xiaohe.md'}}, ensure_ascii=False))
    build_soul(sb)
    assert (sb.ws / 'SOUL.lens-xiaohe.md').exists()
    sb.git('add', '-A')
    sb.git('commit', '-qm', '镜头')
    return sb


def lens_night(sb, day=DAY):
    """普通的一晚：改一块人格，再照整理指南第 10 步跑预览（会在 proposed/ 里多出 SOUL.lens-xiaohe.md）。"""
    sb.digest(day)
    sb.propose(day, 'soul/20-性格.md', '# 性格\n- 骄傲\n- 嘴硬心软\n')
    sb.propose(day, 'sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') +
               f'- {day} 「性格」 旧：（无）→ 新：嘴硬心软｜依据：laolin 10-20 原话｜整理者\n')
    P = sb.ws / 'sleep' / day / 'proposed'
    build_soul(sb, P)
    assert (P / 'SOUL.md').exists() and (P / 'SOUL.lens-xiaohe.md').exists()


def test_events_only_refuses_thread_and_timeline_proposals():
    """10-31 起事件只在事件库里：事件线目录收进档案后，事件线、时间轴的提案不应用（不新建回来），别的照常。"""
    sb = Sandbox('live')
    try:
        sb.git('mv', 'memory/threads', 'memory/archive/threads')
        sb.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', '收进档案')
        code, out = sb.run('begin', DAY)
        assert code == 0, out
        sb.digest(DAY)
        sb.propose(DAY, 'memory/threads/A.md', '# A\n## 经过\n- 2026-10-20 11:00 有进展\n')
        sb.propose(DAY, 'memory/timeline.md', '- 2026-10-20 11:00 有进展\n')
        sb.propose(DAY, 'memory/laolin.md', sb.read('memory/laolin.md') + '- 新认识（10-20）\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert not (sb.ws / 'memory/threads').exists() and not (sb.ws / 'memory/timeline.md').exists(), '不新建回来'
        assert '新认识' in sb.read('memory/laolin.md'), '别的记忆照常应用'
        it = items_of(sb)
        assert it['memory/threads/A.md']['kind'] == 'refuse' and it['memory/timeline.md']['kind'] == 'refuse', it
    finally:
        sb.cleanup()


RETIRED_FLAG = 'memory/archive/retired-20261103/laolin.md'


def test_kind_of_retired_people():
    """2 期：退役的人物文件（P9 那 11 个）开关开了才归 retired；不退役的、archive 里的照常是 memory。"""
    assert len(A.RETIRED_PEOPLE) == 11 and len(set(A.RETIRED_PEOPLE)) == 11, A.RETIRED_PEOPLE
    p = lambda x: A.kind_of(x, people=True)  # noqa: E731
    for rel in A.RETIRED_PEOPLE:
        assert p(rel)[0] == 'retired' and '事件库' in p(rel)[1], (rel, p(rel))
        assert A.kind_of(rel)[0] == 'memory', f'{rel}：开关没开照旧是 memory'
    for rel in ('memory/people/xiaohe-linxi.md', 'memory/people/xiaohe-proactive-preflight.md',
                'memory/people/inbox/xiaohe.md', RETIRED_FLAG, 'memory/archive/retired-20261103/people/xiaohe.md',
                'memory/midterm/self.md', 'memory/open-loops.md'):
        assert p(rel)[0] == 'memory', (rel, p(rel))
    assert A.kind_of('memory/threads/A.md', retired=True, people=True)[0] == 'refuse', '事件线照旧拒'


def test_retired_proposal_skipped():
    """迁移以后（archive 里有 laolin.md）：退役人物文件的提案不让整晚变 bad，跳过、不新建回来，报告「应用」节写一行警告；
    别的提案照常应用；approve 也不收它们。"""
    sb = Sandbox('live')
    try:
        (sb.ws / RETIRED_FLAG).parent.mkdir(parents=True, exist_ok=True)
        sb.git('mv', 'memory/laolin.md', RETIRED_FLAG)
        sb.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', '2 期：人物文件退役')
        code, out = sb.run('begin', DAY)
        assert code == 0, out
        sb.digest(DAY)
        sb.propose(DAY, 'memory/laolin.md', '# 关于 laolin\n- 喜欢拍星星（10-18）\n- 新认识（10-20）\n')
        sb.propose(DAY, 'memory/people/xiaohe.md', '# 小禾\n- 新的一条\n')
        sb.propose(DAY, 'memory/midterm/people.md', '# 人物近况\n#### laolin\n- 近况\n')
        sb.propose(DAY, 'memory/open-loops.md', '# 待办\n## 进行中\n- [ ] 事一\n- [ ] 事二\n')
        sb.write(f'sleep/{DAY}/delete.txt', 'memory/us.md\n')
        code, out = sb.run('approve', DAY, 'memory/laolin.md')
        assert code == 2 and '一个都没批准' in out, out
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert not (sb.ws / 'memory/laolin.md').exists() and not (sb.ws / 'memory/people/xiaohe.md').exists(), '不新建回来'
        assert not (sb.ws / 'memory/midterm/people.md').exists()
        assert '事二' in sb.read('memory/open-loops.md'), '别的照常应用'
        it = items_of(sb)
        for rel in ('memory/laolin.md', 'memory/people/xiaohe.md', 'memory/midterm/people.md', 'memory/us.md'):
            assert it[rel]['kind'] == 'retired' and it[rel]['action'] == 'retired', it[rel]
        assert not [x for x in it.values() if x['action'] == 'bad'], it
        rep = sb.read(f'sleep/{DAY}/report.md')
        app = rep.split('## 应用')[1]
        warn = [l for l in app.splitlines() if '退役' in l]
        assert len(warn) == 1 and warn[0].startswith('- ⚠️') and 'memory/laolin.md' in warn[0] and 'memory/us.md' in warn[0], warn
        assert '拒绝（整晚不应用）' not in app
        st = sb.state()
        assert DAY in st['done'], st
        assert 'memory/laolin.md' not in st['steps'][DAY].get('deferred_files', []), '跳过的不算推迟，下一晚不用重做'
    finally:
        sb.cleanup()


def test_retired_proposal_is_not_a_home_for_moved_lines():
    """缩水保护：开关开了，挪进退役文件提案（会被跳过）的行不算「别处还留着」；没开照旧算。"""
    loops = '# 待办\n## 进行中\n' + ''.join(f'- [ ] 第 {i} 件事（10-{10 + i}）\n' for i in range(1, 13))
    kept = '# 待办\n## 进行中\n' + ''.join(f'- [ ] 第 {i} 件事（10-{10 + i}）\n' for i in range(6, 13))
    moved = '# 我们之间\n' + ''.join(f'- [ ] 第 {i} 件事（10-{10 + i}）\n' for i in range(1, 6))
    for active in (True, False):
        sb = Sandbox('live')
        try:
            sb.write('memory/open-loops.md', loops)
            if active:
                sb.write(RETIRED_FLAG, '# 退役的 laolin.md\n')
            sb.git('add', '-A')
            sb.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', '准备')
            assert sb.run('begin', DAY)[0] == 0
            sb.digest(DAY)
            sb.propose(DAY, 'memory/open-loops.md', kept)                  # 挪走 5 / 12 行
            sb.propose(DAY, 'memory/us.md', moved)
            code, out = sb.run('finish', DAY)
            assert code == 0, out
            act = items_of(sb)['memory/open-loops.md']['action']
            assert act == ('defer' if active else 'apply'), (active, items_of(sb)['memory/open-loops.md'])
        finally:
            sb.cleanup()


def test_retired_paths_apply_before_migration():
    """开关没开（迁移前）：laolin.md、人物近况的提案照旧当记忆应用，报告里没有退役的警告。"""
    sb = Sandbox('live')
    try:
        code, out = sb.run('begin', DAY)
        assert code == 0, out
        sb.digest(DAY)
        sb.propose(DAY, 'memory/laolin.md', '# 关于 laolin\n- 喜欢拍星星（10-18）\n- 新认识（10-20）\n')
        sb.propose(DAY, 'memory/midterm/people.md', '# 人物近况\n#### laolin\n- 近况\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert '新认识' in sb.read('memory/laolin.md') and '近况' in sb.read('memory/midterm/people.md')
        it = items_of(sb)
        assert it['memory/laolin.md']['kind'] == 'memory' and it['memory/laolin.md']['action'] == 'apply', it
        assert '退役' not in sb.read(f'sleep/{DAY}/report.md')
    finally:
        sb.cleanup()


def test_lens_preview_does_not_reject_draft_night():
    sb = lens_sandbox('draft')
    try:
        assert sb.run('begin', DAY)[0] == 0
        lens_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert items_of(sb)['SOUL.lens-xiaohe.md']['action'] == 'preview'
        assert sb.state()['steps'][DAY]['done'] == 'done'
    finally:
        sb.cleanup()


def test_lens_rebuilt_and_committed_with_soul_live():
    sb = lens_sandbox('live')
    try:
        assert sb.run('begin', DAY)[0] == 0
        lens_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        lens = sb.read('SOUL.lens-xiaohe.md')
        assert '嘴硬心软' in lens and '只属于你们俩的心思' not in lens, '应用后按新人格重建镜头'
        soul_files = sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/soul').split()
        assert 'SOUL.lens-xiaohe.md' in soul_files and 'SOUL.md' in soul_files, soul_files
        assert sb.git('status', '--porcelain', '--', 'SOUL.lens-xiaohe.md', 'SOUL.md') == ''
    finally:
        sb.cleanup()


def test_lens_rebuilt_by_earlier_run_does_not_trip_guard():
    """同一晚前一跑已经应用、重建了镜头，然后死在提交上；这一跑重跑时，镜头变了不该被指纹拦住（SOUL.md 也是这样）。"""
    sb = lens_sandbox('live')
    try:
        assert sb.run('begin', DAY)[0] == 0
        lens_night(sb)
        sb.write('SOUL.lens-xiaohe.md', sb.read('SOUL.lens-xiaohe.md') + '（前一跑重建过）\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert 'SOUL.lens-xiaohe.md' not in A.fingerprints(A.Ctx(sb.ws, sb.home, 'none'))
    finally:
        sb.cleanup()


def test_daytime_lens_change_committed_at_begin():
    """她白天改了人格、自己跑了 soul_build：开始时的白天提交要带上镜头，不然它一直留在没提交的改动里。"""
    sb = lens_sandbox('draft')
    try:
        sb.write('soul/20-性格.md', '# 性格\n- 骄傲\n- 白天她自己加的\n')
        build_soul(sb)
        assert sb.run('begin', DAY)[0] == 0
        files = sb.git('show', '--name-only', '--format=', f'day/{DAY}').split()
        assert 'SOUL.lens-xiaohe.md' in files and 'SOUL.md' in files, files
        assert sb.git('status', '--porcelain', '--', 'SOUL.lens-xiaohe.md', 'SOUL.md') == ''
    finally:
        sb.cleanup()


def test_file_changed_after_digest_is_deferred_then_carried():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.write('memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-21 03:10 她半夜又记了一条\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        a = sb.read('memory/threads/A.md')
        assert '半夜又记了一条' in a and '有进展' not in a, '改过的文件不能被覆盖'
        assert '嘴硬心软' in sb.read('soul/20-性格.md'), '别的照常应用'
        assert sb.state()['steps'][DAY]['deferred_files'] == ['memory/threads/A.md']
        assert '推迟' in sb.read(f'sleep/{DAY}/report.md')
        # 下一晚：begin 列出要重做的（带 carry-diff），收尾后标成已接手
        code, out = sb.run('begin', DAY2)
        assert 'memory/threads/A.md' in out and 'carry-diff' in out
        code, out = sb.run('carry-diff', DAY, 'memory/threads/A.md')
        assert code == 0 and '+- 2026-10-20 11:00 有进展' in out and '半夜' not in out, out
        sb.digest(DAY2)
        code, out = sb.run('finish', DAY2)
        assert code == 0, out
        assert sb.state()['steps'][DAY]['carried'] == 'done'
        assert 'memory/threads/A.md' not in sb.run('begin', '2026-10-22')[1]
    finally:
        sb.cleanup()


def test_copied_deferred_proposal_is_refused():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.write('memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-21 03:10 她半夜又记了一条\n')
        assert sb.run('finish', DAY)[0] == 0
        # 下一晚：整理者把旧提案整份拷过来（会盖掉她 03:10 那条）
        sb.run('begin', DAY2)
        sb.digest(DAY2)
        sb.propose(DAY2, 'memory/threads/A.md', sb.read(f'sleep/{DAY}/proposed/memory/threads/A.md'))
        code, out = sb.run('finish', DAY2)
        assert code == 0, out
        assert '半夜又记了一条' in sb.read('memory/threads/A.md'), '拷来的旧提案不能盖掉她后来的改动'
        assert items_of(sb, DAY2)['memory/threads/A.md']['action'] == 'defer'
        assert '一模一样' in items_of(sb, DAY2)['memory/threads/A.md']['reason']
    finally:
        sb.cleanup()


def test_rerun_after_crash_is_idempotent():
    sb = Sandbox('live')
    try:
        sb.write('memory/laolin.md', sb.read('memory/laolin.md') + '- 白天的一条\n')
        sb.run('begin', DAY)
        standard_night(sb)
        real_commit = A.commit

        def boom(ctx, pathspec, msg, **kw):
            if '：记忆' in msg:
                raise A.GitError('模拟：提交到一半机器重启')
            return real_commit(ctx, pathspec, msg, **kw)
        A.commit = boom
        try:
            code, out = sb.run('finish', DAY)
        finally:
            A.commit = real_commit
        assert code == 2 and '提交失败' in out, out
        st = sb.state()
        assert st['steps'][DAY]['apply'] == 'done' and st['steps'][DAY]['finish'].startswith('failed')
        assert st['last_done'] == '2026-10-19', '失败了不能标完成'
        assert 'last_applied_at' not in st
        # 05:30 重跑：begin + finish
        sb.run('begin', DAY)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('sleep/soul-changelog.md').count('嘴硬心软') == 1
        assert sb.read('memory/threads/A.md').count('有进展') == 1
        subjects = sb.git('log', '--format=%s').splitlines()
        assert sum(s.startswith(f'白天 {DAY}') for s in subjects) == 1
        assert sum(s.startswith(f'睡眠整理 {DAY}：记忆') for s in subjects) == 1
        assert sum(s.startswith(f'睡眠整理 {DAY}：人格') for s in subjects) == 1
        st = sb.state()
        assert st['last_done'] == DAY
        assert st.get('last_applied_at'), '重跑时这一轮已经换过东西：也要写 last_applied_at（触发重新冻结）'
        # 再跑一次也不变
        head = sb.git('rev-parse', 'HEAD')
        sb.run('begin', DAY)
        assert sb.run('finish', DAY)[0] == 0
        assert sb.git('rev-parse', 'HEAD') == head
    finally:
        sb.cleanup()


def test_crash_between_commit_and_tag_tags_the_right_commit():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        real_git = A.git
        state = {'n': 0}

        def flaky(ctx, *args, **kw):
            if args[:1] == ('tag',) and args[1].endswith('/memory') and state['n'] == 0:
                state['n'] += 1
                raise A.GitError('模拟：打 tag 前死掉')
            return real_git(ctx, *args, **kw)
        A.git = flaky
        try:
            assert sb.run('finish', DAY)[0] == 2
        finally:
            A.git = real_git
        first = sb.state()['steps'][DAY]['sha-memory']
        sb.run('begin', DAY)
        assert sb.run('finish', DAY)[0] == 0
        assert sb.git('rev-parse', f'sleep/{DAY}/memory^{{commit}}').strip() == first, '要给记下的那个提交打 tag，不是新提交'
        subjects = sb.git('log', '--format=%s').splitlines()
        assert sum(s.startswith(f'睡眠整理 {DAY}：记忆') for s in subjects) == 1
    finally:
        sb.cleanup()


def test_killed_right_after_commit_is_found_by_marker():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        real_git = A.git
        state = {'committed': False, 'died': False}

        def die_after_commit(ctx, *args, **kw):
            if state['committed'] and not state['died'] and args[:1] == ('rev-parse',):
                state['died'] = True
                raise A.GitError('模拟：提交完还没记下就死了')
            p = real_git(ctx, *args, **kw)
            if args[:1] == ('commit',) and any('：记忆' in str(x) for x in args):
                state['committed'] = True
            return p
        A.git = die_after_commit
        try:
            assert sb.run('finish', DAY)[0] == 2
        finally:
            A.git = real_git
        assert 'sha-memory' not in sb.state()['steps'][DAY], '死在记下之前'
        sb.run('begin', DAY)
        code, out = sb.run('finish', DAY)
        assert code == 0 and '按暗记找回' in out, out
        subjects = sb.git('log', '--format=%s').splitlines()
        assert sum(s.startswith(f'睡眠整理 {DAY}：记忆') for s in subjects) == 1, subjects
        assert sb.git('log', '-1', '--format=%s', f'sleep/{DAY}/memory').startswith(f'睡眠整理 {DAY}：记忆（2 个文件）'), \
            sb.git('log', '-1', '--format=%s', f'sleep/{DAY}/memory')
    finally:
        sb.cleanup()


def test_failed_commit_leaves_nothing_staged():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        real_git = A.git

        def no_commit(ctx, *args, **kw):
            if args[:1] == ('commit',):
                raise A.GitError('模拟：提交失败')
            return real_git(ctx, *args, **kw)
        A.git = no_commit
        try:
            assert sb.run('finish', DAY)[0] == 2
        finally:
            A.git = real_git
        assert sb.git('diff', '--cached', '--name-only').strip() == '', '提交失败要把暂存的退回去'
    finally:
        sb.cleanup()


def test_half_applied_files_count_as_same():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        real = A.apply_items

        def die_halfway(ctx, day, items, res):
            # 上一跑死在应用中途：换好第一个文件就断了
            first = [it for it in items if it['rel'] == 'memory/threads/A.md']
            real(ctx, day, first, res)
            raise KeyboardInterrupt('模拟：应用到一半被杀')
        A.apply_items = die_halfway
        try:
            try:
                sb.run('finish', DAY)
            except KeyboardInterrupt:
                pass
        finally:
            A.apply_items = real
        assert sb.state()['steps'][DAY].get('commit-day') == 'done'
        assert '有进展' in sb.read('memory/threads/A.md') and '嘴硬心软' not in sb.read('soul/20-性格.md')
        sb.run('begin', DAY)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert acts['memory/threads/A.md'] == 'same' and acts['soul/20-性格.md'] == 'apply', acts
        assert 'memory/threads/A.md' in sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/memory').split()
        assert sb.read('memory/threads/A.md').count('有进展') == 1
    finally:
        sb.cleanup()


def test_guard_trips_on_sensitive_change():
    for what in ('script', 'launchagent', 'agents', 'hook', 'soul', 'registry', 'dirlink'):
        sb = Sandbox('live')
        try:
            sb.run('begin', DAY)
            standard_night(sb)
            if what == 'script':
                sb.write('scripts/midterm.py', STUB_MIDTERM + '# 被改了\n')
            elif what == 'launchagent':
                (sb.home / 'Library/LaunchAgents/evil.plist').write_text('<plist>evil</plist>')
            elif what == 'agents':
                sb.write('AGENTS.md', '# AGENTS\n- 新规矩\n')
            elif what == 'hook':
                hooks = sb.ws / '.git/hooks'
                hooks.mkdir(exist_ok=True)
                (hooks / 'post-commit').write_text('#!/bin/sh\necho evil\n')
            elif what == 'soul':
                sb.write('soul/40-说话方式.md', SOUL40 + '- 整理时直接改了人格\n')
            elif what == 'registry':
                sb.write('memory/people/registry.json', '{"laolin": {"name": "laolin"}, "x": {"name": "x"}}\n')
            else:
                os.symlink('/tmp', sb.home / 'Library/LaunchAgents/evil')   # a directory link inside a fingerprinted tree
            before = sb.read('memory/threads/A.md')
            code, out = sb.run('finish', DAY)
            assert code == 2, (what, out)
            assert '指纹检查：❌' in out, (what, out)
            assert sb.read('memory/threads/A.md') == before, '没通过就一个文件都不换'
            assert sb.git('log', '--format=%s').splitlines()[0] == 'init', '没通过就不提交（只有 begin 的白天提交，这里没有改动）'
            assert sb.state()['last_done'] == '2026-10-19'
        finally:
            sb.cleanup()


def test_committed_soul_change_is_noted_and_deferred_not_blocking():
    """整理期间 laolin 的会话提交了人格改动（像 10-25 02:54 那样）：不拦整晚，那块人格提案按 hash 推迟，
    跟它一起的 changelog 行也先不记。"""
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.write('soul/20-性格.md', '# 性格\n- 骄傲\n- laolin 拍板加的一条\n')
        sb.git('commit', '-qam', 'laolin 拍板：性格加一条')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert '整理期间有提交改了人格' in out
        assert 'laolin 拍板加的一条' in sb.read('soul/20-性格.md') and '嘴硬心软' not in sb.read('soul/20-性格.md')
        assert '嘴硬心软' not in sb.read('sleep/soul-changelog.md'), '人格块推迟了，它的 changelog 行也先不记'
        assert 'changelog 有 1 行跟着推迟' in out
        assert '有进展' in sb.read('memory/threads/A.md'), '记忆照常应用'
    finally:
        sb.cleanup()


def test_bad_proposal_blocks_the_night():
    for rel in ('scripts/evil.py', 'sleep/state.json', 'sleep/config.json', 'memory/sleep/state.json', 'AGENTS.md'):
        sb = Sandbox('live')
        try:
            sb.run('begin', DAY)
            standard_night(sb)
            sb.propose(DAY, rel, 'x\n')
            before = sb.read('memory/threads/A.md')
            code, out = sb.run('finish', DAY)
            assert code == 2 and '整理不该碰的地方' in out, (rel, out)
            assert sb.read('memory/threads/A.md') == before
            assert not (sb.ws / 'scripts/evil.py').exists()
        finally:
            sb.cleanup()
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('AGENTS.md\n')
        code, out = sb.run('finish', DAY)
        assert code == 2 and (sb.ws / 'AGENTS.md').exists()
    finally:
        sb.cleanup()


def test_gitignored_proposal_is_refused_not_stuck():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.propose(DAY, 'memory/phone/x.md', '# 手机截图记录\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert items_of(sb)['memory/phone/x.md']['action'] == 'refuse' and not (sb.ws / 'memory/phone/x.md').exists()
        assert sb.state()['last_done'] == DAY
    finally:
        sb.cleanup()


def test_a_book_linked_in_from_off_the_workspace_is_never_written_or_deleted():
    """A module's manuals reach the shelf as a linked directory into the HH code, which every role shares."""
    sb = Sandbox('live')
    try:
        book = sb.tmp / 'code/modules/base/skills/work'
        book.mkdir(parents=True)
        (book / 'SKILL.md').write_text('---\nname: work\ndescription: d\n---\n', encoding='utf-8')
        (book / 'dig.md').write_text('# 查到底\n简介：a\n什么时候翻：b\n', encoding='utf-8')
        (book / 'old.md').write_text('# 旧\n简介：a\n什么时候翻：b\n', encoding='utf-8')
        os.symlink(book, sb.ws / 'skills/work')
        before = {p.name: p.read_bytes() for p in book.iterdir()}
        sb.run('begin', DAY)
        standard_night(sb)
        sb.propose(DAY, 'skills/work/dig.md', '# 查到底\n简介：a\n什么时候翻：b\n\n## 做法\n- 先看源头\n')
        sb.propose(DAY, 'skills/work/new.md', '# 新的一页\n简介：a\n什么时候翻：b\n')
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('skills/work/old.md\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        items = items_of(sb)
        for rel in ('skills/work/dig.md', 'skills/work/new.md', 'skills/work/old.md'):
            assert items[rel]['action'] == 'refuse' and items[rel]['reason'] == A.OFF_WS, items[rel]
        assert {p.name: p.read_bytes() for p in book.iterdir()} == before, 'the code is byte for byte as it was'
        assert sb.state()['last_done'] == DAY and '嘴硬心软' in sb.read('soul/20-性格.md'), 'the rest of the night went in'
        code, out = sb.run('promote', DAY, 'skills/work/dig.md')
        assert code == 2 and not (book / 'dig.md').read_text(encoding='utf-8').count('做法'), out
    finally:
        sb.cleanup()


def test_literal_pathspec():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/threads/[AB].md', '# 方括号\n## 经过\n- 2026-10-20 新的\n')
        sb.write('memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-21 03:10 她半夜记的\n')
        assert sb.run('finish', DAY)[0] == 0
        files = sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/memory').split()
        assert 'memory/threads/[AB].md' in files and 'memory/threads/A.md' not in files, files
    finally:
        sb.cleanup()


def test_no_begin_refuses():
    sb = Sandbox('live')
    try:
        standard_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 2 and '没有 begin' in out, out
    finally:
        sb.cleanup()


def test_rebaseline():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.write('scripts/midterm.py', STUB_MIDTERM + '# laolin 半夜装了新版\n')
        sb.run('begin', DAY)                       # 同一晚再 begin：还是按这一晚第一次的指纹比
        assert sb.run('finish', DAY)[0] == 2
        sb.run('begin', DAY, '--rebaseline')       # laolin 核过之后手动
        assert sb.run('finish', DAY)[0] == 0
    finally:
        sb.cleanup()


def make_state_db(path, rows, cron=(('job-1', 'sleep-organize', 'cron'),)):
    con = sqlite3.connect(path)
    con.execute('create table cron_jobs (store_key text, job_id text, name text, enabled int, job_json text)')
    con.execute('create table plugin_state_entries (plugin_id text, namespace text, entry_key text, value_json text, created_at int)')
    for jid, name, kind in cron:
        con.execute('insert into cron_jobs values (?,?,?,?,?)',
                    ('s', jid, name, 1, json.dumps({'id': jid, 'schedule': {'kind': kind}, 'state': {'x': 1}})))
    for i, r in enumerate(rows):
        con.execute('insert into plugin_state_entries values (?,?,?,?,?)',
                    ('core:memory-artifact-provenance', 'workspace-files', f'k{i}', json.dumps(r), 0))
    con.commit()
    con.close()


def test_guard_organizer_wrote_live_memory():
    sb = Sandbox('live')
    try:
        db = sb.tmp / 'state.sqlite'
        make_state_db(db, [])
        sb.state_db = str(db)
        sb.run('begin', DAY)
        standard_night(sb)
        wsk = hashlib.sha256(os.path.realpath(str(sb.ws)).encode()).hexdigest()
        now_ms = int(dt.datetime.now().timestamp() * 1000) + 1000
        con = sqlite3.connect(db)
        for rel in (f'sleep/{DAY}/proposed/memory/laolin.md', 'memory/laolin.md'):
            con.execute('insert into plugin_state_entries values (?,?,?,?,?)', (
                'core:memory-artifact-provenance', 'workspace-files', rel,
                json.dumps({'workspaceKey': wsk, 'relativePath': rel, 'originClass': 'agent', 'observedAt': now_ms,
                            'sessionKey': 'agent:main:cron:job-1:run:abc'}), 0))
        con.commit()
        con.close()
        code, out = sb.run('finish', DAY)
        assert code == 2 and 'memory/laolin.md' in out and '整理任务自己写了' in out, out
    finally:
        sb.cleanup()


def test_cron_definition_change_trips_but_state_and_finished_oneshot_do_not():
    sb = Sandbox('live')
    try:
        db = sb.tmp / 'state.sqlite'
        make_state_db(db, [], cron=(('job-1', 'sleep-organize', 'cron'), ('job-2', '一次性提醒', 'at')))
        ctx = A.Ctx(sb.ws, sb.home, str(db))
        fp1 = A.fingerprints(ctx)
        con = sqlite3.connect(db)
        con.execute("update cron_jobs set job_json=? where job_id='job-1'",
                    (json.dumps({'id': 'job-1', 'schedule': {'kind': 'cron'}, 'state': {'x': 2}}),))
        con.execute("delete from cron_jobs where job_id='job-2'")           # 一次性任务跑完自己删了
        con.commit()
        assert A.diff_fp(fp1, A.fingerprints(ctx)) == [], '运行状态变了、一次性任务跑完没了，都不算'
        con.execute("update cron_jobs set job_json=? where job_id='job-1'",
                    (json.dumps({'id': 'job-1', 'schedule': {'kind': 'cron'}, 'payload': 'x'}),))
        con.execute("insert into cron_jobs values ('s', 'job-3', '新任务', 1, '{}')")
        con.commit()
        con.close()
        d = A.diff_fp(fp1, A.fingerprints(ctx))
        assert any('job-1' in x and '改了' in x for x in d) and any('job-3' in x and '新增' in x for x in d), d
    finally:
        sb.cleanup()


def test_oneshot_jobs_never_trip_the_guard_recurring_still_do():
    """一次性任务（at）新建、改了、跑完没了都不拦（她半夜答应的提醒、自由时间的接续）；新建的写进报告，只写名字。
    定期任务（cron / every）新增、改了、删了照旧整晚拦。"""
    sb = Sandbox('live')
    try:
        db = sb.tmp / 'state.sqlite'
        make_state_db(db, [], cron=(('job-1', 'sleep-organize', 'cron'), ('job-2', '自由时间接续', 'at')))
        ctx = A.Ctx(sb.ws, sb.home, str(db))
        fp1 = A.fingerprints(ctx)

        def jobs(*sql):
            con = sqlite3.connect(db)
            for q, args in sql:
                con.execute(q, args)
            con.commit()
            con.close()
        secret = '提醒的内容不能进报告'
        jobs(("insert into cron_jobs values ('s', 'job-3', '提醒 laolin 喝水', 1, ?)",
              (json.dumps({'id': 'job-3', 'schedule': {'kind': 'at'}, 'payload': {'message': secret}}, ensure_ascii=False),)),
             ("update cron_jobs set job_json=? where job_id='job-2'",
              (json.dumps({'id': 'job-2', 'schedule': {'kind': 'at'}, 'payload': {'message': '改了时间'}}),)))
        notes = []
        assert A.diff_fp(fp1, A.fingerprints(ctx), notes) == [], '一次性任务新建、改了都不拦'
        assert notes == ['整理期间新建了一次性任务：提醒 laolin 喝水（不拦）'] and secret not in ''.join(notes), notes
        jobs(("delete from cron_jobs where job_id in ('job-2', 'job-3')", ()))
        assert A.diff_fp(fp1, A.fingerprints(ctx)) == [], '跑完自己没了也不拦'
        old_fmt = {k: (v if k != 'cron 任务定义' else {j: x[:2] for j, x in v.items()}) for k, v in fp1.items()}
        assert A.diff_fp(old_fmt, fp1) == [], '旧版指纹（没有名字）不算变化'
        jobs(("insert into cron_jobs values ('s', 'job-4', '每天提醒', 1, ?)", (json.dumps({'schedule': {'kind': 'every'}}),)))
        assert any('job-4' in x and '新增' in x for x in A.diff_fp(fp1, A.fingerprints(ctx)))
        jobs(("delete from cron_jobs where job_id='job-4'", ()), ("delete from cron_jobs where job_id='job-1'", ()))
        assert any('job-1' in x and '删了' in x for x in A.diff_fp(fp1, A.fingerprints(ctx))), '定期任务删了照旧拦'
        # 整晚走一遍：begin 之后她建了一个一次性提醒 → 照常应用，报告里写一句
        db2 = sb.tmp / 'state2.sqlite'
        make_state_db(db2, [])
        sb.state_db = str(db2)
        sb.run('begin', DAY)
        standard_night(sb)
        con = sqlite3.connect(db2)
        con.execute("insert into cron_jobs values ('s', 'job-9', '3点答应的提醒', 1, ?)",
                    (json.dumps({'schedule': {'kind': 'at'}, 'payload': {'message': secret}}, ensure_ascii=False),))
        con.commit()
        con.close()
        code, out = sb.run('finish', DAY)
        assert code == 0 and '整理期间新建了一次性任务：3点答应的提醒（不拦）' in out and secret not in out, out
        assert '嘴硬心软' in sb.read('soul/20-性格.md')
    finally:
        sb.cleanup()


def test_delete_needs_content_kept():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        # B 并进 A：B 的「经过」在 A 的提案里 → 可以删
        sb.propose(DAY, 'memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-17 09:00 B 的事（laolin 原话）\n')
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('# 合并\nmemory/threads/B.md\nmemory/laolin.md\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert not (sb.ws / 'memory/threads/B.md').exists()
        assert (sb.ws / 'memory/laolin.md').exists(), 'laolin.md 的内容哪都没有，不能删'
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert acts['memory/threads/B.md'] == 'delete' and acts['memory/laolin.md'] == 'refuse'
        assert 'memory/threads/B.md' in sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/memory').split()
        assert sb.state()['steps'][DAY]['refused_deletes'] == ['memory/laolin.md']
    finally:
        sb.cleanup()


def test_delete_refused_when_its_new_home_is_deferred_or_only_a_preview():
    # B 只并进了 A 的提案，可 A 在整理之后被她改过（推迟）→ B 不能删
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-17 09:00 B 的事（laolin 原话）\n')
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('memory/threads/B.md\n')
        sb.write('memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-21 03:10 她半夜记的\n')
        assert sb.run('finish', DAY)[0] == 0
        assert (sb.ws / 'memory/threads/B.md').exists(), 'B 的去处没应用，B 不能删'
        assert items_of(sb)['memory/threads/B.md']['action'] == 'refuse'
    finally:
        sb.cleanup()
    # 要删一块人格，内容只在预览 SOUL.md 里 → 不能删
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'SOUL.md', sb.read('soul/20-性格.md') + sb.read('soul/40-说话方式.md'))
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('soul/20-性格.md\n')
        assert sb.run('finish', DAY)[0] == 0
        assert (sb.ws / 'soul/20-性格.md').exists(), '预览不算去处'
    finally:
        sb.cleanup()


def test_redigest_after_proposals_is_detected():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        sb.run('step', DAY, '0-digest')
        sb.write('memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-21 03:10 她半夜记的\n')
        sb.digest(DAY)                                   # 写了提案之后又跑了 digest：新 hash 会放行旧提案
        code, out = sb.run('finish', DAY)
        assert code == 2 and 'sources.json 在记下 0-digest 之后变了' in out, out
        assert '半夜记的' in sb.read('memory/threads/A.md')
    finally:
        sb.cleanup()


def test_draft_mode_only_rehearses():
    sb = Sandbox('draft')
    try:
        sb.write('memory/laolin.md', sb.read('memory/laolin.md') + '- 白天的一条\n')
        sb.run('begin', DAY)
        standard_night(sb)
        before = {r: sb.read(r) for r in ('memory/threads/A.md', 'soul/20-性格.md', 'sleep/soul-changelog.md', 'SOUL.md')}
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert {r: sb.read(r) for r in before} == before, 'draft 不动原文件'
        assert '演练' in out and '会覆盖' in out
        subjects = sb.git('log', '--format=%s').splitlines()
        assert subjects[0] == f'睡眠整理 {DAY}（draft）' and subjects[1].startswith(f'白天 {DAY}')
        draft_files = sb.git('show', '--name-only', '--format=', 'HEAD').split()
        assert all(f.startswith(f'sleep/{DAY}/') or f == 'sleep/state.json' for f in draft_files), draft_files
        st = sb.state()
        assert st['last_done'] == DAY and 'last_applied_at' not in st
        assert st['steps'][DAY]['deferred_files'] == [], 'draft 演练里的推迟不算'
        assert '以前没做成' not in sb.run('begin', DAY2)[1]
    finally:
        sb.cleanup()


def test_missing_sources_refuses_live():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        os.remove(sb.ws / f'sleep/{DAY}/sources.json')
        before = sb.read('memory/threads/A.md')
        code, out = sb.run('finish', DAY)
        assert code == 2 and 'sources.json' in out
        assert sb.read('memory/threads/A.md') == before
        assert sb.state()['last_done'] == '2026-10-19'
    finally:
        sb.cleanup()


def test_lint_block_mode():
    sb = Sandbox('live')
    try:
        cfg = json.loads(sb.read('sleep/config.json'))
        cfg['lint_mode'] = 'block'
        sb.write('sleep/config.json', json.dumps(cfg))
        sb.run('begin', DAY)
        standard_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 2 and '机械核对的结果没有' in out, 'block 模式没核对结果就不应用'
        (sb.ws / f'sleep/{DAY}/lint.json').write_text(json.dumps({'day': DAY, 'failed_files': ['memory/threads/A.md']}))
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert '有进展' not in sb.read('memory/threads/A.md') and '机械核对没通过' in out
        assert '嘴硬心软' in sb.read('soul/20-性格.md')
    finally:
        sb.cleanup()


def test_material_decisions():
    sb = Sandbox()
    try:
        D = sb.ws / f'sleep/{DAY}'
        D.mkdir(parents=True, exist_ok=True)
        assert sb.run('material', DAY)[1].splitlines()[0] == 'redigest', '还没有 input.md'

        def m(line2, nights, now):
            (D / 'input.md').write_text(f'# 材料\n{line2}\n')
            st = sb.state()
            st['defer_nights'] = {DAY: nights}           # sleep_digest.py（A1）记的推迟晚数
            sb.write('sleep/state.json', json.dumps(st, ensure_ascii=False))
            return sb.run('material', DAY, '--now', now)[1].splitlines()[0]
        assert m('材料：完整', [], '2026-10-21T02:30:00+11:00') == 'full'
        assert m('材料：不完整（缺：对话库）', ['2026-10-20'], '2026-10-21T02:30:00+11:00') == 'partial'
        assert m('材料：不完整（缺：对话库）', ['2026-10-20'], '2026-10-21T05:30:00+11:00') == 'partial', '同一晚的补跑还是 partial'
        assert m('材料：不完整（缺：对话库）', ['2026-10-20', '2026-10-21'], '2026-10-22T02:30:00+11:00') == 'partial'
        assert m('材料：不完整（缺：对话库）', ['2026-10-20', '2026-10-21', '2026-10-22'], '2026-10-23T02:30:00+11:00') == 'full'
        assert m('旧格式', [], '2026-10-23T02:30:00+11:00') == 'redigest', '旧 digest、还没写提案：重跑 digest'
        sb.propose(DAY, 'memory/threads/A.md', '# A\n')
        assert m('旧格式', [], '2026-10-23T02:30:00+11:00') == 'full', '已经写了提案就别重跑 digest'
        assert 'full' in sb.state()['steps'][DAY]['material'] and sb.state()['note'] == '别人的键'
    finally:
        sb.cleanup()


def test_partial_then_new_cycle():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'skills/phone/SKILL.md', '# 手机\n- 靠谱做法：先截图\n- 靠谱做法：发完核一遍\n')
        code, out = sb.run('finish', DAY, '--partial')
        assert code == 0, out
        assert '发完核一遍' in sb.read('skills/phone/SKILL.md'), '材料不完整也照样应用做了的部分'
        st = sb.state()
        assert st['last_done'] == '2026-10-19', '不标完成'
        assert st['steps'][DAY]['finish'] == 'partial' and st.get('last_applied_at')
        assert sb.git('rev-parse', f'sleep/{DAY}/memory').strip()
        # 下一跑：开新一轮，旧提案挪走，进度清零
        sb.write('memory/laolin.md', sb.read('memory/laolin.md') + '- 两跑之间她又记了一条\n')
        code, out = sb.run('begin', DAY)
        assert '第 2 轮' in out, out
        D = sb.ws / f'sleep/{DAY}'
        assert not (D / 'proposed').exists() and (D / 'cycle-1/proposed/skills/phone/SKILL.md').exists()
        st = sb.state()['steps'][DAY]
        assert st['cycle'] == 2 and 'finish' not in st and st.get('commit-day') == 'done'
        assert sb.git('show', '--name-only', '--format=', f'day/{DAY}.2').split() == ['memory/laolin.md']
        sb.digest(DAY)
        standard_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.git('rev-parse', f'sleep/{DAY}/memory.2').strip() and sb.git('rev-parse', f'sleep/{DAY}/soul.2').strip()
        assert '第 2 轮' in sb.git('log', '-1', '--format=%s', f'sleep/{DAY}/memory.2')
        assert sb.state()['last_done'] == DAY
        assert '发完核一遍' in sb.read('skills/phone/SKILL.md') and '嘴硬心软' in sb.read('soul/20-性格.md')
    finally:
        sb.cleanup()


def test_new_cycle_without_soul_change_makes_no_soul_tag():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        assert sb.run('finish', DAY)[0] == 0
        sb.run('restart', DAY)
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/threads/B.md', sb.read('memory/threads/B.md') + '- 2026-10-20 再补一条\n')
        assert sb.run('finish', DAY)[0] == 0
        assert sb.git('tag', '-l', f'sleep/{DAY}/soul.2').strip() == '', '第 2 轮没改人格，不该有 soul.2（更不能打在第 1 轮的提交上）'
        assert sb.git('tag', '-l', f'sleep/{DAY}/memory.2').strip()
    finally:
        sb.cleanup()


def test_restart_and_lint_blocked_delete():
    sb = Sandbox('live')
    try:
        cfg = json.loads(sb.read('sleep/config.json'))
        cfg['lint_mode'] = 'block'
        sb.write('sleep/config.json', json.dumps(cfg))
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/threads/A.md', sb.read('memory/threads/A.md') + '- 2026-10-17 09:00 B 的事（laolin 原话）\n')
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('memory/threads/B.md\n')
        (sb.ws / f'sleep/{DAY}/lint.json').write_text(json.dumps({'day': DAY, 'failed_files': ['memory/threads/B.md']}))
        assert sb.run('finish', DAY)[0] == 0
        assert (sb.ws / 'memory/threads/B.md').exists(), 'lint 拦下的删除不做'
        code, out = sb.run('restart', DAY)
        assert code == 0 and '第 2 轮' in out
        st = sb.state()['steps'][DAY]
        assert st['cycle'] == 2 and 'done' not in st and 'commit-day' not in st
        assert (sb.ws / f'sleep/{DAY}/cycle-1/proposed/memory/threads/A.md').exists()
    finally:
        sb.cleanup()


def test_lock_busy():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        standard_night(sb)
        import fcntl
        with open(sb.ws / '.git/sleep-apply.lock', 'w') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            code, out = sb.run('finish', DAY)
        assert code == 3
    finally:
        sb.cleanup()


def test_gate_decisions():
    T = lambda s: dt.datetime.fromisoformat(s).replace(tzinfo=A.TZ)  # noqa: E731
    ts = lambda s: T(s).timestamp()  # noqa: E731
    early, late = T('2026-10-25T02:30'), T('2026-10-25T05:30')
    assert A.decide({'five': 75, 'week': 10, 'five_reset': ts('2026-10-25T03:20')}, early)[0] == 'defer'
    assert A.decide({'five': 75, 'week': 10, 'five_reset': ts('2026-10-25T05:30')}, early)[0] == 'defer'
    assert A.decide({'five': 75, 'week': 10, 'five_reset': ts('2026-10-25T06:00')}, early)[0] == 'go'
    assert A.decide({'five': 69, 'week': 10, 'five_reset': ts('2026-10-25T03:20')}, early)[0] == 'go'
    assert A.decide({'five': 90, 'week': 10, 'five_reset': ts('2026-10-25T06:00')}, early)[0] == 'save'
    assert A.decide({'five': 90, 'week': 10, 'five_reset': ts('2026-10-25T03:00')}, early)[0] == 'defer'
    assert A.decide({'five': 10, 'week': 98, 'five_reset': ts('2026-10-25T06:00')}, early)[0] == 'save'
    assert A.decide({'five': 75, 'week': 10, 'five_reset': ts('2026-10-25T08:00')}, late)[0] == 'go'
    assert A.decide({'five': 90, 'week': 10, 'five_reset': ts('2026-10-25T08:00')}, late)[0] == 'save'
    assert A.decide({'five': 95, 'week': 10, 'five_reset': ts('2026-10-25T02:00')}, early)[0] == 'go', '已经重置过'
    assert A.decide(None, early)[0] == 'go'
    sb = Sandbox()
    try:
        code, out = sb.run('gate', '--now', '2026-10-25T02:30:00+11:00', '--usage-json',
                           json.dumps({'five': 80, 'week': 5, 'five_reset': ts('2026-10-25T04:10')}))
        assert code == 0 and out.splitlines()[0] == 'defer'
    finally:
        sb.cleanup()


def test_steps_keep_unknown_keys_and_prune():
    sb = Sandbox()
    try:
        for i in range(35):
            d = (dt.date(2026, 9, 1) + dt.timedelta(days=i)).isoformat()
            sb.run('step', d, '1-threads')
        st = sb.state()
        assert st['note'] == '别人的键' and len(st['steps']) == A.KEEP_STEP_DAYS
        assert '2026-09-01' not in st['steps'] and st['steps']['2026-10-05']['1-threads'] == 'done'
        code, out = sb.run('steps', '2026-10-05')
        assert '1-threads\tdone' in out
    finally:
        sb.cleanup()


def test_merge_list_sections():
    ops = A.merge_list('# M\n## 规矩\n- 一\n- 二\n## 账号\n- 甲\n', '# M\n## 规矩\n- 一\n- 二改\n## 账号\n- 甲\n- 乙\n')
    assert ('规矩', '改', '- 二\n    → - 二改') in ops, ops
    assert ('账号', '加', '- 乙') in ops, ops


def test_soul_week_lists_who_changed():
    sb = Sandbox('live')
    try:
        sb.write('soul/40-说话方式.md', SOUL40.replace('1. 短。', '1. 短。\n2. 她白天自己加的'))
        sb.write('sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') +
                 f'- {DAY} 「说话方式」 旧：（无）→ 新：她白天自己加的｜依据：laolin 原话\n')
        sb.run('begin', DAY)
        standard_night(sb)
        assert sb.run('finish', DAY)[0] == 0
        code, out = sb.run('soul-week', '2026-10-25')
        assert code == 0
        assert '「说话方式」' in out and '「性格」' in out
        assert '〔整理者〕' in out and '〔白天' in out
        assert '好坏例子区：没变' in out
        assert 'soul/40-说话方式.md' in out, '中文文件名要原样显示'
    finally:
        sb.cleanup()


# ---------- 10-25 搬家（memory/sleep/ → sleep/）----------

def test_day_commit_picks_up_sleep_changelog_and_config():
    """白天的提交照旧带上 changelog 和 config.json（以前是 memory 这个路径顺带的），不带各天的目录和 state.json。"""
    sb = Sandbox('draft')
    try:
        sb.write('sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') + '- 2026-10-20 「性格」 白天她自己记的\n')
        sb.write('sleep/config.json', json.dumps({'mode': 'draft', 'lint_mode': 'report'}))
        sb.write('sleep/2026-10-19/report.md', '旧报告\n')
        assert sb.run('begin', DAY)[0] == 0
        files = sb.git('show', '--name-only', '--format=', f'day/{DAY}').split()
        assert set(files) == {'sleep/soul-changelog.md', 'sleep/config.json'}, files
        assert 'sleep/state.json' not in sb.git('ls-files', 'sleep').split() or \
            sb.git('status', '--porcelain', '--', 'sleep/state.json').strip(), 'state.json 不跟白天提交'
    finally:
        sb.cleanup()


def test_stray_old_changelog_merged_at_begin():
    sb = Sandbox('draft')
    try:
        old_line = sb.read('sleep/soul-changelog.md').strip()
        sb.write('memory/sleep/soul-changelog.md', old_line + '\n- 2026-10-20 「性格」 她照旧说明记到了老地方\n')
        code, out = sb.run('begin', DAY)
        assert code == 0 and '老地方' in out, out
        cl = sb.read('sleep/soul-changelog.md')
        assert cl.count('记到了老地方') == 1 and cl.count(old_line) == 1, cl
        assert not (sb.ws / 'memory/sleep').exists(), '老文件删掉，空目录也删'
        assert 'sleep/soul-changelog.md' in sb.git('show', '--name-only', '--format=', f'day/{DAY}').split()
        assert '老地方' not in sb.run('begin', DAY)[1], '只并一次'
    finally:
        sb.cleanup()


def test_old_path_changelog_proposal_still_appends():
    sb = Sandbox('live')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'soul/20-性格.md', '# 性格\n- 骄傲\n- 嘴硬心软\n')
        sb.propose(DAY, 'memory/sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') +
                   f'- {DAY} 「性格」 旧：（无）→ 新：嘴硬心软｜依据：laolin 原话｜整理者\n')
        code, out = sb.run('finish', DAY)
        assert code == 0 and '老地方' in out, out
        assert sb.read('sleep/soul-changelog.md').count('嘴硬心软') == 1
        assert not (sb.ws / 'memory/sleep').exists()
        assert 'sleep/soul-changelog.md' in sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/soul').split()
    finally:
        sb.cleanup()


def test_organizer_write_under_old_sleep_dir_is_foreign():
    sb = Sandbox('live')
    try:
        db = sb.tmp / 'state.sqlite'
        make_state_db(db, [])
        sb.state_db = str(db)
        sb.run('begin', DAY)
        standard_night(sb)
        wsk = hashlib.sha256(os.path.realpath(str(sb.ws)).encode()).hexdigest()
        con = sqlite3.connect(db)
        for rel in (f'sleep/{DAY}/proposed/memory/laolin.md', f'memory/sleep/{DAY}/proposed/memory/laolin.md'):
            con.execute('insert into plugin_state_entries values (?,?,?,?,?)', (
                'core:memory-artifact-provenance', 'workspace-files', rel,
                json.dumps({'workspaceKey': wsk, 'relativePath': rel, 'originClass': 'agent',
                            'observedAt': int(dt.datetime.now().timestamp() * 1000) + 1000,
                            'sessionKey': 'agent:main:cron:job-1:run:abc'}), 0))
        con.commit()
        con.close()
        code, out = sb.run('finish', DAY)
        assert code == 2 and f'memory/sleep/{DAY}/proposed/memory/laolin.md' in out, out
        assert f'、sleep/{DAY}/proposed' not in out and f'：sleep/{DAY}/proposed' not in out, '自己的工作目录不算越界'
    finally:
        sb.cleanup()


# ---------- 缩水保护、人格上限、人工放行和回滚 ----------

LAOLIN12 = '# 关于 laolin\n## 他这个人\n' + ''.join(f'- 第 {i} 条关于他的事（10-{10 + i}）\n' for i in range(1, 13))


def shrink_night(sb, day=DAY, keep=4):
    """laolin.md 那样的大压缩：12 行留 keep 行，其余挪进 archive（默认挪走 8 行，超过一半）。"""
    lines = LAOLIN12.splitlines(keepends=True)
    sb.digest(day)
    sb.propose(day, 'memory/laolin.md', ''.join(lines[:2 + keep]))
    sb.propose(day, 'memory/archive/laolin.md', '# laolin.md 的归档\n## 10-20\n' + ''.join(lines[2 + keep:]))
    sb.propose(day, 'memory/threads/B.md', sb.read('memory/threads/B.md') + f'- {day} 10:00 B 又有进展（laolin 原话）\n')


def laolin_sandbox(mode='live'):
    sb = Sandbox(mode)
    sb.write('memory/laolin.md', LAOLIN12)
    sb.git('commit', '-qam', 'laolin.md 12 行')
    return sb


def test_shrink_guard_defers_big_compression():
    sb = laolin_sandbox()
    try:
        sb.run('begin', DAY)
        shrink_night(sb)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('memory/laolin.md') == LAOLIN12, '一次删掉一半：推迟，原文件不动'
        it = items_of(sb)['memory/laolin.md']
        assert it['action'] == 'defer' and it['guard'] == 'shrink' and it['shrink'] == [8, 12] and '大压缩' in it['reason'], it
        assert items_of(sb)['memory/threads/B.md']['action'] == 'apply', '别的照常应用'
        assert '等人批' in out and f'approve {DAY}' in out
        st = sb.state()['steps'][DAY]
        assert st['guard_deferred'] == ['memory/laolin.md'] and 'memory/laolin.md' in st['deferred_files']
        assert st['done'] == 'done'
        out2 = sb.run('begin', DAY2)[1]
        assert 'memory/laolin.md' in out2 and '别重提那次大改' in out2, out2
    finally:
        sb.cleanup()


def test_shrink_guard_thresholds_and_exemptions():
    sb = laolin_sandbox()
    try:
        sb.write('memory/midterm/self.md', '<!-- 写于 2026-10-20 03:00 -->\n# 这两天的我\n' + ''.join(f'第 {i} 段，昨晚写的。\n' for i in range(6)))
        sb.git('add', '-A')
        sb.git('commit', '-qm', '中期')
        sb.run('begin', DAY)
        lines = LAOLIN12.splitlines(keepends=True)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/laolin.md', ''.join(lines[:2 + 8]))          # 删 4 行（不到 5 行）：不拦
        sb.propose(DAY, 'memory/midterm/self.md', '<!-- 写于 2026-10-21 03:00 -->\n# 这两天的我\n' +
                   ''.join(f'第 {i} 段，今晚重写的。\n' for i in range(5)))   # 每晚重写：不拦
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert acts['memory/laolin.md'] == 'apply' and acts['memory/midterm/self.md'] == 'apply', acts
        assert A.shrink_of('- 一二三四\n' * 3 + '- 五六七八\n', '- 一二三四\n')[0] == ['- 五六七八'], '同一行留一份就不算删'
    finally:
        sb.cleanup()


def test_approved_proposal_passes_the_guard_until_it_changes():
    sb = laolin_sandbox()
    try:
        sb.run('begin', DAY)
        shrink_night(sb)
        code, out = sb.run('approve', DAY, 'memory/laolin.md')
        assert code == 0 and '批准了' in out and '还没收尾' in out, out
        assert sb.run('approve', DAY, 'MEMORY.md')[0] == 2, 'MEMORY.md 不归脚本写，不能批准'
        sb.propose(DAY, 'memory/laolin.md', sb.read(f'sleep/{DAY}/proposed/memory/laolin.md') + '- 批准以后又改了一行\n')
        assert sb.run('plan', DAY)[1].count('缩水保护') == 1, '提案变了，批准不算数'
        sb.run('approve', DAY, 'memory/laolin.md')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert '批准以后又改了一行' in sb.read('memory/laolin.md'), '批准过的照常应用（hash 核对照旧）'
        assert items_of(sb)['memory/laolin.md'].get('approved') is True
    finally:
        sb.cleanup()


def test_approve_promote_then_rollback():
    sb = laolin_sandbox()
    try:
        sb.run('begin', DAY)
        shrink_night(sb)
        assert sb.run('promote', DAY, 'memory/laolin.md')[0] == 2, '还没收尾不能 promote'
        assert sb.run('finish', DAY)[0] == 0
        before = sb.state()['last_applied_at']
        assert sb.run('approve', DAY, 'memory/laolin.md')[1].count('已经收尾') == 1
        code, out = sb.run('promote', DAY, 'memory/laolin.md')
        assert code == 0, out
        assert sb.read('memory/laolin.md') == sb.read(f'sleep/{DAY}/proposed/memory/laolin.md')
        assert sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/promote').split() == ['memory/laolin.md'], \
            sb.git('show', '--name-only', '--format=', f'sleep/{DAY}/promote')
        st = sb.state()
        assert st['last_applied_at'] >= before and st['steps'][DAY]['promote' + 'd'][0]['rel'] == 'memory/laolin.md'
        assert 'memory/laolin.md' not in st['steps'][DAY]['deferred_files'] and st['steps'][DAY]['guard_deferred'] == []
        assert 'memory/laolin.md' not in sb.run('begin', DAY2)[1], '放行了的不用下一晚重做'
        assert sb.git('status', '--porcelain', '--', 'memory', 'soul', 'SOUL.md') == ''
        # 再 promote 一次：已经一样，没有新提交、也不打 .2
        head = sb.git('rev-parse', 'HEAD')
        assert sb.run('promote', DAY, 'memory/laolin.md')[0] == 0 and sb.git('rev-parse', 'HEAD') == head
        assert not sb.git('tag', '-l', f'sleep/{DAY}/promote.2').strip()
        # 回滚记忆：promote 和那一晚的记忆提交都倒回去，进度（state.json、sleep/ 工作区）不动
        old = sb.state()
        old['last_applied_at'] = '2000-01-01T00:00:00+11:00'          # 时间只到秒：先改旧，看回滚有没有重写它
        sb.write('sleep/state.json', json.dumps(old, ensure_ascii=False))
        code, out = sb.run('rollback', DAY, '--memory')
        assert code == 0, out
        assert f'sleep/{DAY}/promote' in out and f'sleep/{DAY}/memory' in out
        assert out.index(f'sleep/{DAY}/promote') < out.index(f'sleep/{DAY}/memory'), '新的先回滚'
        assert sb.read('memory/laolin.md') == LAOLIN12
        assert not (sb.ws / 'memory/archive/laolin.md').exists() and 'B 又有进展' not in sb.read('memory/threads/B.md')
        assert sb.state()['steps'][DAY]['done'] == 'done' and (sb.ws / f'sleep/{DAY}/report.md').exists()
        assert sb.state()['last_applied_at'] > '2000-01-01T00:00:00+11:00'
        assert sb.git('status', '--porcelain', '--', 'memory') == ''
        assert '已经回滚过' in sb.run('rollback', DAY, '--memory')[1], '再跑一次不重复回滚'
    finally:
        sb.cleanup()


def test_promote_refuses_when_live_changed_since_digest():
    sb = laolin_sandbox()
    try:
        sb.run('begin', DAY)
        shrink_night(sb)
        assert sb.run('finish', DAY)[0] == 0
        sb.write('memory/laolin.md', LAOLIN12 + '- 早上她又记了一条\n')
        code, out = sb.run('promote', DAY, 'memory/laolin.md', 'memory/threads/B.md')
        assert code == 2 and '现在的原文件上重做' in out, out
        assert '早上她又记了一条' in sb.read('memory/laolin.md'), '一个都不动'
    finally:
        sb.cleanup()


VALUES = '# 价值观\n' + ''.join(f'- 价值观第 {i} 条\n' for i in range(1, 16))
SNAP70 = ('# 教训\n<!-- 注入：快照 -->\n详情：memory/lessons.md\n## 快照\n' + ''.join(f'- 快照教训 {i}\n' for i in range(5)) +
          '## 其余\n' + ''.join(f'- 其余教训 {i}\n' for i in range(15)))


def values_changed(*idx):
    """把价值观第 idx 条改掉：隔着 3 行以上没改的各算一处，只隔 1、2 行的算一处。"""
    lines = VALUES.splitlines(keepends=True)
    for i in idx:
        lines[i] = f'- 价值观第 {i} 条（改过）\n'
    return ''.join(lines)


def soul_sandbox():
    sb = Sandbox('live')
    sb.write('soul/25-价值观.md', VALUES)
    sb.write('soul/70-教训.md', SNAP70)
    sb.write('soul/90-杂.md', '# 杂\n- 一条\n')
    sb.git('add', '-A')
    sb.git('commit', '-qm', '人格块')
    return sb


def soul_cap_night(sb, day=DAY):
    """价值观 3 处 + 说话方式 2 处 = 5 处（正好不超）；教训的快照整段重写（学习记录，不算人格上限）。"""
    sb.digest(day)
    sb.propose(day, 'soul/25-价值观.md', values_changed(1, 5, 9))
    sb.propose(day, 'soul/40-说话方式.md', SOUL40.replace('1. 短。', '1. 很短。') + '- 三\n')
    sb.propose(day, 'soul/70-教训.md', SNAP70.replace('- 快照教训 0\n- 快照教训 1\n', '- 新的快照教训 a\n- 新的快照教训 b\n')
               .replace('- 其余教训 3\n', '- 其余教训 3（又犯了）\n').replace('- 其余教训 9\n', '- 其余教训 9（又犯了）\n'))
    sb.propose(day, 'sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') +
               f'- {day} 「价值观」 改三条｜整理者\n- {day} 「说话方式」 改一条加一条｜整理者\n- {day} 「教训」 快照换两条｜整理者\n')
    sb.propose(day, 'memory/threads/B.md', sb.read('memory/threads/B.md') + f'- {day} 10:00 B 又有进展（laolin 原话）\n')


def test_soul_hunks_coalesce_close_changes():
    assert A.soul_hunks(VALUES, values_changed(1, 3)) == 1, '只隔 1 行：一处'
    assert A.soul_hunks(VALUES, values_changed(1, 4)) == 1, '只隔 2 行：一处'
    assert A.soul_hunks(VALUES, values_changed(1, 5)) == 2, '隔 3 行：两处'
    assert A.soul_hunks(VALUES, values_changed(1, 5, 9, 13)) == 4
    assert A.soul_hunks('', '# 新块\n- 一\n') == 1 and A.soul_hunks(VALUES, VALUES) == 0
    assert A.is_snapshot_block(SNAP70, SNAP70) and not A.is_snapshot_block(VALUES, VALUES)
    assert not A.is_snapshot_block(SNAP70, SNAP70.replace(A.SNAPSHOT_MARK, '')), '提案把标记删了：算人格块'


def test_soul_cap_defers_personality_blocks_not_learning_snapshots():
    sb = soul_sandbox()
    try:
        sb.run('begin', DAY)
        soul_cap_night(sb)
        acts = {it['rel']: it['action'] for it in A.make_plan(A.Ctx(sb.ws, sb.home, 'none'), DAY)}
        assert acts['soul/25-价值观.md'] == 'apply' and acts['soul/40-说话方式.md'] == 'apply', '正好 5 处：不拦'
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('soul/90-杂.md\n')       # 删一块人格算一处：6 处
        sb.propose(DAY, 'memory/archive/soul.md', '# 归档\n- 一条\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        its = items_of(sb)
        # laolin 10-29 去掉了人格上限：6 处照样应用，不再整晚推迟
        assert A.SOUL_CAP is None
        assert not any(it.get('guard') == 'soul-cap' for it in its.values()), its
        assert its['soul/25-价值观.md']['action'] == 'apply' and its['soul/40-说话方式.md']['action'] == 'apply', its
        assert its['soul/70-教训.md']['action'] == 'apply' and its['soul/70-教训.md'].get('snapshot_block')
        assert '新的快照教训 a' in sb.read('soul/70-教训.md') and '改过' in sb.read('soul/25-价值观.md')
        cl = sb.read('sleep/soul-changelog.md')
        assert '改三条' in cl and '改一条加一条' in cl and '快照换两条' in cl
        assert 'B 又有进展' in sb.read('memory/threads/B.md')
        assert '人格上限' not in sb.read(f'sleep/{DAY}/report.md')
    finally:
        sb.cleanup()


def test_snapshot_block_still_has_the_shrink_guard():
    sb = soul_sandbox()
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'soul/70-教训.md', '# 教训\n<!-- 注入：快照 -->\n详情：memory/lessons.md\n## 快照\n- 只剩一条\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        it = items_of(sb)['soul/70-教训.md']
        assert it['action'] == 'defer' and it['guard'] == 'shrink', it
    finally:
        sb.cleanup()


def test_soul_cap_under_limit_and_approval_overrides():
    sb = soul_sandbox()
    try:
        sb.run('begin', DAY)
        soul_cap_night(sb)
        ctx = A.Ctx(sb.ws, sb.home, 'none')
        sb.propose(DAY, 'soul/25-价值观.md', values_changed(1, 5, 9, 13))      # 价值观 4 处 + 说话方式 2 处 = 6
        acts = {it['rel']: it['action'] for it in A.make_plan(ctx, DAY)}
        assert acts['soul/25-价值观.md'] == 'apply' and acts['soul/40-说话方式.md'] == 'apply', acts   # 10-29 起没有人格上限
        assert acts['soul/70-教训.md'] == 'apply'
        assert sb.run('approve', DAY, 'soul/25-价值观.md')[0] == 0                # 批准的不算数：剩 2 处
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('soul/25-价值观.md').count('改过') == 4 and '很短' in sb.read('soul/40-说话方式.md')
        assert '改三条' in sb.read('sleep/soul-changelog.md')
    finally:
        sb.cleanup()


THREAD_T = ('# 事件\n<!-- 事件线 开始=2026-10-10 最近进展=2026-10-15 10:00 状态=进行中 -->\n## 一句话\n旧的一句话说法\n'
            '## 简述\n旧的简述，说了很多很多。\n## 现在的状态\n- 状态一：在等回音\n- 状态二：下周再说\n- 状态三：先放着\n'
            '## 经过\n- 2026-10-11 09:00 开始（laolin 原话）\n### 第二周\n- 2026-10-15 10:00 有进展（laolin 原话）\n'
            '## 因果和判断\n- 判断一：可能要等很久\n- 判断二：别催他\n')


def test_thread_rewrites_pass_but_jingguo_is_append_only():
    sb = Sandbox('live')
    try:
        sb.write('memory/threads/事件.md', THREAD_T)
        sb.write('memory/threads/无经过.md', '# 无经过\n' + ''.join(f'- 第 {i} 条笔记\n' for i in range(8)))
        sb.git('add', '-A')
        sb.git('commit', '-qm', '事件线')
        sb.run('begin', DAY)
        sb.digest(DAY)
        jg = THREAD_T.split('## 经过\n', 1)[1].split('## 因果和判断', 1)[0]
        rewritten = ('# 事件\n<!-- 事件线 开始=2026-10-10 最近进展=2026-10-20 11:00 状态=暂停 -->\n## 一句话\n全新的一句话\n'
                     '## 简述\n全新的简述。\n## 现在的状态\n- 暂停，等他回来\n## 经过\n' + jg +
                     f'- {DAY} 11:00 暂停（laolin 原话）\n## 因果和判断\n- 新的判断\n')
        sb.propose(DAY, 'memory/threads/事件.md', rewritten)                   # 摘要整段重写：放行
        sb.propose(DAY, 'memory/threads/无经过.md', '# 无经过\n- 第 0 条笔记\n- 第 1 条笔记\n')   # 没有「经过」：照 25% 算
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        its = items_of(sb)
        assert its['memory/threads/事件.md']['action'] == 'apply' and sb.read('memory/threads/事件.md') == rewritten
        assert its['memory/threads/无经过.md']['action'] == 'defer' and its['memory/threads/无经过.md']['guard'] == 'shrink'
        # 第二晚：「经过」少了一行（第二周那条）→ 推迟；批准了就放行
        sb.run('begin', DAY2)
        sb.digest(DAY2)
        lost = rewritten.replace('- 2026-10-15 10:00 有进展（laolin 原话）\n', '')
        sb.propose(DAY2, 'memory/threads/事件.md', lost)
        acts = {it['rel']: it for it in A.make_plan(A.Ctx(sb.ws, sb.home, 'none'), DAY2)}
        it = acts['memory/threads/事件.md']
        assert it['action'] == 'defer' and it['guard'] == 'jingguo' and '经过' in it['reason'], it
        sb.run('approve', DAY2, 'memory/threads/事件.md')
        assert sb.run('finish', DAY2)[0] == 0 and '有进展' not in sb.read('memory/threads/事件.md')
    finally:
        sb.cleanup()


def test_rollback_soul_only_and_refuses_dirty():
    sb = Sandbox('live')
    try:
        sb.write('memory/threads/事件甲.md', '# 事件甲\n## 经过\n- 2026-10-18 开始\n')
        sb.git('add', '-A')
        sb.git('commit', '-qm', '中文名的事件线')
        sb.run('begin', DAY)
        standard_night(sb)
        sb.propose(DAY, 'memory/threads/事件甲.md', '# 事件甲\n## 经过\n- 2026-10-18 开始\n- 2026-10-20 有进展\n')
        assert sb.run('finish', DAY)[0] == 0
        sb.write('sleep/soul-changelog.md', sb.read('sleep/soul-changelog.md') + '- 2026-10-21 「世界」 她早上自己记的\n')
        sb.write('soul/20-性格.md', sb.read('soul/20-性格.md') + '- 早上没提交的改动\n')
        code, out = sb.run('rollback', DAY, '--soul')
        assert code == 2 and 'soul/20-性格.md' in out, out
        assert '早上没提交的改动' in sb.read('soul/20-性格.md')
        sb.git('checkout', '--', 'soul/20-性格.md')
        code, out = sb.run('rollback', DAY, '--soul')
        assert code == 0, out
        assert '嘴硬心软' not in sb.read('soul/20-性格.md') and '嘴硬心软' not in sb.read('SOUL.md')
        cl = sb.read('sleep/soul-changelog.md')
        assert '嘴硬心软' not in cl and '她早上自己记的' in cl, 'changelog 只删那一晚加的行'
        assert '有进展' in sb.read('memory/threads/事件甲.md') and '新' in sb.read('memory/threads/A.md'), '只回滚人格'
        assert sb.git('status', '--porcelain', '--', 'soul', 'SOUL.md', 'memory') == ''
        assert sb.state()['steps'][DAY]['done'] == 'done'
        # 回滚以后同一天再跑 finish（比如那一晚没标完成，05:30 又来）：不能又把人格换回去
        code, out = sb.run('finish', DAY)
        assert code == 0 and '回滚过' in out, out
        assert '嘴硬心软' not in sb.read('soul/20-性格.md') and sb.git('status', '--porcelain', '--', 'soul', 'SOUL.md') == ''
        code, out = sb.run('rollback', DAY)                          # 再全部回滚：人格那个已经回滚过，只剩记忆
        assert code == 0 and '已经回滚过' in out, out
        assert '有进展' not in sb.read('memory/threads/事件甲.md') and sb.read('memory/threads/A.md').count('旧') == 1
    finally:
        sb.cleanup()


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f'ok   {name}')
        except Exception as e:  # noqa: BLE001
            failed += 1
            import traceback
            print(f'FAIL {name}: {type(e).__name__}: {e}')
            traceback.print_exc()
    print(f'{len(tests) - failed}/{len(tests)} 通过')
    return 1 if failed else 0


def test_fade_into_archive_is_not_shrink():
    """laolin 10-26：只淡出不删。原样挪进 archive 的行不算丢；挪走不到一半照常应用；真丢了（哪都找不到）超过 25% 才拦。"""
    lines = LAOLIN12.splitlines(keepends=True)
    sb = laolin_sandbox()
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'memory/laolin.md', ''.join(lines[:2 + 7]) + '- 第 8–12 条归并成一条（详见 archive/laolin.md）\n')   # 挪走 5 行（42%）
        sb.propose(DAY, 'memory/archive/laolin.md', '# laolin.md 的归档\n## 10-20\n' + ''.join(lines[2 + 7:]))
        ctx = A.Ctx(sb.ws, sb.home, 'none')
        acts = {it['rel']: it for it in A.make_plan(ctx, DAY)}
        assert acts['memory/laolin.md']['action'] == 'apply', acts['memory/laolin.md']
        sb.propose(DAY, 'memory/archive/laolin.md', '# laolin.md 的归档\n## 10-20\n')                          # 没挪过去，真丢了
        it = {i['rel']: i for i in A.make_plan(ctx, DAY)}['memory/laolin.md']
        assert it['action'] == 'defer' and it['shrink'] == [5, 12] and '丢了' in it['reason'], it
    finally:
        sb.cleanup()


# ---------- 笔记本（skills/）的闸门：不丢行、编号都在、没过把关的列出来 ----------

L39 = '- 教训：截图前没解锁｜什么时候：要截图的时候｜下次：先亮屏解锁｜犯的日子：2026-10-25｜出处：#12345 <!-- l:0039 -->'
L41 = '- 教训：发图前没压缩｜什么时候：要发图的时候｜下次：先压到 2MB 以下｜犯的日子：2026-10-28｜出处：#13001 <!-- l:0041 -->'
NB_PAGE = f'''# 截图 <!-- p:0012 -->
简介：手机上截图、存图的做法。
什么时候翻：要截图、发图的时候

## 做法
1. 先亮屏再截图
2. 截完核一遍存没存上

## 教训
{L39}
{L41}

## 相关
- 手机怎么开：skills/phone/SKILL.md
'''


def hh_ids(sb, ids=(), fail=None, hang=False):
    """假的 hh：家目录里 hh 用的那个 node 换成小脚本。`learn ids` 一行回一个编号；fail：像 hhd 没开那样退出码 1；hang：卡住不回。"""
    p = Path(os.environ['HH_BIN'])
    p.parent.mkdir(parents=True, exist_ok=True)
    body = ('exec sleep 5\n' if hang else f'echo "{fail}" >&2\nexit 1\n' if fail else
            '[ "$1 $2" = "learn ids" ] || exit 9\n' + ''.join(f'echo {i}\n' for i in ids))
    p.write_text('#!/bin/sh\n' + body)
    p.chmod(0o755)


def notebook_sandbox(ids=None, fail=None):
    """手机那本里有一页带编号的笔记（页 0012，教训 0039、0041）。ids：hh learn ids 回的编号；ids 和 fail 都没给 = 没装 hh。"""
    sb = Sandbox('live')
    os.environ['HH_BIN'] = str(sb.home / 'hh')   # the hh this sandbox has (none until hh_ids writes one)
    sb.write('skills/phone/截图.md', NB_PAGE)
    sb.git('add', '-A')
    sb.git('commit', '-qm', '笔记本')
    if ids is not None or fail:
        hh_ids(sb, ids or (), fail)
    return sb


def test_skills_lost_line_blocks_skills_batch():
    """skills/ 里删掉的内容行在应用后的 skills/（含归档）里哪都找不到：这一晚 skills/ 的提案整批不应用（要删的也不删），别的照常。"""
    sb = notebook_sandbox(['0012', '0039', '0041'])
    try:
        sb.write('skills/phone/旧.md', '# 旧\n- 靠谱做法：先截图\n')         # 内容 SKILL.md 里有：本来可以删
        sb.git('add', '-A')
        sb.git('commit', '-qm', '旧页')
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'skills/phone/截图.md', NB_PAGE.replace('2. 截完核一遍存没存上\n', ''))   # 这一行哪都没放
        sb.propose(DAY, 'skills/phone/SKILL.md', sb.read('skills/phone/SKILL.md') + '- 靠谱做法：发完核一遍\n')
        (sb.ws / f'sleep/{DAY}/delete.txt').write_text('skills/phone/旧.md\n')
        sb.propose(DAY, 'memory/laolin.md', sb.read('memory/laolin.md') + '- 新认识（10-20）\n')
        code, out = sb.run('plan', DAY)
        assert code == 0 and '笔记本这晚没换' in out and '截完核一遍存没存上' in out, out
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == NB_PAGE and '发完核一遍' not in sb.read('skills/phone/SKILL.md')
        assert (sb.ws / 'skills/phone/旧.md').exists(), '要删的也不删'
        assert '新认识' in sb.read('memory/laolin.md'), '别的照常应用'
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert {acts[r] for r in ('skills/phone/截图.md', 'skills/phone/SKILL.md', 'skills/phone/旧.md')} == {'defer'}, acts
        assert acts['memory/laolin.md'] == 'apply', acts
        rep = sb.read(f'sleep/{DAY}/report.md')
        assert '笔记本这晚没换' in rep and '截完核一遍存没存上' in rep and 'skills/phone/截图.md' in rep, rep
        assert '编号' not in rep.split('笔记本这晚没换', 1)[1].split('\n', 1)[0], '编号都在，只是丢了行'
        assert sb.state()['steps'][DAY]['done'] == 'done'
    finally:
        sb.cleanup()


def test_skills_moved_line_ok():
    """挪走不算丢：删掉的行在别的页或归档里找得到就照常应用（归档里没带编号注释也认）；
    并掉的教训，编号写进留下那条的注释里（一个注释几个号，排第几都算）也算还在。"""
    sb = notebook_sandbox(['0012', '0039', '0041'])
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        merged = '- 教训：截图、发图前没准备好｜什么时候：要截图、发图的时候｜下次：先解锁、先压缩｜出处：#12345、#13001 <!-- l:0039 l:0041 -->'
        page = NB_PAGE.replace('2. 截完核一遍存没存上\n', '').replace(f'{L39}\n{L41}\n', merged + '\n')
        sb.propose(DAY, 'skills/phone/截图.md', page)
        sb.propose(DAY, 'skills/phone/SKILL.md', sb.read('skills/phone/SKILL.md') + '- 2. 截完核一遍存没存上\n')   # 挪到别的页
        sb.propose(DAY, 'skills/phone/归档/截图-2026-10-20.md',                                           # 原文进归档，不带编号
                   '# 截图：10-20 并掉的两条教训\n' + L39.split(' <!--')[0] + '\n' + L41.split(' <!--')[0] + '\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == page and '截完核一遍' in sb.read('skills/phone/SKILL.md')
        assert (sb.ws / 'skills/phone/归档/截图-2026-10-20.md').exists()
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert acts['skills/phone/截图.md'] == 'apply' and acts['skills/phone/归档/截图-2026-10-20.md'] == 'create', acts
        assert '笔记本这晚没换' not in sb.read(f'sleep/{DAY}/report.md')
    finally:
        sb.cleanup()


def test_ids_missing_blocks_skills_batch():
    """编号闸门：hh learn ids 认得、应用前 skills/ 里也有的编号，应用后要还在某个编号注释里；少了一个，skills/ 整批不应用。"""
    sb = notebook_sandbox(['0012', '0039', '0041'])
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'skills/phone/截图.md', NB_PAGE.replace(' <!-- l:0041 -->', ''))   # 内容都在，编号 0041 没了
        sb.propose(DAY, 'skills/phone/SKILL.md', sb.read('skills/phone/SKILL.md') + '- 靠谱做法：发完核一遍\n')
        sb.propose(DAY, 'memory/laolin.md', sb.read('memory/laolin.md') + '- 新认识（10-20）\n')
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == NB_PAGE and '发完核一遍' not in sb.read('skills/phone/SKILL.md')
        assert '新认识' in sb.read('memory/laolin.md'), '别的照常应用'
        acts = {r: it['action'] for r, it in items_of(sb).items()}
        assert acts['skills/phone/截图.md'] == 'defer' and acts['skills/phone/SKILL.md'] == 'defer', acts
        line = sb.read(f'sleep/{DAY}/report.md').split('笔记本这晚没换', 1)[1].split('\n', 1)[0]
        assert '0041' in line and '0039' not in line and '0012' not in line, line
    finally:
        sb.cleanup()


def test_ids_unavailable_skips_gate():
    """拿不到编号（hhd 没开、hh 跑不起来）：跳过编号闸门、报告里写一行，丢行检查照做，skills/ 照常应用。"""
    sb = notebook_sandbox(fail='连不上 hhd')
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        page = NB_PAGE.replace(' <!-- l:0041 -->', '')
        sb.propose(DAY, 'skills/phone/截图.md', page)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == page
        rep = sb.read(f'sleep/{DAY}/report.md')
        assert '编号检查跳过了' in rep and '退出码 1' in rep and '笔记本这晚没换' not in rep, rep
        ids, why = A.learn_ids(A.Ctx(sb.ws, sb.tmp / '没装hh', 'none'))
        assert ids is None and why, '没装 hh 也只是拿不到'
    finally:
        sb.cleanup()


def test_id_deleted_during_day_does_not_block():
    """白天删掉的页（HH 还没扫到，编号单上还有它）：应用前的 skills/ 里已经没有这个号，不算这一晚弄丢的。"""
    sb = notebook_sandbox(['0012', '0039', '0041', '0050'])
    try:
        sb.write('skills/phone/录屏.md', '# 录屏 <!-- p:0050 -->\n简介：手机录屏的做法。\n')
        sb.git('add', '-A')
        sb.git('commit', '-qm', '录屏')
        (sb.ws / 'skills/phone/录屏.md').unlink()                 # 白天她删了这页
        sb.run('begin', DAY)
        sb.digest(DAY)
        page = NB_PAGE + '- 截完要发图：skills/phone/发图.md\n'
        sb.propose(DAY, 'skills/phone/截图.md', page)
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == page
        assert '笔记本这晚没换' not in sb.read(f'sleep/{DAY}/report.md')
    finally:
        sb.cleanup()


def test_unchecked_entries_reported_not_blocked():
    """应用后新出现的教训行和「## 做法」下的条目，不等于把关收下（add / merge）的任何一条：报告里列出来，照常应用。
    把关的结论没有（文件不在）= 一条都没收：新的全列。"""
    lesson_a = '- 教训：截图后没存相册｜什么时候：要截图的时候｜下次：截完看一眼相册｜犯的日子：2026-10-30｜出处：#14000'
    lesson_b = ('- 教训：发图之前没有先问清楚对方要原图还是压缩图，结果发了两遍又让对方等了很久才收到｜什么时候：要发图的时候｜'
                '下次：先问要原图还是压缩图｜犯的日子：2026-10-30｜出处：#14001')
    page = (NB_PAGE.replace('2. 截完核一遍存没存上\n', '2. 截完核一遍存没存上\n3. 发给 laolin 前先裁掉状态栏\n4. 截长图用滚动截屏，别拼图\n')
            .replace(L41 + '\n', f'{L41}\n{lesson_a}\n{lesson_b}\n') + '- 截完要发图：skills/phone/发图.md\n')
    sb = notebook_sandbox(['0012', '0039', '0041'])
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        sb.propose(DAY, 'skills/phone/截图.md', page)
        sb.propose(DAY, 'skills/phone/归档/截图-旧做法.md', '# 旧做法\n## 做法\n- 以前截图先关通知（归档的不算进笔记本）\n')
        ctx = A.Ctx(sb.ws, sb.home, 'none')
        found = [l for _, l in A.unchecked_entries(ctx, DAY, A.make_plan(ctx, DAY))]
        assert len(found) == 4 and '3. 发给 laolin 前先裁掉状态栏' in found and lesson_a in found, found
        verdicts = [
            {'i': 1, 'kind': '教训', 'page': '0012', 'text': '截图后没存相册', 'verdict': 'add', 'into': None,
             'finalText': lesson_a[2:], 'why': '有出处，具体'},
            {'i': 2, 'kind': '做法', 'page': '0012', 'text': '裁状态栏', 'verdict': 'merge', 'into': '2. 截完核一遍存没存上',
             'finalText': '3.  发给 laolin 前先裁掉状态栏', 'why': '并进第 2 步'},
            {'i': 3, 'kind': '教训', 'page': '0012', 'text': lesson_b, 'verdict': 'reject', 'into': None, 'finalText': None, 'why': '一次性的事'},
            {'i': 4, 'kind': '做法', 'page': '0012', 'text': '长图', 'verdict': 'unchecked', 'into': None, 'finalText': None, 'why': None},
        ]
        vp = Path(os.environ['HH_STATE_DIR']) / 'learn/check' / f'{DAY}.json'   # where HH writes them, not under the home: a second role's home is the first one's
        vp.parent.mkdir(parents=True, exist_ok=True)
        vp.write_text(json.dumps(verdicts, ensure_ascii=False))
        code, out = sb.run('finish', DAY)
        assert code == 0, out
        assert sb.read('skills/phone/截图.md') == page, '只报告，不拦'
        rep = sb.read(f'sleep/{DAY}/report.md')
        listed = [l for l in rep.splitlines() if '没过把关就进来的' in l]
        assert len(listed) == 2, listed
        assert '4. 截长图用滚动截屏，别拼图' in listed[0] + listed[1] and lesson_b[:80] in rep and lesson_b not in rep, listed
        assert '笔记本这晚没换' not in rep
        many = A.unchecked_report([('skills/x.md', f'- 教训：第 {i} 条') for i in range(12)])
        assert len(many) == 11 and '还有 2 条' in many[-1], many
    finally:
        (Path(os.environ['HH_STATE_DIR']) / 'learn/check' / f'{DAY}.json').unlink(missing_ok=True)
        sb.cleanup()


# ---------- 笔记本的闸门：她每晚照指南做的正常改动不拦（11-01 第一轮修改） ----------

PAGE = 'skills/phone/截图.md'
PENDING = '\n### 待验证\n- 截长图用滚动截屏（10-01 摸索，成了一次）\n- 发图前先压到 2MB（10-20 摸索）\n'


def notebook_night(files=None, ids=('0012', '0039', '0041')):
    """notebook_sandbox 再写上 files（begin 时当白天的改动提交），begin + digest 好：可以直接提提案了。"""
    sb = notebook_sandbox(list(ids))
    for rel, text in (files or {}).items():
        sb.write(rel, text)
    sb.run('begin', DAY)
    sb.digest(DAY)
    return sb


def gate_night(sb, proposals, deletes=()):
    """换一套提案（旧的清掉），算计划和笔记本的闸门：(写进报告的几行连成一串, {文件: 计划里那一项})。"""
    shutil.rmtree(sb.ws / 'sleep' / DAY / 'proposed', ignore_errors=True)
    for rel, text in proposals.items():
        sb.propose(DAY, rel, text)
    (sb.ws / f'sleep/{DAY}/delete.txt').write_text(''.join(r + '\n' for r in deletes))
    ctx = A.Ctx(sb.ws, sb.home, 'none')
    items = A.make_plan(ctx, DAY)
    notes = A.notebook_gate(ctx, DAY, items)
    return '\n'.join(notes), {it['rel']: it for it in items}


def test_cover_tightening_passes():
    """封面（第一个 ## 之前的简介、什么时候翻）每晚收紧是常事：改了不算丢。"""
    sb = notebook_night()
    try:
        page = (NB_PAGE.replace('简介：手机上截图、存图的做法。', '简介：截图、长截图、存相册的做法。')
                .replace('什么时候翻：要截图、发图的时候', '什么时候翻：要截图的时候（发图看 发图.md）'))
        notes, its = gate_night(sb, {PAGE: page})
        assert '没换' not in notes and its[PAGE]['action'] == 'apply', (notes, its[PAGE])
    finally:
        sb.cleanup()


def test_map_tick_passes():
    """知识地图 skills/MAP.md 整个不核（打勾、表格那一行重写）；别的文件里打勾、后面加「已并入」也按核心算原样还在。"""
    map_ = ('# 知识地图\n## 要并的旧技能\n- [ ] senses-event-layer → `skills/living/senses.md`\n'
            '## 手册\n| 本 | 在哪 | 讲什么 |\n|---|---|---|\n| 手机 | skills/phone | 截图、录屏、发图 |\n')
    sb = notebook_night({'skills/MAP.md': map_})
    try:
        new = (map_.replace('- [ ] senses-event-layer → `skills/living/senses.md`',
                            '- [x] senses-event-layer → `skills/living/senses.md` 已并入 2026-10-26')
               .replace('| 手机 | skills/phone | 截图、录屏、发图 |', '| 手机 | skills/phone | 截图、录屏、发图、投屏（10-31 起） |'))
        notes, its = gate_night(sb, {'skills/MAP.md': new})
        assert '没换' not in notes and its['skills/MAP.md']['action'] == 'apply', (notes, its['skills/MAP.md'])
        notes, its = gate_night(sb, {'skills/phone/SKILL.md': '# 手机\n- [x] 靠谱做法：先截图 已并入 2026-10-26\n'})
        assert '没换' not in notes and its['skills/phone/SKILL.md']['action'] == 'apply', notes
    finally:
        sb.cleanup()


def test_skill_md_directory_entry_passes():
    """SKILL.md 的 frontmatter（description）和目录条目（点到 .md 的列表项）常改，不核；SKILL.md 别的行照核（搬家前手册就写在里面）。"""
    skill = '---\nname: phone\ndescription: 手机怎么用：截图、录屏、发图\n---\n# 手机\n- 截图.md：手机上截图、存图的做法\n- 靠谱做法：先截图\n'
    sb = notebook_night({'skills/phone/SKILL.md': skill})
    try:
        new = skill.replace('截图、录屏、发图', '截图、录屏、发图、投屏').replace('- 截图.md：手机上截图、存图的做法', '- 截图.md：截图、长截图、存相册')
        notes, its = gate_night(sb, {'skills/phone/SKILL.md': new})
        assert '没换' not in notes and its['skills/phone/SKILL.md']['action'] == 'apply', (notes, its['skills/phone/SKILL.md'])
        notes, its = gate_night(sb, {'skills/phone/SKILL.md': new.replace('- 靠谱做法：先截图\n', '')})
        assert '笔记本这晚没换' in notes and '靠谱做法：先截图' in notes, notes
    finally:
        sb.cleanup()


def test_renumbered_method_step_passes():
    """做法里插一步、后面的改编号；一行按「；」拆成两行；教训行加犯的日子和出处：都算原样还在。"""
    base = NB_PAGE.replace('1. 先亮屏再截图', '1. 先亮屏再截图；截完先别退出相机')
    sb = notebook_night({PAGE: base})
    try:
        page = (base.replace('1. 先亮屏再截图；截完先别退出相机\n2. 截完核一遍存没存上',
                             '1. 先亮屏再截图\n2. 截完先别退出相机\n3. 截前关掉通知\n4. 截完核一遍存没存上')
                .replace('犯的日子：2026-10-25｜出处：#12345', '犯的日子：2026-10-25、2026-10-31｜出处：#12345、#14002'))
        notes, its = gate_night(sb, {PAGE: page})
        assert '没换' not in notes and its[PAGE]['action'] == 'apply', (notes, its[PAGE])
    finally:
        sb.cleanup()


def test_unverified_prefix_passes():
    """标「没验证过」、打 ✓ 加日期、SKILL.md 一行标成「不再用（日期，原因）：…」：状态标记不算改了内容。"""
    base = NB_PAGE.replace('2. 截完核一遍存没存上\n', '2. 截完核一遍存没存上\n' + PENDING)
    sb = notebook_night({PAGE: base})
    try:
        page = (base.replace('- 发图前先压到 2MB（10-20 摸索）', '- 「没验证过」发图前先压到 2MB（10-20 摸索）')
                .replace('- 截长图用滚动截屏（10-01 摸索，成了一次）', '- ✓ 截长图用滚动截屏（10-01 摸索，成了一次）10-31 又成了'))
        skill = '# 手机\n- 不再用（10-31，换成截图.md 的做法）：靠谱做法：先截图\n'
        notes, its = gate_night(sb, {PAGE: page, 'skills/phone/SKILL.md': skill})
        assert '没换' not in notes, notes
        assert its[PAGE]['action'] == 'apply' and its['skills/phone/SKILL.md']['action'] == 'apply', its
    finally:
        sb.cleanup()


def test_deleted_method_line_still_blocks():
    """真删掉的做法（换成别的说法，原话哪都没留）照样拦。"""
    sb = notebook_night()
    try:
        notes, its = gate_night(sb, {PAGE: NB_PAGE.replace('2. 截完核一遍存没存上', '2. 截前关掉通知')})
        assert '笔记本这晚没换' in notes and '截完核一遍存没存上' in notes and its[PAGE]['action'] == 'defer', notes
    finally:
        sb.cleanup()


def test_lesson_id_moved_into_method_step_blocks():
    """编号要在 HH 认的位置：教训号挪到做法的一步上、写进 SKILL.md，HH 都不认，算不见了。"""
    sb = notebook_night()
    try:
        page = NB_PAGE.replace(' <!-- l:0041 -->', '').replace('2. 截完核一遍存没存上', '2. 截完核一遍存没存上 <!-- l:0041 -->')
        notes, its = gate_night(sb, {PAGE: page})
        assert '编号 0041' in notes and its[PAGE]['action'] == 'defer', notes
        notes, its = gate_night(sb, {PAGE: NB_PAGE.replace(' <!-- l:0041 -->', ''),
                                     'skills/phone/SKILL.md': '# 手机\n- 靠谱做法：先截图\n- 发图前没压缩 <!-- l:0041 -->\n'})
        assert '编号 0041' in notes, notes
    finally:
        sb.cleanup()


def test_ids_timeout_skips_gate():
    """hh learn ids 卡住：等 LEARN_IDS_TIMEOUT 秒就不等了，跳过编号闸门（不会把整理卡住）。"""
    sb = notebook_sandbox()
    hh_ids(sb, hang=True)
    old = A.LEARN_IDS_TIMEOUT
    A.LEARN_IDS_TIMEOUT = 0.5
    try:
        t = time.time()
        ids, why = A.learn_ids(A.Ctx(sb.ws, sb.home, 'none'))
        assert ids is None and '秒没回' in why and time.time() - t < 4, (ids, why)
    finally:
        A.LEARN_IDS_TIMEOUT = old
        sb.cleanup()


def test_gate_reasons_capped_at_10():
    """「笔记本这晚没换」最多列 10 条原因，多的写「还有 N 条」。"""
    steps = ''.join(f'{i}. 第 {i} 步：照着做的一件具体的事\n' for i in range(1, 61))
    base = NB_PAGE.replace('1. 先亮屏再截图\n2. 截完核一遍存没存上\n', steps)
    sb = notebook_night({PAGE: base})
    try:
        page = base
        for i in range(1, 13):
            page = page.replace(f'{i}. 第 {i} 步：照着做的一件具体的事\n', '')
        notes, its = gate_night(sb, {PAGE: page})
        assert its[PAGE]['action'] == 'defer' and notes.count('哪都找不到') == 10 and '还有 2 条' in notes, notes
    finally:
        sb.cleanup()


def test_blocked_innocent_file_redone_verbatim_next_night():
    """被闸门整批挡下的那晚，没问题的文件下一晚原样重提：原文件没变（就是那晚的底稿），照常应用，不当成「整份拷过来」。"""
    sb = notebook_sandbox(['0012', '0039', '0041'])
    try:
        sb.run('begin', DAY)
        sb.digest(DAY)
        skill = sb.read('skills/phone/SKILL.md') + '- 靠谱做法：发完核一遍\n'
        lost = NB_PAGE.replace('2. 截完核一遍存没存上\n', '')
        sb.propose(DAY, 'skills/phone/SKILL.md', skill)
        sb.propose(DAY, PAGE, lost)
        assert sb.run('finish', DAY)[0] == 0
        its = items_of(sb)
        assert its['skills/phone/SKILL.md']['action'] == 'defer' and its[PAGE]['action'] == 'defer', its
        sb.run('begin', DAY2)
        sb.digest(DAY2)
        sb.propose(DAY2, 'skills/phone/SKILL.md', skill)                               # 原样重提
        sb.propose(DAY2, PAGE, lost)
        sb.propose(DAY2, 'skills/phone/归档/截图-2026-10-21.md', '# 截图：10-21 挪走的\n2. 截完核一遍存没存上\n')   # 这回放进归档
        code, out = sb.run('finish', DAY2)
        assert code == 0, out
        its = items_of(sb, DAY2)
        assert its['skills/phone/SKILL.md']['action'] == 'apply' and its[PAGE]['action'] == 'apply', its
        assert '发完核一遍' in sb.read('skills/phone/SKILL.md') and sb.read(PAGE) == lost
    finally:
        sb.cleanup()


def test_unchecked_report_ignores_edits():
    """没过把关的单子按核心比：改编号、打 ✓ 加日期、教训加犯的日子都是改，不列；做法里新写的一段话照列。"""
    base = NB_PAGE.replace('2. 截完核一遍存没存上\n', '2. 截完核一遍存没存上\n' + PENDING)
    sb = notebook_night({PAGE: base})
    try:
        para = '截图之后先别急着发，等通知栏收起来再截一张干净的。'
        page = (base.replace('1. 先亮屏再截图\n2. 截完核一遍存没存上\n', f'1. 截完核一遍存没存上\n2. 先亮屏再截图\n{para}\n')
                .replace('- 截长图用滚动截屏（10-01 摸索，成了一次）', '- ✓ 截长图用滚动截屏（10-01 摸索，成了一次）10-31 又成了')
                .replace('犯的日子：2026-10-25｜出处：#12345', '犯的日子：2026-10-25、2026-10-31｜出处：#12345、#14002'))
        notes, its = gate_night(sb, {PAGE: page})
        assert '没换' not in notes and its[PAGE]['action'] == 'apply', (notes, its[PAGE])
        ctx = A.Ctx(sb.ws, sb.home, 'none')
        found = [l for _, l in A.unchecked_entries(ctx, DAY, list(its.values()))]
        assert found == [para], found
    finally:
        sb.cleanup()


if __name__ == '__main__':
    sys.exit(main())


def test_fingerprints_a_file_in_home_that_cannot_be_read_is_a_value_not_a_crash():
    """Step 0 fingerprints files in home: one it may not read (a new role in a sandbox, a file of another user) counts as
    unreadable, so begin goes on; the night's check then says it could not be checked."""
    sb = lens_sandbox('live')
    try:
        p = sb.home / '.gitconfig'
        p.write_text('[user]\n', encoding='utf-8')
        p.chmod(0)
        fp = A.fingerprints(A.Ctx(sb.ws, sb.home, 'none'))
        assert fp['~/.gitconfig'].startswith('unreadable'), fp['~/.gitconfig']
        assert sb.run('begin', DAY)[0] == 0
    finally:
        (sb.home / '.gitconfig').chmod(0o600)
        sb.cleanup()


def test_begin_commits_when_sleep_holds_only_what_is_left_out():
    """A new role's sleep/ holds only its days, state.json and dot files, all left out of the day's commit: begin commits
    the day's other changes and goes on, instead of stopping on a pathspec git finds nothing for."""
    sb = Sandbox('live')
    try:
        sh('git', 'rm', '-r', '-q', 'sleep', cwd=sb.ws)
        sh('git', 'commit', '-q', '-m', 'no sleep yet', cwd=sb.ws)
        sb.write('sleep/state.json', json.dumps({'last_done': '2026-10-19'}))
        sb.write('sleep/2026-10-19/note.md', 'x\n')
        sb.write('memory/threads/new.md', '白天记的\n')
        code, out = sb.run('begin', DAY)
        assert code == 0, out
        assert '提交失败' not in out
        assert 'memory/threads/new.md' in sh('git', 'show', '--name-only', '--format=', 'HEAD', cwd=sb.ws)
    finally:
        sb.cleanup()


def test_a_git_error_keeps_what_git_said_last():
    """The organizer reads why a commit failed: xcrun's cache lines in front are dropped, git's own last line is kept."""
    class P:
        returncode, stdout = 1, ''
        stderr = 'xcrun: error: cannot create cache\nxcrun: error: cannot create cache again\nerror: pathspec \':(literal)sleep\' did not match any file(s) known to git\n'
    with mock.patch.object(A.subprocess, 'run', return_value=P()):
        try:
            A.git(A.Ctx(Path('/x'), Path('/x'), 'none'), 'commit', '-q')
            assert False, 'should raise'
        except A.GitError as e:
            assert "did not match any file(s) known to git" in str(e) and 'xcrun' not in str(e), str(e)
