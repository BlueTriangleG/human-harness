#!/usr/bin/python3
"""A new English role's whole night, with the real scripts: the organizer's proposals follow the English general guide
(scripts/sleep_organize.md), and its step 10 commands are taken from that guide. Only the material is a stand-in (the
real digest reads the conversation store). What it shows: the English forms the guide has the organizer write, and the
ones the scripts write themselves, are read; nothing the scripts write or say is Chinese.

  python3 tests/test_sleep_e2e_en.py
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
from pathlib import Path

os.environ["HH_LANG"] = "en"          # before the scripts load their language files and forms
os.environ["HH_ME"] = "Wren"
HERE = Path(__file__).resolve().parents[1] / 'scripts'
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)

PY = sys.executable
REAL = ('night_names.py', 'sleep_apply.py', 'soul_build.py', 'midterm.py', 'memory_lint.py', 'ledger_snapshot.py', 'sleep_digest.py',
        'recall.py', 'redact.py')
D1 = '2026-10-20'
NOW = '2026-10-21T02:30:00+11:00'
CJK = re.compile(r'[　-〿㐀-鿿＀-￯]')


def guide_commands():
    """The English guide's step 10: the two previews and the check, as the organizer would run them."""
    step10 = (HERE / 'sleep_organize.md').read_text(encoding='utf-8').split('## Step 10', 1)[1]
    run = lambda c: re.sub(r'^night (\w+)', lambda m: f'{PY} scripts/{m.group(1)}.py', c)   # noqa: E731
    pre = [run(c) for c in re.findall(r'`(night (?:midterm|soul_build) --root [^`]+)`', step10)]
    lint = [run(c) for c in re.findall(r'`(night memory_lint <date> --report)`', step10)]
    assert len(pre) == 2 and len(lint) == 1, (pre, lint)
    return pre, lint[0] + ' --no-raw-db'


PREVIEW, LINT = guide_commands()


class EnglishRole:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='sleep-e2e-en-'))
        self.ws, self.home = self.tmp / 'ws', self.tmp / 'home'
        self.env = dict(os.environ, HH_WORKSPACE=str(self.ws), LEAK_GUARD_STATE=str(self.home / 'lg-state'))
        self.said = []
        for rel, text in {
            'AGENTS.md': '# AGENTS\n', 'IDENTITY.md': '# IDENTITY\n', 'USER.md': '# USER\n- laolin\n', 'MEMORY.md': '# MEMORY\n## Rules\n- rule one\n',
            'soul/20-character.md': '# Character\n- direct\n',
            'memory/people/registry.json': json.dumps({'laolin': {'name': 'laolin', 'privacy': 'owner'}}),
            'memory/open-loops.md': '# To do\n## In progress\n- [ ] book the hall | owner: me | basis: 10-19 #3\n## Done lately\n',
            'sleep/config.json': json.dumps({'mode': 'live', 'lint_mode': 'report'}),
            'sleep/state.json': json.dumps({'last_done': '2026-10-19'}),
            'sleep/soul-changelog.md': '',
            '.gitignore': 'sleep/.state.lock\nsleep/*/input.md\nledger/\n',
        }.items():
            self.write(rel, text)
        (self.ws / 'scripts').mkdir()
        for f in REAL:
            shutil.copy(HERE / f, self.ws / 'scripts' / f)
        hh_test_env.with_words(self.ws / 'scripts')
        shutil.copy(HERE / 'sleep_organize.md', self.ws / 'scripts' / 'sleep_organize.md')
        (self.home / 'Library/LaunchAgents').mkdir(parents=True)
        self.sh(PY, 'scripts/soul_build.py')
        self.sh(PY, 'scripts/midterm.py', 'build')
        for a in (('init', '-q'), ('config', 'user.name', 'test'), ('config', 'user.email', 'test@example.com'), ('add', '-A'), ('commit', '-qm', 'init')):
            self.git(*a)

    def write(self, rel, text):
        p = self.ws / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding='utf-8')

    def read(self, rel):
        return (self.ws / rel).read_text(encoding='utf-8')

    def sh(self, *args, ok=True):
        p = subprocess.run(args, cwd=self.ws, capture_output=True, text=True, env=self.env)
        assert not ok or p.returncode == 0, (args, p.stdout[-2000:], p.stderr[-2000:])
        self.said.append(p.stdout + p.stderr)
        return p

    def git(self, *args):
        return self.sh('git', '-c', 'core.quotepath=false', *args).stdout

    def sa(self, *args):
        p = self.sh(PY, 'scripts/sleep_apply.py', '--home', str(self.home), '--state-db', 'none', *args, ok=False)
        return p.returncode, p.stdout + p.stderr

    def guide(self, cmd):
        return self.sh(*shlex.split(cmd.replace('<date>', D1)))

    def digest(self):
        """Stand-in for the digest: the files' hashes at that moment, and the material, its line 2 as the digest writes it."""
        files = {}
        for top in ('memory', 'soul', 'skills'):
            for p in sorted((self.ws / top).rglob('*.md')) if (self.ws / top).is_dir() else []:
                files[p.relative_to(self.ws).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
        for rel in ('MEMORY.md', 'USER.md', 'SOUL.md'):
            files[rel] = hashlib.sha256((self.ws / rel).read_bytes()).hexdigest()
        self.write(f'sleep/{D1}/sources.json', json.dumps({'day': D1, 'generated_at': NOW, 'files': files}))
        self.write(f'sleep/{D1}/input.md', f'# Night material: {D1}\nMaterial: complete\n\n## 1. Conversations\n'
                   '[10-20 11:00] laolin: the hall is booked for Friday 7pm, it costs $40\n'
                   '[10-20 11:05] me: "great, I will bring the ropes"\n'
                   '[10-20 15:00] me: "I will check every knot twice"\n')


def proposals():
    """The night's proposals, written the way the English guide says."""
    return {
        'memory/midterm/self.md': '<!-- written 2026-10-21 03:00 -->\n# Me these two days\n'
                                  'Laolin booked the hall for Friday 7pm. I said "great, I will bring the ropes" at 11:05, '
                                  'and "I will check every knot twice" at 15:00.\n\n'
                                  'When I open my eyes tomorrow, what I most want to get on with is the ropes.\n',
        'memory/open-loops.md': '# To do\n## In progress\n- [ ] book the hall | owner: me | basis: 10-19 #3\n'
                                '- [ ] bring the ropes on Friday | owner: me | basis: 10-20 11:05\n## Done lately\n',
        'memory/story/2026-10.md': '# 2026-10\n\n## Week 3 (10-19 – 10-25)\n\n- 10-20: laolin booked the hall for Friday; it costs $40. '
                                   'Laolin is moving house soon.\n',
        'skills/General/climbing/SKILL.md': '---\nname: climbing\ndescription: how I do climbing things\n---\n# Climbing\n- knots.md: tying in\n',
        'skills/General/climbing/knots.md': '# Tying in\nSummary: how I tie in and check it.\nWhen to open: before a climb.\n\n'
                                            '## Practices\n- Tie a figure eight, then check it twice\n\n## Lessons\n'
                                            '- Lesson: did not check the knot | When: when tying in | Next time: check it twice | Days: 2026-10-20 | Sources: #12\n',
        'memory/bugs.md': '# Bugs\n- #0001 the phone tool times out | 2026-10-20 | HH\'s code | #15 | light\n\n'
                          '## Ask laolin\n- #0002 starting a process needs a permission | 2026-10-20 | HH\'s code | #16 | heavy\n',
        'soul/20-character.md': '# Character\n- direct\n- keeps a promise\n',
        'sleep/soul-changelog.md': f'- {D1} "character" before: (none) → after: keeps a promise | basis: laolin 10-20 11:00 | night\n',
    }


def test_english_night():
    w = EnglishRole()
    try:
        w.write(f'memory/{D1}.md', f'# {D1}\n- 09:00 Learned: [Ann] she runs the climbing club\n- 10:00 Taste: likes the new album\n')
        assert w.sh(PY, 'scripts/sleep_digest.py', 'pending', '--no-write', '--root', str(w.ws), '--now', NOW).stdout.split() == [D1]
        rc, out = w.sa('begin', D1)
        assert rc == 0, out
        assert w.git('log', '-1', '--format=%s', f'day/{D1}').startswith(f'Daytime {D1}: '), 'the day commit is English'
        w.digest()
        assert w.sa('step', D1, '0-digest')[0] == 0
        rc, out = w.sa('material', D1)
        assert out.splitlines()[0] == 'full', out                   # the English material line is read
        for rel, text in proposals().items():
            w.write(f'sleep/{D1}/proposed/{rel}', text)
        for cmd in PREVIEW:
            w.guide(cmd)
        w.write(f'sleep/{D1}/report.md', f'# Night report {D1}\n\n## Unsure\n\n- keywords: moving, house | whether laolin is moving | nothing in the records\n')
        assert w.sa('step', D1, '10-report')[0] == 0
        w.guide(LINT)
        report = w.read(f'sleep/{D1}/report.md')
        assert '<!-- lint:start -->' in report
        assert 'listed as "Unsure" in the report, but written as fact here' in report, report   # Unsure and keywords are read
        assert w.sa('step', D1, '10-lint')[0] == 0
        rc, out = w.sa('finish', D1)
        assert rc == 0, out
        assert 'did not check the knot' in out, 'the English lesson line is seen as a notebook entry (not through the check)'
        st = json.loads(w.read('sleep/state.json'))
        assert st['steps'][D1]['done'] == 'done' and D1 in st['done'], st['steps'][D1]
        subjects = w.git('log', '--format=%s').splitlines()
        assert any(s.startswith(f'Night consolidation {D1}: memory') for s in subjects), subjects
        assert any(s.startswith(f'Night consolidation {D1}: personality') for s in subjects), subjects
        assert w.read('skills/General/climbing/knots.md').startswith('# Tying in'), 'the notebook page was applied'
        assert 'keeps a promise' in w.read('SOUL.md')
        # waking: the snapshot reads the open loops' "In progress"
        w.sh(PY, 'scripts/ledger_snapshot.py')
        assert 'bring the ropes on Friday' in w.read('ledger/SOUL.md')
        recent = w.read('memory/recent.md')
        assert '(No thread has moved lately)' in recent and '(written 10-21)' in recent and '<!-- written' not in recent, recent   # the stamp is read
        # nothing the scripts wrote or said is Chinese
        for rel in ('SOUL.md', 'memory/recent.md', 'ledger/SOUL.md', f'sleep/{D1}/report.md', f'sleep/{D1}/apply.json', 'sleep/state.json'):
            assert not CJK.search(w.read(rel)), (rel, CJK.findall(w.read(rel))[:10])
        leaks = [l for out in w.said for l in out.splitlines() if CJK.search(l)]
        assert not leaks, leaks[:10]
        assert not CJK.search('\n'.join(subjects)), subjects
    finally:
        shutil.rmtree(w.tmp, ignore_errors=True)


if __name__ == '__main__':
    try:
        test_english_night()
        print('ok   test_english_night')
        print('1/1 passed')
    except Exception:
        import traceback
        traceback.print_exc()
        print('0/1 passed')
        sys.exit(1)
