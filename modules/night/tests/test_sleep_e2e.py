#!/usr/bin/python3
"""睡眠整理端到端测试：把真的脚本串起来跑，draft 两晚、live 两晚。跑法：python3 scripts/test_sleep_e2e.py

为什么要有它：10-25 查出来的是接缝 bug。sleep_apply 的测试用的 soul_build 替身不写访客镜头，两边的测试都过，
真跑起来每一晚都会被拒。所以这里用的都是真脚本：sleep_apply.py、soul_build.py（registry 里有访客镜头）、midterm.py、
memory_lint.py（--no-raw-db）、ledger_snapshot.py（HH_WORKSPACE 指到假工作区）、sleep_digest.py 的 pending 和 done。
只有生成材料是替身：照 test_sleep_apply.py 的 Sandbox 写 sources.json、input.md（真的 digest 要读对话库）。
第 10 步的预览、核对命令直接从 sleep_organize.md 里抠出来，在工作区根目录照原样跑（相对的 --root sleep/<日期>/proposed）。
"""
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
PY = '/usr/bin/python3'
REAL = ('night_names.py', 'sleep_apply.py', 'soul_build.py', 'midterm.py', 'memory_lint.py', 'ledger_snapshot.py', 'sleep_digest.py',
        'recall.py', 'redact.py')
D1, D2 = '2026-10-20', '2026-10-21'
NOW = '2026-10-22T02:30:00+11:00'          # 10-22 凌晨这一跑：还没整理的是 10-20、10-21
GENERATED = ('SOUL.md', 'SOUL.lens-xiaohe.md', 'memory/recent.md')
COVERED = ('memory', 'soul', 'skills', 'SOUL.md', 'SOUL.lens-xiaohe.md', 'MEMORY.md', 'USER.md')

SOUL40 = ('# 说话方式\n### 聊天风格\n1. 短。\n#### 好的和坏的（照着好的那一列的感觉说话）\n他：气死了\n- ✅\n    ？？？\n'
          '#### 几件具体的事\n- 叫他「你」\n')
SOUL50 = ('# 和 laolin\n\n### 怎么和 laolin 相处\n\n像搭档。\n\n### 你对 laolin 的心思\n\n只属于你们俩的心思。\n\n'
          '### 他对你的期待\n\n他在认真养你。\n')
LAOLIN = '# 关于 laolin\n## 维护规则\n- 只记他的原话和她的直接观察\n## 他这个人\n' + \
        ''.join(f'- 他的第 {i} 件事：说过的一句话（10-{10 + i}，laolin 原话）\n' for i in range(1, 13))


def thread(title, extra=''):
    return (f'# {title}\n<!-- 事件线 开始=2026-10-15 最近进展=2026-10-18 10:00 状态=进行中 -->\n## 一句话\n{title}在做\n'
            f'## 简述\n{title}这件事还在做，下一步接着推进。\n## 现在的状态\n- 在做\n## 经过\n- 2026-10-18 10:00 开始（laolin 原话）\n'
            f'{extra}## 因果和判断\n')


def guide_commands():
    """整理指南第 10 步写的预览和核对命令（指南改了路径、脚本没跟上，这里就会挂）。"""
    guide = (HERE / 'sleep_organize.zh.md').read_text(encoding='utf-8')   # the Chinese guide: this role is Chinese
    step10 = guide.split('## 第 10 步', 1)[1]
    run = lambda c: re.sub(r'^night (\w+)', lambda m: f'/usr/bin/python3 scripts/{m.group(1)}.py', c)   # the guide's `night <script>` is that script
    pre = [run(c) for c in re.findall(r'`(night (?:midterm|soul_build) --root [^`]+)`', step10)]
    lint = [run(c) for c in re.findall(r'`(night memory_lint <日期> --report)`', step10)]
    assert len(pre) == 2 and len(lint) == 1, (pre, lint)
    assert all('--root sleep/<日期>/proposed' in c for c in pre), pre
    return pre, lint[0] + ' --no-raw-db'


PREVIEW, LINT = guide_commands()


class FakeWS:
    def __init__(self, mode):
        self.tmp = Path(tempfile.mkdtemp(prefix='sleep-e2e-', dir=os.environ.get('SLEEP_APPLY_TEST_TMP') or None))
        self.ws, self.home = self.tmp / 'ws', self.tmp / 'home'
        self.env = dict(os.environ, LEAK_GUARD_STATE=str(self.home / 'lg-state'), HH_WORKSPACE=str(self.ws))
        files = {
            'AGENTS.md': '# AGENTS\n', 'IDENTITY.md': '# IDENTITY\n', 'USER.md': '# USER\n- laolin\n',
            'MEMORY.md': '# MEMORY\n## 规矩\n- 规矩一\n',
            'soul/00-地图.md': '# 地图\n- 改了在 `sleep/soul-changelog.md` 记一行\n',
            'soul/20-性格.md': '# 性格\n- 骄傲\n', 'soul/40-说话方式.md': SOUL40, 'soul/50-和laolin.md': SOUL50,
            'memory/people/registry.json': json.dumps({
                'laolin': {'name': 'laolin', 'privacy': 'owner'},
                'xiaohe': {'name': '小禾', 'privacy': 'guest', 'lens': 'SOUL.lens-xiaohe.md'}}, ensure_ascii=False),
            'memory/laolin.md': LAOLIN, 'memory/open-loops.md': '# 待办\n## 进行中\n- [ ] 事一\n## 最近完成\n',
            'memory/timeline.md': '# 时间轴\n', 'memory/threads/A事.md': thread('A事'), 'memory/threads/B事.md': thread('B事'),
            'sleep/config.json': json.dumps({'mode': mode, 'lint_mode': 'report', 'sunday_merge': 'draft'}),
            'sleep/state.json': json.dumps({'last_done': '2026-10-19'}),
            'sleep/soul-changelog.md': '- 2026-10-19 「世界」 旧：a → 新：b｜依据：laolin 10-19\n',
            '.gitignore': 'memory/phone/\nsleep/.state.lock\nsleep/*/input.md\nledger/\n',
        }
        for rel, text in files.items():
            self.write(rel, text)
        (self.ws / 'scripts').mkdir()
        for f in REAL:
            shutil.copy(HERE / f, self.ws / 'scripts' / f)
        hh_test_env.with_words(self.ws / 'scripts')
        shutil.copy(HERE / 'sleep_organize.zh.md', self.ws / 'scripts/sleep_organize.md')   # a Chinese role's own guide
        for d in ('Library/LaunchAgents', '.openclaw/extensions/leak-guard', 'lg-state'):
            (self.home / d).mkdir(parents=True, exist_ok=True)
        (self.home / '.openclaw/openclaw.json').write_text('{}')
        self.sh(PY, 'scripts/soul_build.py')
        self.sh(PY, 'scripts/midterm.py', 'build')
        assert (self.ws / 'SOUL.lens-xiaohe.md').exists(), '真的 soul_build.py 要拼出访客镜头'
        self.git('init', '-q')
        self.git('config', 'user.name', 'test')
        self.git('config', 'user.email', 'test@example.com')
        self.git('add', '-A')
        self.git('commit', '-qm', 'init')

    def write(self, rel, text):
        p = self.ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')

    def read(self, rel):
        return (self.ws / rel).read_text(encoding='utf-8')

    def sh(self, *args, ok=True):
        p = subprocess.run(args, cwd=self.ws, capture_output=True, text=True, env=self.env)
        if ok:
            assert p.returncode == 0, (args, p.stdout[-2000:], p.stderr[-2000:])
        return p

    def git(self, *args):
        return self.sh('git', '-c', 'core.quotepath=false', *args).stdout

    def sa(self, *args):
        """照整理指南那样在工作区根目录跑 scripts/sleep_apply.py（家目录、状态库换成沙箱的）。"""
        p = self.sh(PY, 'scripts/sleep_apply.py', '--home', str(self.home), '--state-db', 'none', *args, ok=False)
        return p.returncode, p.stdout + p.stderr

    def guide(self, cmd, day):
        return self.sh(*shlex.split(cmd.replace('<日期>', day)))

    def pending(self):
        return self.sh(PY, 'scripts/sleep_digest.py', 'pending', '--no-write', '--root', str(self.ws), '--now', NOW).stdout.split()

    def digest(self, day):
        """替身：digest 那一刻原文件的 hash（sources.json）和完整的材料（input.md）。"""
        files = {}
        for top in ('memory', 'soul', 'skills'):
            for p in sorted((self.ws / top).rglob('*.md')) if (self.ws / top).is_dir() else []:
                files[p.relative_to(self.ws).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
        for rel in ('MEMORY.md', 'USER.md', 'SOUL.md'):
            files[rel] = hashlib.sha256((self.ws / rel).read_bytes()).hexdigest()
        self.write(f'sleep/{day}/sources.json', json.dumps({'day': day, 'generated_at': NOW, 'files': files}))
        self.write(f'sleep/{day}/input.md', f'# 睡眠整理材料：{day}\n材料：完整\n\n## 1. 对话\nlaolin：今天很顺\n')

    def state(self):
        return json.loads(self.read('sleep/state.json'))

    def items(self, day):
        return {it['rel']: it for it in json.loads(self.read(f'sleep/{day}/apply.json'))['items']}

    def tags(self):
        return set(self.git('tag', '-l').split())

    def dirty(self):
        """记忆、人格、生成的文件有没有没提交的（sleep/ 的工作目录、进度跟下一晚的提交，不算）。"""
        return self.git('status', '--porcelain', '--untracked-files=all', '--', *COVERED).strip()

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


def night(w, day, make_proposals):
    """一晚：白天她记了东西 → 第 0 步 → 写提案 → 第 10 步的预览、报告、核对 → finish。返回 finish 的 (退出码, 输出)。"""
    w.write(f'memory/{day}.md', f'# {day}\n- 白天她记的一条\n')
    w.write('sleep/soul-changelog.md', w.read('sleep/soul-changelog.md') + f'- {day} 「世界」 白天她自己记的一行｜依据：她自己\n')
    rc, out = w.sa('begin', day)
    assert rc == 0, out
    assert set(w.git('show', '--name-only', '--format=', f'day/{day}').split()) == {f'memory/{day}.md', 'sleep/soul-changelog.md'}, \
        '白天的改动在开始时提交：changelog 在 sleep/ 下也要带上'
    w.digest(day)
    proposals = make_proposals(w)
    assert w.sa('step', day, '0-digest')[0] == 0
    rc, out = w.sa('material', day)
    assert out.splitlines()[0] == 'full', out
    for rel, text in proposals.items():
        w.write(f'sleep/{day}/proposed/{rel}', text)
    for cmd in PREVIEW:
        w.guide(cmd, day)
    P = w.ws / f'sleep/{day}/proposed'
    assert (P / 'SOUL.md').exists() and (P / 'SOUL.lens-xiaohe.md').exists() and (P / 'memory/recent.md').exists()
    w.write(f'sleep/{day}/report.md', f'# 睡眠整理报告 {day}\n\n## 拿不准\n\n（没有）\n')
    assert w.sa('step', day, '10-report')[0] == 0
    w.guide(LINT, day)
    assert '<!-- lint:start -->' in w.read(f'sleep/{day}/report.md')
    assert w.sa('step', day, '10-lint')[0] == 0
    return w.sa('finish', day)


def night1(w):
    """第一晚：事件线 A 有进展、新月记、中期、人格改一处（带 changelog）、MEMORY.md 提案、laolin.md 一次挪走一大半（挪进 archive，超过一半算大压缩）。"""
    g = LAOLIN.splitlines(keepends=True)
    cl = w.read('sleep/soul-changelog.md')
    return {
        'memory/threads/A事.md': thread('A事', f'- {D1} 11:00 有进展（laolin 原话 11:00）\n'),
        'memory/story/2026-10.md': '# 2026-10\n## 第 3 周（10-19 – 10-25）\n- 这周 A 事有进展（laolin 原话 10-20）\n',
        'memory/midterm/self.md': '<!-- 写于 2026-10-21 03:00 -->\n# 这两天的我\n你把 A 事往前推了一步。\n',
        'memory/midterm/people.md': '<!-- 写于 2026-10-21 03:00 -->\n# 人物近况\n#### laolin\n- 10-20 11:00 说 A 事有进展\n',
        'soul/20-性格.md': '# 性格\n- 骄傲\n- 嘴硬心软\n',
        'sleep/soul-changelog.md': cl + f'- {D1} 「性格」 旧：（无）→ 新：嘴硬心软｜依据：laolin 10-20 原话｜整理者\n',
        'MEMORY.md': '# MEMORY\n## 规矩\n- 规矩一\n- 规矩二（laolin 10-20 原话）\n',
        'memory/laolin.md': ''.join(g[:4 + 4]),
        'memory/archive/laolin.md': f'# laolin.md 的归档\n## {D1}\n' + ''.join(g[4 + 4:]),
    }


def night2(w):
    """第二晚：事件线 B 有进展、中期重写（每晚重写，不算缩水）、人格说话方式加一条。"""
    cl = w.read('sleep/soul-changelog.md')
    return {
        'memory/threads/B事.md': thread('B事', f'- {D2} 09:30 有进展（laolin 原话 09:30）\n'),
        'memory/midterm/self.md': '<!-- 写于 2026-10-22 03:00 -->\n# 这两天的我\n你把 B 事也推了一步，A 事在等回音。\n',
        'memory/midterm/people.md': '<!-- 写于 2026-10-22 03:00 -->\n# 人物近况\n#### laolin\n- 10-21 09:30 说 B 事有进展\n',
        'soul/40-说话方式.md': SOUL40 + '- 他累的时候少说两句\n',
        'sleep/soul-changelog.md': cl + f'- {D2} 「说话方式」 旧：（无）→ 新：他累的时候少说两句｜依据：laolin 10-21 原话｜整理者\n',
    }


def assert_done(w, day):
    st = w.state()
    assert st['steps'][day]['done'] == 'done' and st['steps'][day]['finish'] == 'done', st['steps'][day]
    assert day in st['done'], st


def test_draft_two_nights():
    w = FakeWS('draft')
    try:
        assert w.pending() == [D1, D2]
        before = {r: w.read(r) for r in ('memory/laolin.md', 'soul/20-性格.md', 'SOUL.md', 'SOUL.lens-xiaohe.md', 'memory/recent.md')}
        rc, out = night(w, D1, night1)
        assert rc == 0, out
        assert_done(w, D1)
        assert w.pending() == [D2], '先做最早的那天，做完就轮到下一天'
        it = w.items(D1)
        assert it['memory/laolin.md']['action'] == 'defer' and it['memory/laolin.md']['guard'] == 'shrink', it['memory/laolin.md']
        assert it['SOUL.lens-xiaohe.md']['action'] == 'preview' and it['soul/20-性格.md']['action'] == 'apply'
        rc, out = night(w, D2, night2)
        assert rc == 0, out
        assert_done(w, D2)
        assert w.pending() == []
        assert {r: w.read(r) for r in before} == before, 'draft 不动原文件'
        subjects = w.git('log', '--format=%s').splitlines()
        assert f'睡眠整理 {D1}（draft）' in subjects and f'睡眠整理 {D2}（draft）' in subjects, subjects
        assert {f'day/{D1}', f'day/{D2}'} <= w.tags()
        assert w.dirty() == '', w.dirty()
    finally:
        w.cleanup()


def test_live_two_nights_guard_promote_rollback():
    w = FakeWS('live')
    try:
        assert w.pending() == [D1, D2]
        rc, out = night(w, D1, night1)
        assert rc == 0, out
        assert_done(w, D1)
        assert {f'day/{D1}', f'sleep/{D1}/memory', f'sleep/{D1}/soul'} <= w.tags(), w.tags()
        soul_files = w.git('show', '--name-only', '--format=', f'sleep/{D1}/soul').split()
        assert {'soul/20-性格.md', 'SOUL.md', 'SOUL.lens-xiaohe.md', 'sleep/soul-changelog.md'} <= set(soul_files), soul_files
        assert '嘴硬心软' in w.read('SOUL.lens-xiaohe.md') and '只属于你们俩的心思' not in w.read('SOUL.lens-xiaohe.md')
        mem_files = w.git('show', '--name-only', '--format=', f'sleep/{D1}/memory').split()
        assert {'memory/threads/A事.md', 'memory/story/2026-10.md', 'memory/recent.md'} <= set(mem_files), mem_files
        assert not any(f.endswith('input.md') for f in mem_files), '材料（原话）不进 git'
        assert w.dirty() == '', w.dirty()
        # 缩水保护（大压缩）：laolin.md 一晚挪走一大半，推迟，原文件不动
        assert w.read('memory/laolin.md') == LAOLIN
        assert w.items(D1)['memory/laolin.md']['guard'] == 'shrink'
        assert w.state()['steps'][D1]['guard_deferred'] == ['memory/laolin.md']
        # 收尾再跑一次：不出新提交
        head = w.git('rev-parse', 'HEAD')
        rc, out = w.sa('finish', D1)
        assert rc == 0 and w.git('rev-parse', 'HEAD') == head, out
        # 人看过：批准、放行
        assert w.sa('approve', D1, 'memory/laolin.md')[0] == 0
        rc, out = w.sa('promote', D1, 'memory/laolin.md')
        assert rc == 0, out
        assert w.read('memory/laolin.md') == w.read(f'sleep/{D1}/proposed/memory/laolin.md')
        assert f'sleep/{D1}/promote' in w.tags()
        assert w.git('show', '--name-only', '--format=', f'sleep/{D1}/promote').split()[0] == 'memory/laolin.md'
        applied = w.state()['last_applied_at']
        assert w.dirty() == '', w.dirty()
        # 回滚记忆：promote 和那一晚的记忆提交都倒回去，人格、进度不动
        time.sleep(1)
        rc, out = w.sa('rollback', D1, '--memory')
        assert rc == 0, out
        assert w.read('memory/laolin.md') == LAOLIN and w.read('memory/threads/A事.md') == thread('A事')
        assert not (w.ws / 'memory/story/2026-10.md').exists() and not (w.ws / 'memory/archive/laolin.md').exists()
        assert '嘴硬心软' in w.read('soul/20-性格.md'), '只回滚记忆'
        assert w.state()['last_applied_at'] > applied and D1 in w.state()['done']
        assert w.dirty() == '', w.dirty()
        # 第二晚接着来
        assert w.pending() == [D2]
        rc, out = night(w, D2, night2)
        assert rc == 0, out
        assert_done(w, D2)
        assert w.pending() == []
        assert {f'day/{D2}', f'sleep/{D2}/memory', f'sleep/{D2}/soul'} <= w.tags()
        # 中期是新建（第一晚的记忆提交回滚了）；每晚重写不算缩水的单测在 test_sleep_apply.py
        assert w.items(D2)['memory/midterm/self.md']['action'] in ('apply', 'create')
        assert '他累的时候少说两句' in w.read('SOUL.md') and '他累的时候少说两句' in w.read('SOUL.lens-xiaohe.md')
        assert 'SOUL.lens-xiaohe.md' in w.git('show', '--name-only', '--format=', f'sleep/{D2}/soul').split()
        assert w.dirty() == '', w.dirty()
        # 上一晚的工作目录、进度跟这一晚的记忆提交进了 git
        assert f'sleep/{D1}/apply.json' in w.git('ls-files', 'sleep').split()
        assert not [f for f in w.git('ls-files', 'sleep').split() if f.endswith('input.md')]
    finally:
        w.cleanup()


def main():
    t0 = time.time()
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
    print(f'{len(tests) - failed}/{len(tests)} 通过（{time.time() - t0:.0f} 秒）')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
