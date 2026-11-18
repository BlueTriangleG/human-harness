#!/usr/bin/python3
"""redact.py / redact.mjs 的测试：只用假密码。JS 那份用 node 跑同一批句子，输出必须和 Python 一字不差。"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
sys.path.insert(0, str(HERE))
import redact as R  # noqa: E402

M = R.MASK

# (原文, 期望)；期望为 None 表示不该改
CASES = [
    ('抖音密码是：Abc12345', '抖音密码是：' + M),
    ('密码 hunter22 别告诉别人', '密码 ' + M + ' 别告诉别人'),
    ('密码abc123，账号xyz', '密码' + M + '，账号xyz'),
    ('**密码**：fakePass99', '**密码**：' + M),
    ('验证码 482913', '验证码 ' + M),
    ('你的验证码为：4829，5分钟内有效', '你的验证码为：' + M + '，5分钟内有效'),
    ('PIN码 1234', 'PIN码 ' + M),
    ('pin: 1234', 'pin: ' + M),
    ('password: hunter2x', 'password: ' + M),
    ('password is hunter22', 'password is ' + M),
    ('my password hunter22', 'my password ' + M),
    ('"password": "hunter22",', '"password": "' + M + '",'),
    ('token=abcdefgh123', 'token=' + M),
    ('authtoken 2abcDEF123456789xyz', 'authtoken ' + M),
    ('client_secret=abcdefgh1234', 'client_secret=' + M),
    ('key: abcdefgh12', 'key: ' + M),
    ('api_key=sk-FAKEfakeFAKEfake1234567890', 'api_key=' + M),
    ('用这个 ghp_FAKEfakeFAKEfake1234567890ab 推', '用这个 ' + M + ' 推'),
    ('`TOKEN=fakefake99`', '`TOKEN=' + M + '`'),
    ('https://x.example/cb?token=abcdef123456&u=1', 'https://x.example/cb?token=' + M),
    ('第一行\n密码：fake9999\n第三行', '第一行\n密码：' + M + '\n第三行'),
    # 不该遮的
    ('现在你的token应该管够了', None),
    ('token 用完了', None),
    ('token 5000', None),
    ('5h token 32%', None),
    ('password reset link', None),
    ('密码错了', None),
    ('密码：（等下发你）', None),
    ('pin this message', None),
    ('pin 1234', None),
    ('key point', None),
    ('monkey: abcdefghij', None),
    ('secret santa', None),
    ('tokens: 123456789', None),
    ('密码 123', None),
    ('', None),
]


class T(unittest.TestCase):
    def test_cases(self):
        for src, want in CASES:
            got = R.redact(src)
            self.assertEqual(got, src if want is None else want, src)

    def test_idempotent(self):
        for src, _ in CASES:
            once = R.redact(src)
            self.assertEqual(R.redact(once), once, src)

    def test_no_secret_left(self):
        for src, want in CASES:
            if want is not None:
                for fake in ('Abc12345', 'hunter22', 'hunter2x', '482913', 'fake9999', 'abcdefgh123', 'FAKEfake'):
                    if fake in src:
                        self.assertNotIn(fake, R.redact(src), src)


if __name__ == '__main__':
    unittest.main()
