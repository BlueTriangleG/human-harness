#!/usr/bin/python3
"""recall.py 参数的测试：不认缩写（访客会话里 leak-guard 只认写全的 --who）。参数错了 argparse 先退出，不会去查 Honcho。

  /usr/bin/python3 scripts/test_recall.py
"""
import subprocess
import sys
from pathlib import Path

import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
R = hh_test_env.SCRIPTS / 'recall.py'


def run(*args):
    return subprocess.run([sys.executable, str(R), *args], capture_output=True, text=True, timeout=30)


for args in (('search', 'x', '--who', 'xiaohe', '--wh', 'laolin'),
             ('search', 'x', '--who', 'xiaohe', '--w=laolin'),
             ('day', '2026-10-24', '--who', 'xiaohe', '--wh', 'laolin'),
             ('day', '2026-10-24', '--lim', '5')):
    r = run(*args)
    assert r.returncode == 2 and 'unrecognized arguments' in r.stderr, (args, r.returncode, r.stderr[-200:])
for sub in ('search', 'day', 'around'):
    r = run(sub, '--help')
    assert r.returncode == 0 and 'usage' in r.stdout, (sub, r.stderr)
assert '--who' in run('search', '--help').stdout
print('all ok')
