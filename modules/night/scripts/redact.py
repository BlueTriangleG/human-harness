#!/usr/bin/python3
"""打码：把「密码 / 验证码 / token」这类标签后面跟着的值遮住——标签留着，值换成［已打码］。

  from redact import redact        # redact(text) -> str，可以重复调用（打过的不会再变）
  redact.py < 文件                  # 打印打码后的文本（手动试用）

谁在用（2026-10-25 P0-6，凭证不再扩散）：sleep_digest.py 的材料、compact_guard.py 写的摘要和原始对话存档、
Honcho capture 补丁和 honcho_sync_replies.mjs（这两处用 scripts/redact.mjs，规则和这里一字不差，
scripts/test_redact.py 会拿同一批句子对比两边的输出）。

规则：
  - 标签后面可以隔「：: = 是 为 is」、引号、** 或空格，紧跟着的一串不含空格的 ASCII 就是值。
  - 中文标签（密码、验证码……）：空格或直接连写都算；英文标签（password、token……）：
    有「: = is」才一定算，只隔空格时，值要像密钥（字母数字混合，或者 12 位以上）才算。
  - pin、key 这种普通英文词：必须有「: =」才算。
  - 值太短的不算：密码、验证码类至少 4 位，token、密钥类至少 8 位。这样「token 用完了」「密码错了」
    「token 5000」「password reset」都不会被遮。
  - 一眼能认出的密钥（sk-…、ghp_…、github_pat_…、xox?-…、AKIA…、AIza…）不管有没有标签，整串遮掉。
不遮没有标签的裸密码（分不清是密码还是别的编号）；那种情况靠发的人自己改密码。
正则只用 Python 和 JS 写法一致的语法（不用 \\b：两边对中文的「词边界」理解不同）。
"""
import re
import sys

MASK = '［已打码］'

# (标签正则, 值最短几位, 种类)  种类：zh 中文标签；en 英文标签；weak 普通英文词（必须有 : 或 =）
LABELS = [
    ('密码', 4, 'zh'), ('口令', 4, 'zh'), ('验证码', 4, 'zh'), ('校验码', 4, 'zh'), ('动态码', 4, 'zh'),
    ('短信码', 4, 'zh'), ('pin码', 4, 'zh'), ('密钥', 8, 'zh'), ('秘钥', 8, 'zh'), ('令牌', 8, 'zh'),
    ('passphrase', 4, 'en'), ('password', 4, 'en'), ('passwd', 4, 'en'), ('passcode', 4, 'en'),
    ('api[_ -]?key', 8, 'en'), ('access[_ -]?key', 8, 'en'), ('private[_ -]?key', 8, 'en'),
    ('secret', 8, 'en'), ('token', 8, 'en'),
    ('(?<![A-Za-z0-9_])pin(?![A-Za-z0-9_])', 4, 'weak'), ('(?<![A-Za-z0-9_])key(?![A-Za-z0-9_])', 8, 'weak'),
]
IS = '(?<![A-Za-z])is(?![A-Za-z])'
QUOTE = '["\'“”‘’]?'
SEP = ('(\\s*[*_]*\\s*' + QUOTE + '\\s*(?:(?:[:：=＝]|是|为|' + IS + ')\\s*){0,2}[*_]*\\s*' + QUOTE + '\\s*)')
VALUE = '([!-~]+)'
TRAIL = '"\'“”‘’,.;:!?)]}>`*'
EXPLICIT = re.compile('[:：=＝]|是|为|' + IS, re.I)
KNOWN = re.compile('sk-[A-Za-z0-9_\\-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
                   '|xox[abprs]-[A-Za-z0-9\\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\\-]{35}')
PATTERN = re.compile('(' + '|'.join(l for l, _, _ in LABELS) + ')' + SEP + VALUE, re.I)
_RULES = [(re.compile('^(?:' + l + ')$', re.I), n, kind) for l, n, kind in LABELS]


def _rule(label):
    for rx, n, kind in _RULES:
        if rx.match(label):
            return n, kind
    return 8, 'en'


def _looks_secret(v):
    return bool(re.search('[A-Za-z]', v) and re.search('[0-9]', v)) or len(v) >= 12


def _sub(m):
    label, sep, val = m.group(1), m.group(2), m.group(3)
    core = val.rstrip(TRAIL)
    tail = val[len(core):]
    n, kind = _rule(label)
    explicit = bool(EXPLICIT.search(sep))
    if len(core) < n:
        return m.group(0)
    if kind == 'weak' and not explicit:
        return m.group(0)
    if kind == 'en' and not explicit and not _looks_secret(core):
        return m.group(0)
    return label + sep + MASK + tail


def redact(text):
    if not text:
        return text
    text = KNOWN.sub(MASK, text)
    return PATTERN.sub(_sub, text)


if __name__ == '__main__':
    sys.stdout.write(redact(sys.stdin.read()))
