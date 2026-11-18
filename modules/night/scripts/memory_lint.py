#!/usr/bin/python3
"""睡眠整理的机械核对（P0-8，不用大模型；主人 2026-10-25 批准，先只报告）。

  memory_lint.py <日期> [--report] [--all] [--base-rev REV] [--no-raw-db] [--root WS] [--day-dir DIR]

查 sleep/<日期>/proposed/ 里整理者的提案（有 sunday-merge/ 也查，单独报告），对照原文件
（--base-rev 时用那个 git 提交里的版本当原文件）：

一、事实行（只查改动过的行；--all 查全部）
   常驻的事实行：事件线的一句话 / 简述 / 现在的状态，这两天的我、人物近况、<主人>.md、story、soul/80、人物档案。
   从每行抽出日期、时间、带单位的数字、人名、「引文」，必须能在出处里找到：
     - 事件线摘要：先找这条的「经过」；只在「因果」或材料 / 原始记录 / 账本里有的记 ⚠️；哪都没有（或只在
       整理者自己写的 meta、摘要、「现在的状态」里）记 ❌。
     - 其他文件：材料（input.md）和原始记录（压缩存档、每日笔记、日记、她的生活、事件线「经过」、会话记录）
       里有就过；只在账本（<主人>.md、人物档案、待办、时间轴……）里有记 ⚠️；哪都没有记 ❌。
     - 今晚新加进「经过」的行，自己也要在材料 / 原始记录里找得到。
   另外两项：
     - 引文说话人：写成「X 说/问「…」」的引文，原话里必须是 X 说的（对不上：长引文或 主人/访客/她 记 ❌，
       短引文且对方没有原始记录记 ⚠️）。
     - 保留语气：出处全是「应是 / 转述 / 可能……」这种推测，这里却写成了事实，记 ⚠️。
二、不变量
   1. 「经过」只增不减（按集合比，顺序不管）；今晚不许加出重复行。
   2. 常驻文件里删掉的每一行，都要在 archive、某条「经过」或别的文件里找得到。
   3. 报告「拿不准」里的事，别处不能写成事实（看「关键词：A、B」；没写关键词就用里面的「引文」）。
   4. 说话方式里「好的和坏的」那段：提案和原文件 hash 一样、只出现一次；白天被改了也提醒。
   5. 改了核心人格块，soul-changelog 里要有新的一行写到这块；快照块（70/75/80、30 的口味快照）只报告。
   6. 事件线没有新「经过」，就不许改一句话 / 简述 / 现在的状态。
   7. story 里已经过完的周不许改，只能在末尾追加「更正 MM-DD：…」。
   8. 文件大小和数量由脚本算（写在报告里）。
2 期（人物迁进事件库；开关 = memory/archive/retired-20261103/<主人>.md 在，和 ledger_snapshot、midterm、HH 的守卫同一个）：
   账本里的人物文件（<主人>.md、us.md、人物档案……退役名单 RETIRED_PEOPLE）换成 hhd 导出的 ledger/people/*.md（卡和 near.md）；
   人名表 = registry + 卡的「# 名字」+ near.md 的人名；人物近况读 ledger/people/near.md（不再读 midterm/people.md）；
   退役文件不按常驻文件查删行（是迁移挪走的）。开关没开时一切照旧。
结果：--report 时写 <日期>/lint.json，并把摘要写到 report.md 最上面（<!-- lint:start --> … <!-- lint:end -->，
重跑会替换）。只报告：有问题也退出 0；脚本自己出错才退出 1。
"""
import argparse
import bisect
import datetime as dt
import os
import difflib
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import unicodedata
from pathlib import Path

from night_names import (ME, OWNER, OWNER_ALIASES, RETIRED_FILES, TRANSCRIPT_PEOPLE, GENDERS, COMMON_WORDS,  # noqa: E402
                         owner_key, retired_flag)

from hh_env import forms, words  # noqa: E402

say = words(__file__)
form = forms(__file__)

WS_DEFAULT = Path(os.environ.get('HH_WORKSPACE') or Path(__file__).resolve().parent.parent)  # the tests run the scripts from a copied workspace's scripts/
CONFIG = json.loads(os.environ.get('HH_MODULE_CONFIG') or '{}')
# the old agent platform's records, for a role that had one before HH (config legacyAgentDb); none = there is no such file
AGENT_DB = Path(CONFIG.get('legacyAgentDb') or Path(os.environ['HH_STATE_DIR']) / 'no-legacy-agent.sqlite')
HH_DB = Path(os.environ['HH_STATE_DIR']) / 'hh.db'   # 10-29 切到 HH 以后的原始记录（中央记忆）
HH_DAYS_BEFORE = 10                       # 往前带几天：人物档案常引前几天的话（11-03：前一天的原话找不到，报了 9 处误报）
HH_RESULT_CAP = 4000                      # 工具结果只取开头这么多字（读到的群聊、评论都在开头）
ZSTD = '/opt/homebrew/bin/zstd'

PREVIEWS = {'SOUL.md', 'SOUL.memory.md', 'memory/recent.md'}
LENS_RE = re.compile(r'SOUL\.lens-[^/\\]+\.md')   # 访客镜头：soul_build.py 拼的预览（同 sleep_apply.py）
LIST_CAP = 8                      # 报告里每个文件最多列几条（全部在 lint.json）

# 2 期（人物迁进事件库）：迁移那天这 11 个文件挪进 memory/archive/retired-20261103/<memory/ 下的相对路径>（计划 P9）
OWNER_KEY = owner_key(WS_DEFAULT)
RETIRED_FLAG = retired_flag(OWNER_KEY)
RETIRED_PEOPLE = RETIRED_FILES
PEOPLE_DIR = 'ledger/people/'              # hhd 导出的人物卡（# 名字、一行注释、## 字段）和 near.md
PEOPLE_NEAR = 'ledger/people/near.md'      # 人物近况（hhd 从事件库现算）
PEOPLE_OLD = 'memory/midterm/people.md'    # 迁移前夜里写的人物近况


def retired_active(ws):
    """2 期的新行为开没开：memory/archive/retired-20261103/<主人>.md 在不在（迁移那天才挪进去）。"""
    return (Path(ws) / RETIRED_FLAG).exists()

# ---------- 文本小工具 ----------

# The rules that read the role's language (forms.<lang>.json): what hedges, a quote, a pronoun and where a word ends
PRON = form('pronouns')                                 # me (I, you: the role), he, she, they
THIRD = (*PRON['he'], *PRON['she'], *PRON['they'])
EDGE = form('wordEdge')                                 # around a pronoun or a name: "" in Chinese, \b in English
MONTHS = form('lintMonths')                             # a month written as a word, for a date in words
OWN = form('ownWords')                                  # 「（… 原话）」 after a quote: whose own words it is
HEDGE_RE = re.compile(form('lintHedge'))
META_RE = re.compile(r'<!--.*?-->', re.S)
QUOTE_RE = re.compile(form('lintQuote'))
LIST_MARK = re.compile(r'^\s*(?:[-*+]|\d+[.、)])\s+')


def nfkc(s):
    return unicodedata.normalize('NFKC', s or '')


def norm_line(s):
    """比较行用：去列表符号、合并空白。"""
    s = nfkc(s).strip()
    s = LIST_MARK.sub('', s)
    return re.sub(r'\s+', ' ', s).strip()


def norm_c(s):
    """查找用：只留字母、数字、汉字，小写。"""
    return re.sub(r'[\W_]+', '', nfkc(s).lower())


def strip_quotes(s):
    return QUOTE_RE.sub('「」', s)


SUPERSEDED_RE = re.compile('|'.join(form.every('superseded')))   # 以前 X → 现在 Y, before X → now Y


def asserted(l):
    """「以前 X → 现在 Y（依据）」这种冲突写法里，X 是被取代的旧说法（故意引出来的），只核箭头后面的 Y。"""
    m = SUPERSEDED_RE.search(l or '')
    return (l[:m.start()] + l[m.end():]) if m else l


def hedged(s):
    return bool(HEDGE_RE.search(strip_quotes(s)))


def is_heading(l):
    return l.lstrip().startswith('#')


def is_skippable(l):
    t = l.strip()
    return (not t or t.startswith('#') or t.startswith('<!--') or t.startswith('|---') or t.startswith('---')
            or re.fullmatch(r'[|:\- ]+', t) is not None)


def sections(lines, level=2):
    """按 `## ` 分节：[(标题, 起始行号(含标题), 结束行号(不含))]；文件开头那段标题为 ''。"""
    mark = '#' * level + ' '
    out, cur, start = [], '', 0
    for i, l in enumerate(lines):
        if l.startswith(mark):
            out.append((cur, start, i))
            cur, start = l[len(mark):].strip(), i
    out.append((cur, start, len(lines)))
    return out


def sections_any(lines):
    """按 2–4 级标题分节（人物近况里的人名可能写成 `#### 名字`）。"""
    out, cur, start = [], '', 0
    for i, l in enumerate(lines):
        m = re.match(r'^#{2,4} (.+)', l)
        if m:
            out.append((cur, start, i))
            cur, start = m.group(1).strip(), i
    out.append((cur, start, len(lines)))
    return out


def section_of(secs, i):
    for t, s, e in secs:
        if s <= i < e:
            return t
    return ''


def find_sec(secs, *names):
    for t, s, e in secs:
        if any(t.startswith(n) for n in names):
            return t, s, e
    return None


def sec_lines(lines, sec):
    if not sec:
        return []
    _, s, e = sec
    return [(i, lines[i]) for i in range(s + 1, e)]


def sha(s):
    return hashlib.sha256((s or '').encode('utf-8')).hexdigest()


# ---------- 抽原子：日期、时间、带单位的数字、人名、引文 ----------

UNIT_NUM = form('lintUnits')
MONEY = form('lintMoney')
DATE_STOP = form('lintDateStop')
D_FULL = re.compile(r'(?<!\d)(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?!\d)')
D_MD_CN = re.compile(form('lintDateWords'))   # a date in words: 10月24日, Oct 24
D_MD = re.compile(r'(?<![\d\-:./])(\d{1,2})-(\d{1,2})(?![\d\-:])(?!\s?(?:' + DATE_STOP + r'|%|k|K|w))')
T_SEC = re.compile(r'(?<![\d:])([01]?\d|2[0-3]):([0-5]\d):[0-5]\d(?![\d:])')
T_FULL = re.compile(r'(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])')
T_PRE = re.compile(r'(?<![\d:])([01]?\d|2[0-3]):([0-5])[xX×](?![\dA-Za-z])')
N_MONEY1 = re.compile(r'(?:A\$|AU\$|AUD\s?|US\$|USD\s?|\$|＄)\s?(\d+(?:[.,]\d+)*)')
N_MONEY2 = re.compile(r'(\d+(?:\.\d+)?)\s?(?:' + MONEY + ')')
N_PCT = re.compile(r'(\d+(?:\.\d+)?)\s?[%％]')
N_ORD = re.compile(form('lintOrdinal'))
N_WAN = re.compile(form('lintLarge'))
WEEK_LABEL = re.compile(form('lintWeekLabel'))
N_UNIT = re.compile(r'(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(' + UNIT_NUM + r')(?![A-Za-z])')
LABEL_REF = re.compile(form('lintLabelRef'))
CODEISH = re.compile(r'`[^`]*`|https?://\S+|\b[\w./-]+\.(?:md|py|js|json|png|jpg|ogg|wav|mp4|txt|plist)\b|BV[0-9A-Za-z]{6,}|'
                     r'\b[0-9a-f]{7,40}\b|[A-Za-z]+\d+(?:[.-]\d+)*|v\d+(?:\.\d+)*|\d+x\d+|\+?\d{9,}')


def _num(v):
    v = v.replace(',', '')
    try:
        f = float(v)
    except ValueError:
        return v
    return str(int(f)) if f == int(f) else str(f)


def month_num(s):
    return int(s) if s.isdigit() else MONTHS.index(s[:3].lower()) + 1


def pron_count(text, kind):
    return sum(len(re.findall(EDGE + re.escape(w) + EDGE, text, re.I)) for w in PRON[kind])


def extract(line, names=()):
    """一行里的原子：[(种类, 键, 原文)]。种类：date / time / timepre / num / name / quote。"""
    out = []
    raw = META_RE.sub('', nfkc(line))
    for q in QUOTE_RE.finditer(raw):
        body = q.group(1) or q.group(2)
        if LABEL_REF.search(raw[max(0, q.start() - 14):q.start()]):
            continue                       # 「budget.py 的『该用到多少』」「目标 g3『…』」是引用文件里的标签，不是谁说的话
        frags = [f for f in (norm_c(x) for x in re.split(r'…+|\.{3,}|⋯', body)) if len(f) >= 2]
        if frags:
            out.append(('quote', tuple(frags), body))
    s = QUOTE_RE.sub(' ', raw)          # 引文里的数字算引文，不再单独查
    s = re.sub(form('lintBookkeeping'), ' ', s)   # 「（10-24 睡眠整理挪来）」是整理者记的账
    s = re.sub(form('lintWindowName'), ' ', s)                # 「7 天窗口」「5小时窗口」是名字
    s = CODEISH.sub(' ', s)
    s = WEEK_LABEL.sub(' ', s)         # 「第 3 周（10-12 – 10-18）」是整理者分的周，不是事实
    taken = []

    def take(m):
        taken.append(m.span())

    def free(m):
        a, b = m.span()
        return all(b <= x or a >= y for x, y in taken)

    for m in D_FULL.finditer(s):
        mo, d = int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            out.append(('date', f'{mo:02d}-{d:02d}', m.group(0)))
            take(m)
    for m in D_MD_CN.finditer(s):
        mo, d = month_num(m.group(1)), int(m.group(2))
        if free(m) and 1 <= mo <= 12 and 1 <= d <= 31:
            out.append(('date', f'{mo:02d}-{d:02d}', m.group(0)))
            take(m)
    for m in D_MD.finditer(s):
        mo, d = int(m.group(1)), int(m.group(2))
        if free(m) and 1 <= mo <= 12 and 1 <= d <= 31:
            out.append(('date', f'{mo:02d}-{d:02d}', m.group(0)))
            take(m)
    for m in T_SEC.finditer(s):
        if free(m):
            out.append(('time', f'{int(m.group(1)):02d}:{m.group(2)}', m.group(0)))
            take(m)
    for m in T_FULL.finditer(s):
        if free(m):
            out.append(('time', f'{int(m.group(1)):02d}:{m.group(2)}', m.group(0)))
            take(m)
    for m in T_PRE.finditer(s):
        if free(m):
            out.append(('timepre', f'{int(m.group(1)):02d}:{m.group(2)}', m.group(0)))
            take(m)
    for rx, unit in ((N_MONEY1, '$'), (N_MONEY2, '$'), (N_PCT, '%')):
        for m in rx.finditer(s):
            if free(m):
                out.append(('num', _num(m.group(1)) + unit, m.group(0).strip()))
                take(m)
    for m in N_ORD.finditer(s):
        if free(m):
            out.append(('num', _num(m.group(1)) + m.group(2), m.group(0)))
            take(m)
    for m in N_WAN.finditer(s):
        if free(m):
            out.append(('num', _num(m.group(1)) + m.group(2), m.group(0)))
            take(m)
    for m in N_UNIT.finditer(s):
        if free(m):
            u = m.group(2)
            u = 'token' if u.startswith('token') else u
            u = re.sub('s$', '', u.lower()) if form('lintUnitsPlural') else u   # English: 3 hours and 3 hour are one
            out.append(('num', _num(m.group(1)) + u, m.group(0)))
            take(m)
    low = s.lower()
    seen = set()
    for canon, aliases in names:
        if canon in (OWNER_KEY, ME):
            continue
        for a in aliases:
            if len(a) >= 2 and a.lower() in low and canon not in seen:
                out.append(('name', canon, a))
                seen.add(canon)
                break
    return out


def support_keys(line, names=()):
    """出处行的索引键（时间顺带加上「HH:M」前缀，给 22:4x 这种写法用）。"""
    keys = set()
    for kind, key, _ in extract(line, names):
        if kind == 'quote':
            continue
        keys.add((kind, key))
        if kind == 'time':
            keys.add(('timepre', key[:4]))
    return keys


# ---------- 出处语料 ----------

class Corpus:
    """一份出处：行列表（带行号、说话人），按键建索引，另有拼好的规整文本做子串查找。"""

    def __init__(self, name, tier, lines, names=()):
        self.name, self.tier = name, tier
        self.lines = lines                      # [(行号, 原文, 说话人或 None)]
        self._names = names
        self._idx = None
        self._norm = None

    def index(self):
        if self._idx is None:
            idx = {}
            for i, (_, text, _) in enumerate(self.lines):
                for k in support_keys(text, self._names):
                    idx.setdefault(k, []).append(i)
            self._idx = idx
        return self._idx

    def norm(self):
        if self._norm is None:
            parts, starts, pos = [], [], 0
            for _, text, _ in self.lines:
                n = norm_c(META_RE.sub('', text))
                starts.append(pos)
                parts.append(n)
                pos += len(n) + 1
            self._norm = ('\x00'.join(parts), starts)
        return self._norm

    def find_key(self, key):
        return [self.lines[i] for i in self.index().get(key, [])]

    def find_text(self, frags, limit=50):
        """所有片段都在同一行里出现的行。"""
        text, starts = self.norm()
        first = max(frags, key=len)
        hits, pos = [], 0
        while len(hits) < limit:
            p = text.find(first, pos)
            if p < 0:
                break
            i = bisect.bisect_right(starts, p) - 1
            ln = self.lines[i]
            n = norm_c(META_RE.sub('', ln[1]))
            if all(f in n for f in frags):
                hits.append(ln)
            pos = (starts[i + 1] if i + 1 < len(starts) else len(text))
        return hits

    def contains_text(self, n):
        return n in self.norm()[0]


def find_atom(atom, corpora):
    kind, key, _ = atom
    for c in corpora:
        hits = c.find_text(key) if kind == 'quote' else c.find_key((kind, key))
        if hits:
            return c, hits
    return None, []


# ---------- 读原文件 ----------

class Base:
    """原文件：默认读工作区现在的文件；--base-rev 时读那个提交里的版本。"""

    def __init__(self, ws, rev=None):
        self.ws, self.rev = Path(ws), rev
        self._ls = None

    def read(self, rel):
        if self.rev:
            r = subprocess.run(['git', '-C', str(self.ws), 'show', f'{self.rev}:{rel}'], capture_output=True)
            return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None
        p = self.ws / rel
        return p.read_text(encoding='utf-8', errors='replace') if p.is_file() else None

    def list(self, prefix, suffix='.md'):
        if self.rev:
            if self._ls is None:
                r = subprocess.run(['git', '-C', str(self.ws), 'ls-tree', '-r', '--name-only', '-z', self.rev],
                                   capture_output=True)
                self._ls = [x for x in r.stdout.decode('utf-8', 'replace').split('\x00') if x]
            return sorted(x for x in self._ls if x.startswith(prefix) and x.endswith(suffix))
        base = self.ws / prefix
        if base.is_file():
            return [prefix]
        if not base.is_dir():
            return []
        return sorted(str(p.relative_to(self.ws)) for p in base.rglob('*' + suffix) if p.is_file())

    def committed(self, rel):
        """白天改动对照用：git 里已提交的版本（--base-rev 时就是那个提交）。"""
        r = subprocess.run(['git', '-C', str(self.ws), 'show', f'{self.rev or "HEAD"}:{rel}'], capture_output=True)
        return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None


# ---------- 人名表 ----------

def card_names(base):
    """2 期：hhd 导出的人物卡 ledger/people/*.md 各自的「# 名字」（near.md 的「# 人物近况」不是人名）。"""
    out = []
    for rel in base.list(PEOPLE_DIR):
        if rel == PEOPLE_NEAR:
            continue
        head = next((l for l in (base.read(rel) or '').splitlines() if l.startswith('# ')), None)
        if head and head[2:].strip():
            out.append(head[2:].strip())
    return out


def build_names(ws, people_texts, people_files=(), card_names=()):
    """[(规范名, [别名…])]：registry + 人物档案文件名 + 人物近况（people.md / near.md）的二到四级标题
    + 人物卡的「# 名字」（2 期）。"""
    names = {OWNER_KEY: {OWNER_KEY, OWNER, *OWNER_ALIASES}, **{n: {n, k} for k, n in TRANSCRIPT_PEOPLE.items()}, ME: {ME}}
    try:
        reg = json.loads((Path(ws) / 'memory/people/registry.json').read_text(encoding='utf-8'))
        for k, v in reg.items():
            if isinstance(v, dict) and v.get('name'):
                names.setdefault(v['name'], set()).update({v['name'], k})
    except (OSError, ValueError):
        pass
    for rel in people_files:
        stem = Path(rel).stem.split('-')[0]
        if not any(stem.lower() in {x.lower() for x in a} for a in names.values()):
            names.setdefault(stem, set()).add(stem)
    for name in card_names:
        n = re.split(r'[（(\s]', name.strip(), 1)[0].strip()
        if n:
            canon = next((c for c, a in names.items() if n.lower() in {x.lower() for x in a}), n)
            names.setdefault(canon, set()).add(n)
    for t in people_texts:
        for l in (t or '').splitlines():
            hm = re.match(r'^#{2,4} (.+)', l)
            if hm:
                n = re.split(r'[（(\s]', hm.group(1).strip(), 1)[0].strip()
                if n and not re.search(r'\d', n):
                    canon = next((c for c, a in names.items() if n.lower() in {x.lower() for x in a}), n)
                    names.setdefault(canon, set()).add(n)
    return [(c, sorted(a, key=len, reverse=True)) for c, a in names.items()]


def gender_guess(people_texts, names):
    """人物近况里每个人那一节用「他」多还是「她」多：猜性别（主人 男、访客女）。"""
    g = dict(GENDERS)
    for t in people_texts:
        lines = (t or '').splitlines()
        for title, s_, e in sections(lines):
            if not title:
                continue
            who = canon_of(names, re.split(r'[（(\s]', title, 1)[0])
            if who in g:
                continue
            body = '\n'.join(lines[s_ + 1:e])
            he, she = pron_count(body, 'he'), pron_count(body, 'she')
            if he != she:
                g[who] = 'm' if he > she else 'f'
    return g


def canon_of(names, token):
    t = (token or '').lower()
    for c, al in names:
        if t in {a.lower() for a in al}:
            return c
    return token


# ---------- 原始记录（说话人） ----------

# a system line: HH's heads in every language (lintSystemHeads), the platforms' own
SYS_PREFIX = re.compile(r'^\s*(' + '|'.join(map(re.escape, form.every("lintSystemHeads"))) + r'|System:|\[Queued|\[Subagent|\[cron|\[Inter-session)')
CONV_RE = re.compile(r'^\[(\d\d-\d\d)(?: (\d\d:\d\d))?\]\s?([^：:\]]{1,24})[：:]\s?(.*)$')


def speaker_label(lbl, text, names):
    lbl = lbl.strip()
    if lbl in (ME, *form.every('lintSelfLabels')):
        return ME
    if lbl in form.every('lintUserLabels'):
        return '系统' if SYS_PREFIX.search(text) else OWNER_KEY
    return canon_of(names, lbl)


def conv_lines(text, names, only_after=None):
    """「[MM-DD HH:MM] 说话人：话」这种行 → [(行号, 原文, 说话人)]；其余行说话人为 None。"""
    out = []
    on = only_after is None
    for i, l in enumerate((text or '').splitlines()):
        if not on:
            if l.startswith(only_after):
                on = True
            out.append((i + 1, l, None))
            continue
        m = CONV_RE.match(l)
        out.append((i + 1, l, speaker_label(m.group(3), m.group(4), names) if m else None))
    return out


def transcript_corpus(ws, names):
    """会话记录（只读打开 agent 数据库）：主人 和访客的会话里，用户说的话和她说的话。"""
    try:
        reg = json.loads((Path(ws) / 'memory/people/registry.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    owner = {}
    for k, v in reg.items():
        if isinstance(v, dict):
            for sk in v.get('sessionKeys', []):
                owner[sk] = v.get('name', k)
    if not owner or not AGENT_DB.exists():
        return None
    con = sqlite3.connect(f'file:{AGENT_DB}?mode=ro', uri=True)
    try:
        q = ('select w.session_key, e.created_at, e.event_json, e.event_zstd, e.event_utf8_bytes '
             'from transcript_events e join session_windows w on w.session_id = e.session_id '
             f'where w.session_key in ({",".join("?" * len(owner))}) order by e.created_at')
        rows = con.execute(q, list(owner)).fetchall()
    finally:
        con.close()
    blobs = [r[3] for r in rows if r[2] is None and r[3] is not None]
    dec = b''
    if blobs and Path(ZSTD).exists():
        try:
            dec = subprocess.run([ZSTD, '-d', '-c', '-q'], input=b''.join(blobs), capture_output=True,
                                 timeout=120).stdout
        except (OSError, subprocess.SubprocessError):
            dec = b''
    lines, off = [], 0
    for sk, ts, js, z, n in rows:
        if js is None:
            if z is None or not dec:
                continue
            js = dec[off:off + n].decode('utf-8', 'replace')
            off += n
        if '"message"' not in js:
            continue
        try:
            ev = json.loads(js)
        except ValueError:
            continue
        m = ev.get('message') if isinstance(ev, dict) else None
        if ev.get('type') != 'message' or not isinstance(m, dict) or m.get('role') not in ('user', 'assistant'):
            continue
        c = m.get('content')
        if isinstance(c, list):
            c = '\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
        if not isinstance(c, str) or not c.strip():
            continue
        t = dt.datetime.fromtimestamp(ts / 1000).strftime('%m-%d %H:%M')
        if m['role'] == 'assistant':
            who = ME
        else:
            who = '系统' if SYS_PREFIX.search(c) else owner[sk]
        for part in c.splitlines():
            if part.strip():
                lines.append((len(lines) + 1, f'[{t}] {who}：{part}', who))
    return Corpus(say("lintCorpusTranscript"), 'raw', lines, names) if lines else None


class QuoteCorpus(Corpus):
    """只给引文核对用的出处：日期、时间、数字、人名不在这里找（工具结果里什么数字都有，会把真错放过去）。"""

    def index(self):
        return {}


def hh_corpus(day, names, db=None):
    """HH 中央记忆：别人说的、她说的和做的、工具读到的（不含思考），只读打开；只核引文（QuoteCorpus）。
    说话人：外界的真人消息记来源的人，感官和提醒记「系统」，她说的话（say / note）记「她」，动作和工具结果不标。"""
    db = Path(db or HH_DB)
    try:
        d = dt.date.fromisoformat(day)
    except (TypeError, ValueError):
        return None
    if not db.exists():
        return None
    start = dt.datetime.combine(d - dt.timedelta(days=HH_DAYS_BEFORE), dt.time())
    end = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(12))
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        try:
            rows = con.execute("select src, kind, text, meta from central where ts >= ? and ts < ? "
                               "and kind in ('input', 'say', 'note', 'act', 'result') order by seq",
                               (int(start.timestamp() * 1000), int(end.timestamp() * 1000))).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    lines = []
    for src, kind, text, meta in rows:
        who = None
        if kind == 'result':
            text = (text or '')[:HH_RESULT_CAP]
        elif src == '外界':
            try:
                m = json.loads(meta or '{}')
            except ValueError:
                m = {}
            who = canon_of(names, str(m.get('from') or '')) if m.get('human') else '系统'
        elif kind in ('say', 'note'):
            who = ME
        for part in (text or '').splitlines():
            if part.strip():
                lines.append((len(lines) + 1, part, who))
    return QuoteCorpus(say("lintCorpusCentral"), 'raw', lines, names) if lines else None


def thread_jg(text):
    """事件线的「经过」节（[(行号, 原文)]，行号从 1 起）。"""
    lines = (text or '').splitlines()
    sec = find_sec(sections(lines), '经过')
    return [(i + 1, l) for i, l in sec_lines(lines, sec)] if sec else []


def build_corpora(ws, base, day_dir, names, raw_db, day=None):
    """出处分三层：材料（input.md）、原始记录、账本。"""
    ws = Path(ws)
    inp = (Path(day_dir) / 'input.md')
    input_c = Corpus('input.md', 'input',
                     conv_lines(inp.read_text(encoding='utf-8', errors='replace') if inp.exists() else '', names), names)
    raw = []
    for rel in base.list('memory/compactions/'):
        lines = conv_lines(base.read(rel), names, only_after='## 原始对话')
        st = re.search(r'(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)', rel)
        if st:                             # 「依据 18:03 压缩摘要」说的就是 2026-10-24-1803.md 这个文件
            lines.insert(0, (0, f'{st.group(2)}-{st.group(3)} {st.group(4)}:{st.group(5)} 压缩摘要 {rel}', None))
        raw.append(Corpus(rel, 'raw', lines, names))
    daily = [r for r in base.list('memory/') if re.fullmatch(r'memory/20\d\d-\d\d-\d\d[^/]*\.md', r)]
    for rel in daily + base.list('memory/my-life.md') + base.list('memory/diary/') + base.list('memory/life/'):
        raw.append(Corpus(rel, 'raw', conv_lines(base.read(rel), names), names))
    jg_lines, yg_lines = [], []
    for rel in base.list('memory/threads/'):
        t = base.read(rel) or ''
        lines = t.splitlines()
        secs = sections(lines)
        for title, s, e in secs:
            for i in range(s + 1, e):
                if title.startswith('经过'):
                    jg_lines.append((i + 1, f'{rel}:{lines[i]}', None))
                elif title.startswith('因果'):
                    yg_lines.append((i + 1, f'{rel}:{lines[i]}', None))
    raw.append(Corpus(say("lintCorpusThreadLog"), 'raw', jg_lines, names))
    if raw_db:
        tc = transcript_corpus(ws, names)
        if tc:
            raw.append(tc)
        hc = hh_corpus(day, names)
        if hc:
            raw.append(hc)
    ledger = [Corpus(say("lintCorpusThreadCauses"), 'ledger', yg_lines, names)]
    rels = ([f'memory/{OWNER_KEY}.md', 'memory/open-loops.md', 'memory/timeline.md', 'memory/us.md', 'memory/followups.md',
             f'memory/{OWNER_KEY}-interests.md', 'memory/lessons.md', 'MEMORY.md', 'USER.md']
            + base.list('memory/people/') + base.list('memory/midterm/') + base.list('memory/story/')
            + base.list('soul/'))
    if retired_active(ws):            # 2 期：人物文件退役了（又冒出来的是帮手误写的，在材料 3b 里），换成 hhd 导出的卡和 near.md
        rels = [r for r in rels if r not in RETIRED_PEOPLE] + base.list(PEOPLE_DIR)
    for rel in rels:
        t = base.read(rel)
        if t:
            ledger.append(Corpus(rel, 'ledger', conv_lines(t, names), names))
    return input_c, raw, ledger


# ---------- 提案 ----------

def kind_of(rel):
    if rel.startswith('memory/threads/'):
        return 'thread'
    if rel in ('memory/midterm/self.md', 'memory/midterm/people.md', f'memory/{OWNER_KEY}.md') or \
            rel.startswith('memory/story/') or re.fullmatch(r'soul/80-[^/]*\.md', rel):
        return 'fact'
    if rel.startswith('memory/people/'):
        return 'fact'
    return 'other'


RESIDENT_RM = re.compile(rf'^(memory/{re.escape(OWNER_KEY)}\.md|memory/people/[^/]+\.md|MEMORY\.md|USER\.md|soul/[^/]+\.md|'
                         r'memory/open-loops\.md|memory/lessons\.md|memory/us\.md|memory/timeline\.md|'
                         r'memory/life/taste\.md|memory/life/interests\.md|skills/.+\.md)$')


def resident_rm(rel, active=False):
    """删行要有去处的常驻文件（RESIDENT_RM）；2 期生效后（active）退役的人物文件不算：是迁移挪走的，不是夜里删的。"""
    return bool(RESIDENT_RM.match(rel)) and not (active and rel in RETIRED_PEOPLE)


SNAP_RE = re.compile(r'<!--\s*注入[:：]\s*快照\s*-->')
GOODBAD = '#### 好的和坏的'

# 笔记本（主人 11-01 学习系统：手册拆成 skills/<大类>/<本>/<页>.md，教训搬进页里）
LESSONS_REL = 'memory/lessons.md'
MAP_REL = 'skills/MAP.md'
MOVED_RE = re.compile(r'^搬家完成[：:]\s*\S')       # skills/MAP.md 最后一行写了它，就是搬完了（搬家指南最后一步）
LESSON_ID = re.compile(r'<!-- (l:\d{4,}(?:\s+l:\d{4,})*) -->')   # HH 发的教训编号，一个注释里可以有几个（同 sleep_apply.py）
PAGE_LESSON = re.compile(r'^[-*]\s+(?:' + '|'.join(map(re.escape, form.every('noteLesson'))) + r')[：:]')        # HH 读页时认的教训行（HH 的 notebook.ts）
NOT_PAGES = ('SKILL.md', 'CHANGELOG.md', 'MAP.md')    # 不是页


def loops_open(text):
    """open-loops.md's section of what is in progress (## 进行中, ## In progress), up to the next ## heading."""
    head = next((h for h in ('## ' + w for w in form.every('loopsOpen')) if h in text), None)
    return text.split(head, 1)[-1].split('\n## ', 1)[0] if head else ''


def page_lessons(rel, text):
    """HH 读页时认的教训行（照 sleep_apply.py 的 page_ids）：「## 教训」下面行首的 - 教训：，代码块里的不算；
    SKILL.md、CHANGELOG.md、MAP.md 不是页。返回 [(行号, 那一行)]。"""
    if rel.rsplit('/', 1)[-1] in NOT_PAGES:
        return []
    out, section, fence = [], '', False
    for i, l in enumerate(text.lstrip('\ufeff').splitlines()):
        if re.match(r'^\s*(```|~~~)', l):
            fence = not fence
        elif fence or l.startswith('### '):
            continue
        elif l.startswith('## '):
            section = l[3:].strip()
        elif section in form.every('noteLessons') and PAGE_LESSON.match(l):
            out.append((i + 1, l))
    return out


def lesson_ids(rel, text):
    """这一页教训行上的编号（l:0039 这样，带前缀）。"""
    return {x for _, l in page_lessons(rel, text or '') for m in LESSON_ID.finditer(l) for x in m.group(1).split()}


CHANGELOG = 'sleep/soul-changelog.md'
OLD_CHANGELOG = 'memory/sleep/soul-changelog.md'   # 10-25 搬家前的位置（旧草稿、写错地方的提案）


def base_changelog(base):
    t = base.read(CHANGELOG)
    return (t if t is not None else base.read(OLD_CHANGELOG)) or ''


def prop_changelog(props, default):
    """今晚的 changelog 提案（写在老地方的也认，sleep_apply.py 照样追加进 sleep/ 那份）。"""
    return props.get(CHANGELOG, props.get(OLD_CHANGELOG, default))


def load_proposals(root):
    out = {}
    if not root.is_dir():
        return out
    for p in sorted(root.rglob('*.md')):
        rel = str(p.relative_to(root))
        if rel in PREVIEWS or LENS_RE.fullmatch(rel):
            continue
        out[rel] = p.read_text(encoding='utf-8', errors='replace')
    return out


# ---------- 检查 ----------

# ---------- 按 memory/layout.json 自查用的小工具 ----------

LAYOUT_REL = 'memory/layout.json'
LAYOUT_TYPES = ('设定', '总结', '原话', '详情', '快照')
TYPE_MARK = re.compile(r'^\s*<!--\s*类型\s*[:：]\s*(\S+?)\s*-->\s*$')
DETAIL_SHORT_CHARS = 120          # 14 天以上的详情还长过这个：该缩成一句概括了
DETAIL_TITLE_CHARS = 60           # 60 天以上的详情还长过这个：该只剩标题和日期了
IMPORTANCE_RE = re.compile(r'〔([0-9])〕')   # soul/80「记得的事」条目的重要度（主人 10-29）


def heading_key(line):
    """「### 你的世界：你是…（补充）」→「你的世界：你是…」：去掉 #，再去掉第一个（ 及后面的。"""
    t = line.strip().lstrip('#').strip()
    return re.split(r'[（(]', t, maxsplit=1)[0].strip()


def layout_sections(lines):
    """所有标题（kept-words、地图这种整个文件就是一段的，段标题是一级）：每个带层级、标题键、下一行的类型标记、到哪一行为止（下一个同级或更高级的标题）。
    文件大标题没在配置里时不用标记：只有和配置里的段同一级的标题才要求带类型，更深的小标题跟着上一级那段走。"""
    heads = []
    for i, l in enumerate(lines):
        m = re.match(r'^(#{1,6})\s+\S', l)
        if m:
            heads.append((i, len(m.group(1))))
    out = []
    for k, (i, lv) in enumerate(heads):
        end = next((j for j, lv2 in heads[k + 1:] if lv2 <= lv), len(lines))
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        m = TYPE_MARK.match(nxt)
        out.append({'line': i, 'level': lv, 'key': heading_key(lines[i]), 'mark': m.group(1) if m else None, 'end': end})
    return out


def section_body(lines, s):
    """一段的正文（不含标题和类型标记行），算字数和比较用。"""
    return '\n'.join(l for l in lines[s['line'] + 1:s['end']] if not TYPE_MARK.match(l))


def line_date(line, today):
    m = D_FULL.search(line)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    m = D_MD.search(line) or D_MD_CN.search(line)
    if m:
        try:
            d = dt.date(today.year, month_num(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
        return d.replace(year=d.year - 1) if d > today + dt.timedelta(days=1) else d
    return None


class Lint:
    def __init__(self, ws, day, day_dir, base, check_all=False, raw_db=True, now=None):
        self.ws, self.day, self.dir, self.base = Path(ws), day, Path(day_dir), base
        self.now = now or dt.datetime.now()
        try:                               # 她的一天到第二天凌晨 4 点，所以第二天的日期也算「今天」
            self.day_end = (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()[5:10]
        except ValueError:
            self.day_end = day[5:10]
        self.check_all, self.raw_db = check_all, raw_db
        self.issues = []
        self.stats = {'atoms': {}, 'thread_summary': {'checked': 0, 'error': 0, 'warn': 0, 'by_kind': {}},
                      'jg_new_lines': 0}
        self.sizes = []
        # 2 期：开关开了，人物近况是 hhd 导出的 near.md（不再是夜里写的 midterm/people.md）
        self.active = retired_active(self.ws)
        self.people_rel = PEOPLE_NEAR if self.active else PEOPLE_OLD

    # 记一条
    def add(self, sev, check, rel, line, msg, atom=None, area='proposed'):
        self.issues.append({'sev': sev, 'check': check, 'file': rel, 'line': line, 'atom': atom, 'msg': msg,
                            'area': area})

    def run(self):
        P = load_proposals(self.dir / 'proposed')
        S = load_proposals(self.dir / 'sunday-merge')
        self.P, self.S = P, S
        bases = {rel: self.base.read(rel) for rel in set(P) | set(S)}
        self.bases = bases
        ptexts = [P.get(self.people_rel), S.get(self.people_rel), self.base.read(self.people_rel)]
        if self.active:                    # 2 期：名单 = registry + 人物卡的「# 名字」（+ near.md 的人名），不看 memory/people 的文件名
            self.names = build_names(self.ws, ptexts, (), card_names(self.base))
        else:
            self.names = build_names(self.ws, ptexts, self.base.list('memory/people/'))
        self.gender = gender_guess(ptexts, self.names)
        self.input_c, self.raw, self.ledger = build_corpora(self.ws, self.base, self.dir, self.names, self.raw_db, self.day)
        self.report_text = (self.dir / 'report.md').read_text(encoding='utf-8', errors='replace') \
            if (self.dir / 'report.md').exists() else ''
        for area, props in (('proposed', P), ('sunday-merge', S)):
            if not props and area != 'proposed':
                continue
            self.area = area
            self.props = props
            for rel in sorted(props):
                self.check_facts(rel, props[rel], bases.get(rel))
            self.inv_jg(props)
            self.inv_removed(props)
            self.inv_unsure(props)
            self.inv_goodbad(props)
            self.inv_changelog(props)
            self.inv_summary_rewrite(props)
            self.inv_story(props)
            self.inv_lessons(props)
            self.inv_recent_owner(props)
            if area == 'proposed':
                self.inv_written_at(props)
                self.inv_self_voice(props)
                self.inv_layout(props)
                self.inv_events(props)
                self.compute_sizes(props)
        self.goodbad_daytime()
        self.inv_delete()
        if not P and not S:
            self.add('info', 'none', '', None, say("lintNoProposals"))
        return self

    # ----- 一、事实行 -----

    def target_lines(self, rel, text, base):
        lines = text.splitlines()
        base_set = {norm_line(l) for l in (base or '').splitlines()}
        secs = sections_any(lines) if rel == self.people_rel else sections(lines)
        k = kind_of(rel)
        out = []
        for i, l in enumerate(lines):
            if is_skippable(l) or re.match(r'^\s*(?:[-*]\s*)?[（(]?(?:最后更新|更新于|' + '|'.join(map(re.escape, form.every('stampWord'))) + r')', l):
                continue                                   # 「最后更新：…」是记账的时间戳，不是事实
            title = section_of(secs, i)
            if k == 'thread':
                if not any(title.startswith(x) for x in ('一句话', '简述', '现在的状态')):
                    continue
            elif k == 'fact':
                if '规则' in title:
                    continue
            else:
                continue
            if self.check_all or norm_line(l) not in base_set:
                out.append((i, l, title))
        return out

    def subject_of(self, rel, title):
        """「他 / 她」默认指谁：人物近况看小节，人物档案看文件，<主人>.md 是 主人。"""
        if rel == self.people_rel and title:
            return canon_of(self.names, re.split(r'[（(\s]', title, 1)[0])
        if rel.startswith('memory/people/'):
            stem = Path(rel).stem.split('-')[0]
            return canon_of(self.names, stem)
        if rel == f'memory/{OWNER_KEY}.md':
            return OWNER_KEY
        return None

    def check_facts(self, rel, text, base):
        k = kind_of(rel)
        lines = text.splitlines()
        if k == 'thread':
            secs = sections(lines)
            jg = [(i + 1, l, None) for i, l in sec_lines(lines, find_sec(secs, '经过'))]
            yg = [(i + 1, l, None) for i, l in sec_lines(lines, find_sec(secs, '因果'))]
            byg = []
            if base:
                bl = base.splitlines()
                bsecs = sections(bl)
                byg = [(i + 1, l, None) for i, l in sec_lines(bl, find_sec(bsecs, '因果'))]
                byg += [(i + 1, l, None) for i, l in sec_lines(bl, find_sec(bsecs, '现在的状态'))]
            own_jg = Corpus(rel + ' 经过', 'own', jg, self.names)
            own_yg = Corpus(rel + ' 因果', 'own_yg', yg + byg, self.names)
            for i, l, title in self.target_lines(rel, text, base):
                summ = title.startswith('一句话') or title.startswith('简述')
                l = asserted(l)
                for atom in extract(l, self.names):
                    self.fact_atom(rel, i, l, atom, [own_jg], [own_yg], summary=summ)
                self.speaker_check(rel, i, l, title)
            self.check_new_jg(rel, text, base)
            self.meta_check(rel, text, base)
        elif k == 'fact':
            for i, l, title in self.target_lines(rel, text, base):
                l = asserted(l)
                for atom in extract(l, self.names):
                    self.fact_atom(rel, i, l, atom, [], [], summary=False)
                self.speaker_check(rel, i, l, title)
                self.hedge_check(rel, i, l)

    def bump(self, kind, sev):
        a = self.stats['atoms'].setdefault(kind, {'checked': 0, 'error': 0, 'warn': 0})
        a['checked'] += 1
        if sev:
            a[sev] += 1

    def fact_atom(self, rel, i, l, atom, own, own_yg, summary):
        kind, key, raw = atom
        tiers = [('own', own), ('own_yg', own_yg), ('input', [self.input_c]), ('raw', self.raw),
                 ('ledger', self.ledger)]
        found = None
        for tier, cs in tiers:
            c, hits = find_atom(atom, cs)
            if c:
                found = (tier, c)
                break
        thread = kind_of(rel) == 'thread'
        sev, msg = None, None
        if not found:
            sev = 'error'
            msg = (say("lintNotInLogOrMaterial") if thread else say("lintNowhere"))
        elif thread and found[0] != 'own':
            sev = 'warn'
            msg = {'own_yg': say("lintOnlyInCauses"), 'input': say("lintAddToLog"),
                   'raw': say("lintInRaw", name=found[1].name),
                   'ledger': say("lintOnlyInLedger", name=found[1].name)}[found[0]]
        elif not thread and found[0] == 'ledger':
            sev = 'warn'
            msg = say("lintRawMissingLedger", name=found[1].name)
        self.bump(kind, sev)
        if thread and summary and kind in ('date', 'time', 'timepre', 'num'):
            ts = self.stats['thread_summary']
            ts['checked'] += 1
            bk = ts['by_kind'].setdefault(kind, {'checked': 0, 'error': 0, 'warn': 0})
            bk['checked'] += 1
            if sev:
                ts[sev] += 1
                bk[sev] += 1
        if sev:
            disp = raw if kind != 'quote' else say("lintExcerpt", raw=raw[:40])
            self.add(sev, 'fact', rel, i + 1, msg, disp, self.area)

    def check_new_jg(self, rel, text, base):
        """今晚新加进「经过」的行：自己也要在材料 / 原始记录里找得到。"""
        if not base:
            return
        base_all = {norm_line(l) for l in base.splitlines()}
        for ln, l in thread_jg(text):
            if is_skippable(l) or norm_line(l) in base_all:
                continue
            self.stats['jg_new_lines'] += 1
            for atom in extract(asserted(l), self.names):
                tiers = [('input', [self.input_c]), ('raw', self.raw), ('ledger', [c for c in self.ledger])]
                found = None
                for tier, cs in tiers:
                    c, _ = find_atom(atom, cs)
                    if c:
                        found = (tier, c)
                        break
                kind = atom[0]
                if not found:
                    self.add('error', 'fact-jg', rel, ln, say("lintNewLogNowhere"),
                             atom[2] if kind != 'quote' else say("lintExcerptAtom", atom=atom[2][:40]), self.area)
                elif found[0] == 'ledger':
                    self.add('warn', 'fact-jg', rel, ln, say("lintNewLogLedgerOnly", name=found[1].name),
                             atom[2] if kind != 'quote' else say("lintExcerptAtom", atom=atom[2][:40]), self.area)
            self.speaker_check(rel, ln - 1, l, '经过')

    # 引文说话人
    VERB = form('lintVerb')
    ADV = form('lintAdv')

    def _tok(self):
        if getattr(self, '_tokre', None) is None:
            alts = sorted({re.escape(a) for c, al in self.names for a in al if len(a) >= 2}, key=len, reverse=True)
            self._alts = alts
            self._tokre = re.compile(EDGE + r'(' + '|'.join(alts + [re.escape(p) for p in (*THIRD, *PRON['me'])]) + r')' + EDGE, re.I)
        return self._tokre

    def gender_ok(self, who, pron):
        g = self.gender.get(who)
        return not g or pron.lower() in PRON['they'] or (pron.lower() in PRON['he']) == (g == 'm')

    def line_topic(self, l):
        """行首「小红书 TeaAddict：」这种：冒号前面出现的人名就是这一行说的人。"""
        t = LIST_MARK.sub('', META_RE.sub('', l))
        t = re.sub(r'^\s*(?:\*\*)?(?:20\d\d-)?\d{1,2}-\d{1,2}(?:\s*[\d:x～~–-]+)*\s*', '', t)
        m = re.match(form('lintTopicHead'), t)
        if not m:
            return None
        head = m.group(1).lower()
        best = None
        for c, al in self.names:
            for a_ in al:
                if len(a_) >= 2:
                    p_ = head.rfind(a_.lower())
                    if p_ >= 0 and (best is None or p_ > best[1]):
                        best = (c, p_)
        return best[0] if best else None

    def attribute(self, rel, l, start, end, title):
        """这句引文是谁说的：引文前面紧挨着「X 说 / 问 / 回……」或「X：」，或者后面跟着「（… 原话）」。认不出就不管。"""
        tok = self._tok()
        w = l[max(0, start - 30):start]
        cut = max(w.rfind(x) for x in form('lintClauseEnds'))
        w = w[cut + 1:] if cut >= 0 else w
        cand = None
        for m in tok.finditer(w):
            t = m.group(1)
            pron = t.lower() in (*THIRD, *PRON['me'])
            pre = w[m.start() - 1] if m.start() > 0 else ''
            if pron and pre and pre not in form('lintSubjectAfter') and not pre.isdigit():
                continue                                   # 「给你」「让她」这种是宾语
            rest = w[m.end():]
            gap = r'\s?(?:[（(][^）)]{0,16}[）)])?\s?'
            if re.match(gap + self.ADV + self.VERB + form('lintVerbTail'), rest, re.I) or \
                    re.match(gap + r'[：:]\s?$', rest):
                cand = (t, m.start())
        if not cand:
            after = l[end:end + 30]                        # 紧跟在引文后面的「（… 原话）」；「（依据 …）」是整行的出处，不算
            m = re.match(r'^\s?[（(](?!\s*' + form('lintSourceWord') + r')\s*(' + '|'.join(self._alts) + '|' + '|'.join(THIRD) + r')?[^）)]{0,16}' + OWN, after, re.I)
            if m:
                cand = (m.group(1) or OWN, None)
        if not cand:
            return None
        t, pos = cand
        if t.lower() in PRON['me']:
            return ME
        if t.lower() in THIRD or t == OWN:
            pron = t if t != OWN else None
            subj = self.subject_of(rel, title)
            if subj and (not pron or self.gender_ok(subj, pron)):
                return subj
            if not pron:
                return None
            topic = self.line_topic(l)
            if topic and topic != ME and (not pron or self.gender_ok(topic, pron)):
                return topic
            if pron:
                before = l[:start]
                last = None
                for c, al in self.names:
                    if c == ME or not self.gender_ok(c, pron):
                        continue
                    for a in al:
                        if len(a) >= 2:
                            p_ = before.lower().rfind(a.lower())
                            if p_ >= 0 and (last is None or p_ > last[1]):
                                last = (c, p_)
                if last:
                    return last[0]
            return None
        return canon_of(self.names, t)

    def speaker_lines(self, frags, limit=200):
        out = []
        for c in [self.input_c] + self.raw:
            for ln in c.find_text(frags, limit=limit):
                if ln[2]:
                    out.append((c.name, ln))
        return out

    def speaker_check(self, rel, i, l, title):
        for m in QUOTE_RE.finditer(l):
            body = m.group(1) or m.group(2)
            frags = tuple(f for f in (norm_c(x) for x in re.split(r'…+|\.{3,}|⋯', body)) if len(f) >= 2)
            n = sum(len(f) for f in frags)
            if not frags or n < 3:
                continue
            who = self.attribute(rel, l, m.start(), m.end(), title)
            if not who:
                continue
            hits = self.speaker_lines(frags)
            spk = {h[1][2] for h in hits} - {'系统'}      # 系统唤醒里转述的第三方的话，不算谁说的
            if not hits:
                if any(c.find_text(frags, limit=1) for c in [self.input_c] + self.raw):
                    continue                                  # 原始记录里有（没标说话人），没法核说话人
                if any(c.find_text(frags, limit=1) for c in self.ledger):
                    self.add('warn', 'speaker', rel, i + 1, say("lintSpeakerLedgerOnly", who=who),
                             say("lintExcerptBody", body=body[:40]), self.area)
                continue
            if not spk or who in spk:
                continue
            covered = who in (OWNER_KEY, *TRANSCRIPT_PEOPLE.values(), ME)
            sev = 'error' if (n >= 6 or covered) else 'warn'
            where = say("lintSemicolon").join(f'{h[0]}:{h[1][0]} {h[1][2]}' for h in hits if h[1][2] != '系统')
            self.add(sev, 'speaker', rel, i + 1,
                     say("lintWrongSpeaker", who=who, speakers=say("lintListSep").join(sorted(spk)), where=where[:160]), say("lintExcerptBody", body=body[:40]), self.area)
        self.claim_check(rel, i, l, title)

    CLAIM_RE = re.compile(form('lintClaim'))

    def claim_check(self, rel, i, l, title):
        """「（她说）」「（访客说）」：这一行的数字、英文型号、引文，要在这个人自己的原话里找得到。"""
        for m in self.CLAIM_RE.finditer(l):
            t = m.group(1)
            who = self.subject_of(rel, title) if t.lower() in THIRD else canon_of(self.names, t)
            if who not in (OWNER_KEY, *TRANSCRIPT_PEOPLE.values()):
                continue                                       # 只有这两个人有完整的原始对话
            mine = []
            for c in [self.input_c] + self.raw:
                mine += [x for x in c.lines if x[2] == who]
            if not mine:
                continue
            blob = norm_c('\x00'.join(x[1] for x in mine))
            text = l[:m.start()]
            seg = re.split(form('lintSentenceEnd'), text)[-1]                # 只看括号前面这一句
            miss = []
            for w in re.findall(form('lintNameTokensClaim'), CODEISH.sub(' ', seg)):
                if w.lower() not in COMMON_EN and norm_c(w) not in blob:
                    miss.append(w)
            for num in re.findall(r'\d+(?:\.\d+)?', re.sub(r'\d{1,2}[-:]\d{2}|20\d\d-\d\d-\d\d', ' ', seg)):
                if len(num) >= 2 and num not in blob:
                    miss.append(num)
            for q in QUOTE_RE.finditer(seg):
                fr = [f for f in (norm_c(x) for x in re.split(r'…+|\.{3,}|⋯', q.group(1) or q.group(2))) if len(f) >= 2]
                if fr and not all(f in blob for f in fr):
                    miss.append(say("lintExcerptA", a=(q.group(1) or q.group(2))[:20]))
            if miss:
                self.add('warn', 'claim', rel, i + 1, say("lintClaimMissing", who=who), say("lintListSep").join(miss)[:60], self.area)

    def meta_check(self, rel, text, base):
        """事件线 meta 的「开始」「最近进展」：日期和时间要在「经过」里；最近进展不能比经过最新一行旧或新。"""
        m = re.search(r'<!--\s*事件线\s+(.*?)-->', text)
        if not m:
            return
        if base and m.group(0) in base and not self.check_all:
            return
        meta = dict(re.findall(r'(\S+?)=(20\d\d-\d\d-\d\d(?: \d\d:\d\d)?)', m.group(1)))
        lines = text.splitlines()
        secs = sections(lines)
        jg = [(i + 1, l, None) for i, l in sec_lines(lines, find_sec(secs, '经过'))]
        own = Corpus(rel + ' 经过', 'own', jg, self.names)
        others = [('own_yg', [Corpus(say("lintOtherSections", rel=rel), 'own_yg',
                                     [(i + 1, l, None) for i, l in enumerate((base or '').splitlines())], self.names)]),
                  ('input', [self.input_c]), ('raw', self.raw), ('ledger', self.ledger)]
        ln = next(i for i, l in enumerate(lines) if m.group(0) in l) + 1 if any(m.group(0) in l for l in lines) else None
        st = self.stats.setdefault('thread_meta', {'checked': 0, 'error': 0, 'warn': 0})
        for key in ('开始', '最近进展'):
            v = meta.get(key)
            if not v:
                continue
            atoms = [('date', v[5:10], v[:10])]
            if len(v) > 10:
                atoms.append(('time', v[11:16], v[11:16]))
            for a in atoms:
                st['checked'] += 1
                if find_atom(a, [own])[0]:
                    continue
                where = None
                for tier, cs in others:
                    c, _ = find_atom(a, cs)
                    if c:
                        where = (tier, c.name)
                        break
                if where:
                    st['warn'] += 1
                    self.add('warn', 'meta', rel, ln, say("lintMetaNotInLog", field=key, where=where[1]), a[2], self.area)
                else:
                    st['error'] += 1
                    self.add('error', 'meta', rel, ln, say("lintMetaNowhere", field=key), a[2], self.area)
        last = meta.get('最近进展')
        if last:
            dates = []                                    # 每行开头那个日期才是这件事发生的日子；不算以后的日子
            for _, l, _ in jg:
                mm = re.match(r'^\s*(?:[-*]\s*)?(?:\*\*)?(?:20\d\d-)?(\d{1,2})-(\d{1,2})(?!\d)', l)
                if mm:
                    key = f'{int(mm.group(1)):02d}-{int(mm.group(2)):02d}'
                    if key <= self.day_end or self.day[5:7] == '01' and key[:2] == '12':
                        dates.append(key)
            if dates:
                newest = max(dates)
                if last[5:10] < newest:
                    self.add('warn', 'meta', rel, ln, say("lintMetaOlder", last=last[5:10], newest=newest), last[:10], self.area)
                elif last[5:10] > newest:
                    inother = find_atom(('date', last[5:10], last[:10]), others[0][1])[0]
                    self.add('warn' if inother else 'error', 'meta', rel, ln,
                             say("lintMetaNewer", last=last[5:10], newest=newest, why=say("lintMetaElsewhere") if inother else say("lintMetaNotLogged")), last[:10], self.area)

    def hedge_check(self, rel, i, l):
        """出处全是推测 / 转述，这一行却没有保留语气。"""
        if hedged(l):
            return
        for atom in extract(l, self.names):
            kind, key, raw = atom
            if kind not in ('quote', 'num'):
                continue
            hits = []
            for c in [self.input_c] + self.raw + self.ledger:
                hs = c.find_text(key) if kind == 'quote' else c.find_key((kind, key))
                hits += hs
            if len(hits) >= 1 and all(hedged(h[1]) for h in hits):
                self.add('warn', 'hedge', rel, i + 1, say("lintHedgedAll", count=len(hits)),
                         raw if kind != 'quote' else say("lintExcerpt", raw=raw[:40]), self.area)
        # 型号、店名这类英文词：出处里带着「应是 / 转述」，这里也要带
        for w in set(re.findall(form('lintNameTokens'), META_RE.sub('', l))):
            if w.lower() in COMMON_EN:
                continue
            n = norm_c(w)
            hits = []
            for c in [self.input_c] + self.raw + self.ledger:
                hits += c.find_text((n,), limit=30)
            if len(hits) >= 1 and all(hedged(h[1]) for h in hits):
                self.add('warn', 'hedge', rel, i + 1, say("lintHedgedAll2", count=len(hits)), w, self.area)

    # ----- 二、不变量 -----

    def inv_jg(self, props):
        for rel, text in props.items():
            if kind_of(rel) != 'thread':
                continue
            base = self.bases.get(rel)
            new = [norm_line(l) for _, l in thread_jg(text) if not is_skippable(l)]
            newset = set(new)
            newc = norm_c('\x00'.join(new))
            if base:
                old = [norm_line(l) for _, l in thread_jg(base) if not is_skippable(l)]
                for ln, l in thread_jg(base):
                    if is_skippable(l):
                        continue
                    nl = norm_line(l)
                    if nl in newset or (len(norm_c(nl)) >= 4 and norm_c(nl) in newc):
                        continue
                    self.add('error', 'inv-jg', rel, None, say("lintLogLineLost", ln=ln), nl[:60], self.area)
                from collections import Counter
                oc, nc = Counter(old), Counter(new)
                for nl, k in nc.items():
                    if k > 1 and k > oc.get(nl, 0):
                        self.add('error', 'inv-jg-dup', rel, None, say("lintLogDupTonight", k=k), nl[:60], self.area)
            else:
                from collections import Counter
                for nl, k in Counter(new).items():
                    if k > 1:
                        self.add('error', 'inv-jg-dup', rel, None, say("lintLogDup", k=k), nl[:60], self.area)

    def inv_delete(self):
        """delete.txt 里要删的文件：每一行都要在别的经过、archive 或提案里找得到（删了不丢）。"""
        dl = self.dir / 'delete.txt'
        self.area, self.props = 'proposed', self.P
        if dl.exists():
            dels = [x.split('#', 1)[0].strip() for x in dl.read_text(encoding='utf-8').splitlines()]
            dels = [x for x in dels if x]
            pool = self.pool_text(exclude=dels)
            for rel in dels:
                t = self.base.read(rel)
                if t is None:
                    continue
                for ln, l in (thread_jg(t) if rel.startswith('memory/threads/') else
                              [(i + 1, x) for i, x in enumerate(t.splitlines())]):
                    if is_skippable(l) or len(norm_c(l)) < 4:
                        continue
                    if norm_c(norm_line(l)) not in pool:
                        self.add('error', 'inv-delete', rel, ln, say("lintDeleteLost"), norm_line(l)[:60], self.area)

    def pool_text(self, exclude=()):
        """「挪去哪了」的查找池：所有 archive、所有经过、所有提案和别的原文件（不含要删的文件本身）。"""
        key = (self.area, tuple(sorted(exclude)))
        cache = self.__dict__.setdefault('_pools', {})
        if key not in cache:
            parts = []
            for rel, t in self.props.items():
                parts.append(t)
            for rel in self.base.list('memory/archive/') + [r for r in self.base.list('memory/life/') if 'archive' in r]:
                parts.append(self.base.read(rel) or '')
            for rel in self.base.list('memory/threads/'):
                if rel not in exclude:
                    parts.append('\n'.join(l for _, l in thread_jg(self.base.read(rel) or '')))
            others = (self.base.list('skills/') + self.base.list('soul/') + self.base.list('memory/')
                      + ['MEMORY.md', 'USER.md', 'AGENTS.md', 'IDENTITY.md', 'TOOLS.md'])
            for rel in others:
                if rel in self.props or rel in exclude or rel.startswith('memory/sleep/') or rel.startswith('memory/threads/'):
                    continue
                parts.append(self.base.read(rel) or '')
            cache[key] = norm_c('\x00'.join(parts))
        return cache[key]

    def inv_removed(self, props):
        pool = None
        for rel, text in props.items():
            if not resident_rm(rel, self.active) or 'archive' in rel:
                continue
            base = self.bases.get(rel)
            if not base:
                continue
            snap = bool(SNAP_RE.search(base))
            bl = base.splitlines()
            secs = sections(bl)
            newset = {norm_line(l) for l in text.splitlines()}
            for i, l in enumerate(bl):
                if is_skippable(l):
                    continue
                title = section_of(secs, i)
                if (snap and title.startswith('快照')) or title.startswith('最近的口味和兴趣'):
                    continue
                nl = norm_line(l)
                if nl in newset or len(norm_c(nl)) < 4 or re.fullmatch(r'[（(]?暂无[）)]?', nl):
                    continue
                if re.fullmatch(r'[（(].*[）)]', nl) and re.search(r'睡眠整理|维护|占位|还没有|暂无|待写|自动生成|快照放不下', nl):
                    continue                                   # 模板里的说明文字
                if pool is None:
                    pool = self.pool_text()
                n = norm_c(nl)
                if n in pool:
                    continue
                if rel.startswith('soul/') and any(n[:12] in norm_c(x) for x in self.changelog_new()):
                    continue                                   # 人格块改写：changelog 的「旧：」里记了原文
                best = max((difflib.SequenceMatcher(None, n, norm_c(x)).ratio() for x in text.splitlines()
                            if x.strip() and abs(len(norm_c(x)) - len(n)) < max(40, len(n))), default=0)
                if best >= 0.6:
                    self.add('warn', 'inv-removed', rel, None, say("lintRewritten", ln=i + 1),
                             nl[:60], self.area)
                else:
                    self.add('error', 'inv-removed', rel, None, say("lintRemovedLost", ln=i + 1),
                             nl[:60], self.area)

    def changelog_new(self):
        base = {norm_line(l) for l in base_changelog(self.base).splitlines()}
        return [l for l in prop_changelog(self.props, '').splitlines() if l.strip() and norm_line(l) not in base]

    def unsure_items(self):
        t = self.report_text
        m = re.search(r'^##\s*(?:' + '|'.join(map(re.escape, form.every('reportUnsure'))) + r')[^\n]*\n(.*?)(?=^##\s|\Z)', t, re.S | re.M)
        if not m:
            return []
        items = []
        for l in m.group(1).splitlines():
            if not l.strip().startswith(('-', '*')):
                continue
            km = re.search(r'(?:' + '|'.join(map(re.escape, form.every('reportKeywords'))) + r')[:：]\s*([^｜|\n]+)', l, re.I)
            if km:
                kws = [norm_c(x) for x in re.split(r'[、,，/\s]+', km.group(1)) if norm_c(x)]
                if kws:
                    items.append((l.strip(), [tuple(kws)]))
                    continue
            qs = [norm_c(q.group(1) or q.group(2)) for q in QUOTE_RE.finditer(l)]
            qs = [q for q in qs if len(q) >= 3]
            if qs:
                items.append((l.strip(), [(q,) for q in qs]))
            else:
                items.append((l.strip(), []))
        return items

    def inv_unsure(self, props):
        items = self.unsure_items()
        for item, groups in items:
            if not groups:
                if self.area == 'proposed':
                    self.add('warn', 'inv-unsure', 'report.md', None, say("lintUnsureNoKeys"), item[:60], self.area)
                continue
            if self.area == 'proposed' and any(len(g) > 1 for g in groups):
                for g in groups:
                    for c in [self.input_c] + self.raw:
                        hit = next((x for x in c.find_text(g, limit=5) if x[2] and x[2] != '系统'), None)
                        if hit:
                            self.add('warn', 'inv-unsure-raw', 'report.md', None,
                                     say("lintUnsureKeysFound", name=c.name, hit=hit[0], hit2=hit[2]),
                                     say("lintListSep").join(g)[:40], self.area)
                            break
            for rel, text in props.items():
                if 'archive' in rel or rel.startswith(('sleep/', 'memory/sleep/')):
                    continue
                lines = text.splitlines()
                secs = sections(lines)
                for i, l in enumerate(lines):
                    if is_skippable(l):
                        continue
                    title = section_of(secs, i)
                    if any(x in title for x in ('猜测', *form.every('reportUnsure'), '待证实', '存疑', '经过')):
                        continue
                    n = norm_c(asserted(l))
                    for g in groups:
                        if all(k in n for k in g) and not hedged(asserted(l)):
                            self.add('error', 'inv-unsure', rel, i + 1, say("lintUnsureAsFact"),
                                     say("lintListSep").join(g)[:40], self.area)
                            break

    def goodbad(self, text):
        lines = (text or '').splitlines()
        starts = [i for i, l in enumerate(lines) if l.startswith(GOODBAD)]
        blocks = []
        for s in starts:
            e = next((j for j in range(s + 1, len(lines)) if re.match(r'^#{1,4} ', lines[j])), len(lines))
            blocks.append('\n'.join(lines[s:e]).rstrip())
        return blocks

    def inv_goodbad(self, props):
        rel = next((r for r in props if re.fullmatch(r'soul/40-[^/]*\.md', r)), None)
        base_rel = rel or next((r for r in self.base.list('soul/') if re.fullmatch(r'soul/40-[^/]*\.md', r)), None)
        if not base_rel:
            return
        base = self.base.read(base_rel)
        bb = self.goodbad(base)
        if rel:
            pb = self.goodbad(props[rel])
            if len(pb) != 1:
                self.add('error', 'inv-goodbad', rel, None, say("lintGoodBadCount", count=len(pb)), None, self.area)
            elif bb and sha(pb[0]) != sha(bb[0]):
                self.add('error', 'inv-goodbad', rel, None, say("lintGoodBadChanged"),
                         sha(pb[0])[:12] + ' ≠ ' + sha(bb[0])[:12], self.area)

    def goodbad_daytime(self):
        """白天有没有人改了例子区（原文件和 git 里提交的版本比）；不管今晚有没有提案都查。"""
        base_rel = next((r for r in self.base.list('soul/') if re.fullmatch(r'soul/40-[^/]*\.md', r)), None)
        if not base_rel:
            return
        bb = self.goodbad(self.base.read(base_rel))
        cb = self.goodbad(self.base.committed(base_rel))
        if bb and cb and sha(bb[0]) != sha(cb[0]):
            self.add('warn', 'inv-goodbad-day', base_rel, None, say("lintGoodBadDaytime"),
                     sha(bb[0])[:12] + ' ≠ ' + sha(cb[0])[:12], 'proposed')
        if len(bb) > 1:
            self.add('warn', 'inv-goodbad-day', base_rel, None, say("lintGoodBadOrigCount", count=len(bb)), None, 'proposed')

    def inv_changelog(self, props):
        cl_rel = CHANGELOG
        base_cl = base_changelog(self.base)
        prop_cl = prop_changelog(props, base_cl)
        old = {norm_line(l) for l in base_cl.splitlines()}
        newl = [l for l in prop_cl.splitlines() if l.strip() and norm_line(l) not in old]
        if self.area == 'proposed':
            self.stats['changelog_new'] = len(newl)
            if len(newl) > 5:
                self.add('warn', 'inv-changelog', cl_rel, None, say("lintChangelogMany", count=len(newl)), None,
                         self.area)
        for rel, text in props.items():
            if not re.fullmatch(r'soul/[^/]+\.md', rel):
                continue
            base = self.bases.get(rel)
            if base is not None and base.strip() == text.strip():
                continue
            block = re.sub(r'^\d+-', '', Path(rel).stem)
            snap = bool(SNAP_RE.search(text) or SNAP_RE.search(base or ''))
            if snap:
                self.add('info', 'inv-changelog', rel, None, say("lintSnapshotChanged", block=block), None, self.area)
                continue
            if base is not None and self.only_section_changed(base, text, '最近的口味和兴趣'):
                self.add('info', 'inv-changelog', rel, None, say("lintTasteOnly", block=block), None, self.area)
                continue
            if not any(norm_c(block) in norm_c(l) for l in newl):
                self.add('error', 'inv-changelog', rel, None, say("lintSoulNoChangelog", block=block), None,
                         self.area)

    @staticmethod
    def only_section_changed(base, text, name):
        def strip_sec(t):
            ls = t.splitlines()
            sec = find_sec(sections(ls), name)
            if not sec:
                return t.strip()
            _, s, e = sec
            return '\n'.join(ls[:s] + ls[e:]).strip()
        return strip_sec(base) == strip_sec(text) and base.strip() != text.strip()

    def inv_summary_rewrite(self, props):
        for rel, text in props.items():
            if kind_of(rel) != 'thread':
                continue
            base = self.bases.get(rel)
            if not base:
                continue
            bl, pl = base.splitlines(), text.splitlines()
            bs, ps = sections(bl), sections(pl)
            if not re.search(r'<!--\s*事件线', base) or not find_sec(bs, '一句话') or not find_sec(bs, '简述'):
                continue
            if not ''.join(l for _, l in sec_lines(bl, find_sec(bs, '简述'))).strip():
                continue
            old_jg = {norm_line(l) for _, l in thread_jg(base)}
            if any(not is_skippable(l) and norm_line(l) not in old_jg for _, l in thread_jg(text)):
                continue
            changed = []
            for name in ('一句话', '简述', '现在的状态'):
                a = '\n'.join(norm_line(l) for _, l in sec_lines(bl, find_sec(bs, name)) if l.strip())
                b = '\n'.join(norm_line(l) for _, l in sec_lines(pl, find_sec(ps, name)) if l.strip())
                if a != b:
                    changed.append(name)
            if changed:
                self.add('error', 'inv-rewrite', rel, None, say("lintSummaryNoNewLog", parts=say("lintListSep").join(changed)), None, self.area)

    WEEK_RES = [re.compile(x) for x in form.every('storyWeek')]   # 第 N 周（MM-DD – MM-DD）, Week N (MM-DD – MM-DD)

    def inv_story(self, props):
        try:
            day = dt.date.fromisoformat(self.day)
        except ValueError:
            return
        week_start = day - dt.timedelta(days=day.weekday())
        for rel, text in props.items():
            if not rel.startswith('memory/story/'):
                continue
            base = self.bases.get(rel)
            if not base:
                continue
            ym = re.search(r'(20\d\d)-(\d\d)', rel)
            year = int(ym.group(1)) if ym else day.year

            def weeks(t):
                ls = t.splitlines()
                out = {}
                for title, s, e in sections(ls):
                    m = next((m for r in self.WEEK_RES if (m := r.match('## ' + title))), None) if title else None
                    if m:
                        out[title] = (m, [l for l in ls[s + 1:e]])
                return out
            bw, pw = weeks(base), weeks(text)
            for title, (m, blines) in bw.items():
                try:
                    end = dt.date(year, int(m.group(3)), int(m.group(4)))
                except ValueError:
                    continue
                if end >= week_start:
                    continue
                if title not in pw:
                    self.add('error', 'inv-story', rel, None, say("lintWeekGone", title=title), None, self.area)
                    continue
                pl = pw[title][1]
                b = [l for l in blines if l.strip()]
                p = [l for l in pl if l.strip()]
                if p[:len(b)] != b or not all(re.match(r'^\s*(?:- )?(?:' + '|'.join(map(re.escape, form.every('storyAmend'))) + r')\s?\d{1,2}-\d{1,2}[：:]', x) for x in p[len(b):]):
                    self.add('error', 'inv-story', rel, None,
                             say("lintWeekChanged", title=title), None, self.area)

    def owner_quotes_by_hh(self):
        """sleep/config.json 的 主人_quotes 是 hh：他最近 3 天的原话由 HH 的中期视图按时间列出来（10-31 起），人物近况不用抄。"""
        try:
            return json.loads((self.ws / 'sleep' / 'config.json').read_text(encoding='utf-8')).get('owner_quotes') == 'hh'
        except (OSError, ValueError, AttributeError):
            return False

    def inv_recent_owner(self, props):
        """<主人>.md 里删掉的、他最近 3 天直接说的话（带日期和时间的行），人物近况的 主人 那节要留着一行
        （考试 v0：压缩后只进 archive 的近几天原话，第二天就答不上了）。只报告 ⚠️。
        HH 的中期视图已经常驻他这 3 天的原话时（主人_quotes=hh）不查。"""
        rel = f'memory/{OWNER_KEY}.md'
        if rel not in props or self.owner_quotes_by_hh():
            return
        base = self.bases.get(rel) or ''
        new_set = {norm_line(l) for l in props[rel].splitlines()}
        day = dt.date.fromisoformat(self.day)
        recent = {day - dt.timedelta(days=k) for k in range(3)} | {day + dt.timedelta(days=1)}
        people = props.get(self.people_rel) or self.base.read(self.people_rel) or ''
        lines = people.splitlines()
        sec = next(((t, a, b) for t, a, b in sections_any(lines) if t.lower().startswith(OWNER.lower())), None)
        gtext = '\n'.join(lines[sec[1]:sec[2]]) if sec else ''
        for i, l in enumerate(base.splitlines()):
            if is_skippable(l) or norm_line(l) in new_set:
                continue
            times = re.findall(r'(?<![\d:])(\d{1,2}:\d\d)(?![\d:])', l)
            dated = False
            for mo, d in re.findall(r'(?<!\d)(?:20\d\d-)?(\d{1,2})-(\d{1,2})(?!\d)', l):
                try:
                    dated = dated or dt.date(day.year, int(mo), int(d)) in recent
                except ValueError:
                    pass
            if dated and times and not any(t in gtext for t in times):
                self.add('warn', 'inv-recent-owner', rel, i + 1,
                         say("lintRecentOwner", owner_key=OWNER_KEY),
                         norm_line(l)[:60], self.area)

    def inv_written_at(self, props):
        """这两天的我、人物近况开头的「写于」要照 date 写：比现在晚 10 分钟以上就是估的（10-31 那晚写成 03:50，其实 03:2x）。"""
        for rel in ('memory/midterm/self.md', self.people_rel):   # 2 期：near.md 是 hhd 写的，不会是提案
            t = props.get(rel)
            m = re.search(r'<!--\s*(?:' + '|'.join(map(re.escape, form.every('stampWord'))) + r')\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*-->', t or '')
            if not m:
                continue
            try:
                at = dt.datetime.fromisoformat(f'{m.group(1)} {int(m.group(2)):02d}:{m.group(3)}')
            except ValueError:
                continue
            if at > self.now + dt.timedelta(minutes=10):
                self.add('error', 'inv-written-at', rel, 1,
                         say("lintWrittenAtFuture", group=m.group(1)[5:], a=int(m.group(2)), group2=m.group(3), now=self.now),
                         m.group(0), self.area)

    SELF_QUOTE_RE = re.compile(form('lintSelfQuote'))
    SELF_ID_RE = re.compile(r'BV1\w+|e0\d{3}')
    SELF_ENDNOTE_RE = re.compile(r'^\s*[（(][^（）()]*[）)]\s*$')

    def inv_self_voice(self, props):
        """这两天的我要像我睡前跟自己说昨天（11-10 连续感）：只给 warn，不拦 finish。
        ① 原句引号至少 2 句，且在材料 / 每日笔记 / 中央记忆里 grep 得到；② 正文没有 BV1、e0nnn（编号收到段末一行括号里）；③ 没有「①」。"""
        rel = 'memory/midterm/self.md'
        t = props.get(rel)
        if not t:
            return
        body = [(i + 1, l) for i, l in enumerate(t.splitlines()) if not l.lstrip().startswith('<!--')]
        quotes = [(ln, (m.group(1) or m.group(2)).strip()) for ln, l in body for m in self.SELF_QUOTE_RE.finditer(l)]
        corpora = [self.input_c] + list(self.raw)
        found = [q for q in quotes if any(c.contains_text(norm_c(q[1])) for c in corpora)]
        if len(found) < 2:
            lost = [q[1][:20] for q in quotes if q not in found][:3]
            self.add('warn', 'self-voice-quotes', rel, None,
                     say("lintSelfVoice", found=len(found), lost=say("lintSelfVoiceLost", lost=say("lintListSep").join(lost)) if lost else ''), None, self.area)
        for ln, l in body:
            if self.SELF_ENDNOTE_RE.match(l):
                continue
            m = self.SELF_ID_RE.search(l)
            if m:
                self.add('warn', 'self-voice-ids', rel, ln, say("lintNoIdsInBody"), m.group(0), self.area)
                break
        for ln, l in body:
            if '①' in l:
                self.add('warn', 'self-voice-list', rel, ln, say("lintNoTodoList"), l.strip()[:40], self.area)
                break

    def inv_lessons(self, props):
        """教训：「犯的日子」日期不重复（重跑不许把同一天记两次）：memory/lessons.md 和 skills/ 各页（归档的不查）的教训行；
        HH 发过的教训编号应用后还在（inv_lesson_ids）；搬完以前 memory/lessons.md 要留着（inv_lessons_kept）。"""
        rows = [(LESSONS_REL, i + 1, l) for i, l in enumerate((props.get(LESSONS_REL) or '').splitlines())]
        for rel in sorted(props):
            if rel.startswith('skills/') and '归档' not in rel.split('/'):
                rows += [(rel, ln, l) for ln, l in page_lessons(rel, props[rel])]
        for rel, ln, l in rows:
            m = re.search(r'(?:' + '|'.join(map(re.escape, form.every('noteDays'))) + r')[:：]\s*([^｜|]+)', l)
            if not m:
                continue
            ds = re.findall(r'20\d\d-\d\d-\d\d', m.group(1))
            if len(ds) != len(set(ds)):
                self.add('error', 'inv-lessons', rel, ln, say("lintLessonDupDates"), m.group(1)[:40], self.area)
        dels = self.delete_list() if self.area == 'proposed' else set()
        self.inv_lesson_ids(props, dels)
        if self.area == 'proposed':
            self.inv_lessons_kept(props, dels)

    def delete_list(self):
        """delete.txt 里要删的文件（# 后面是注释）。"""
        dl = self.dir / 'delete.txt'
        if not dl.exists():
            return set()
        return {x.split('#', 1)[0].strip() for x in dl.read_text(encoding='utf-8').splitlines()} - {''}

    def inv_lesson_ids(self, props, dels):
        """今晚改的、删的 skills/ 页上 HH 发过的教训编号（<!-- l:0039 -->，并进来的旧号也算），应用后还要在某一页（含归档）的教训行上：
        编号跟着那一行走，挪页、合并都带着；丢了的话 finish 的编号闸门会让这一晚 skills/ 的改动整批不换。新写的不用编号，不查。"""
        touched = sorted(r for r in set(props) | dels if r.startswith('skills/') and r.endswith('.md'))
        before = {}
        for rel in touched:
            for x in lesson_ids(rel, self.base.read(rel)):
                before.setdefault(x, rel)
        if not before:
            return
        after = set()
        for rel in set(self.base.list('skills/')) | {r for r in props if r.startswith('skills/')}:
            if rel not in dels:
                after |= lesson_ids(rel, props[rel] if rel in props else self.base.read(rel))
        for x in sorted(set(before) - after):
            self.add('error', 'inv-lessons', before[x], None,
                     say("lintLessonIdLost", x=x), x, self.area)

    def inv_lessons_kept(self, props, dels):
        """搬完以前（skills/MAP.md 最后一行还不是「搬家完成：<日期>」）教训还记在 memory/lessons.md：别删、别没了。
        搬完以后它可有可无（主人 切换时处理）。没有 skills/MAP.md 的工作区不查。"""
        mp = props[MAP_REL] if MAP_REL in props else self.base.read(MAP_REL)
        if mp is None:
            return
        last = next((l.strip() for l in reversed(mp.splitlines()) if l.strip()), '')
        if MOVED_RE.match(last):
            return
        why = say("lintLessonsNotMoved")
        if LESSONS_REL in dels:
            self.add('error', 'inv-lessons', LESSONS_REL, None, say("lintLessonsDelete", why=why), None, self.area)
        elif LESSONS_REL not in props and self.base.read(LESSONS_REL) is None:
            self.add('warn', 'inv-lessons', LESSONS_REL, None, say("lintLessonsGone", why=why), None, self.area)

    # ----- 三、按 memory/layout.json 自查（主人 10-29：每段有类型，只有「详情」会变淡） -----

    def layout_cfg(self, props):
        raw = props.get(LAYOUT_REL) if LAYOUT_REL in props else self.base.read(LAYOUT_REL)
        if raw is None:
            self.add('info', 'layout', LAYOUT_REL, None, say("lintNoLayout"), None, self.area)
            return None
        try:
            cfg = json.loads(raw)
            assert isinstance(cfg.get('files'), list)
            return cfg
        except (ValueError, AssertionError, AttributeError) as e:
            self.add('error', 'layout', LAYOUT_REL, None, say("lintLayoutUnreadable", e=e), None, self.area)
            return None

    def inv_layout(self, props):
        cfg = self.layout_cfg(props)
        if not cfg:
            return
        fade = cfg.get('fade') or {}
        pins = (fade['pinTag'],) if fade.get('pinTag') else form.every('pinTag')   # the layout's, else every language's
        pin = pins[0]
        types = set((cfg.get('types') or {}).keys()) or set(LAYOUT_TYPES)
        try:
            today = dt.date.fromisoformat(self.day)
        except ValueError:
            today = dt.date.today()
        stats = {'files': 0, 'sections': 0, 'pins': {}}
        for f in cfg['files']:
            rel = f.get('path')
            if not rel or rel.endswith('/'):
                continue
            text = props[rel] if rel in props else self.base.read(rel)
            if text is None:
                self.add('warn', 'layout', rel, None, say("lintLayoutNoFile"), None, self.area)
                continue
            stats['files'] += 1
            base = self.bases.get(rel) if rel in props else None
            lines = text.splitlines()
            secs = layout_sections(lines)
            confs = f.get('sections') or []
            matched = {}
            for s in secs:
                c = next((c for c in confs if s['key'].startswith(c.get('title', '\0'))), None)
                # 同一个配置段已经在更浅的一级对上过：这里是别的段里的同名小标题（soul/80「其余」下的「记得的事（重要度 2–3）」）
                if c and any(x['level'] < s['level'] for x in matched.get(c['title'], [])):
                    c = None
                s['conf'] = c
                if c:
                    matched.setdefault(c['title'], []).append(s)
            lvl = min((s['level'] for s in secs if s['conf']), default=2)
            for c in confs:
                if c.get('title') not in matched:
                    self.add('warn', 'layout', rel, None, say("lintLayoutNoSection", title=c.get("title"), kind=c.get("type")), None, self.area)
            for s in secs:
                c = s['conf']
                if not c and s['level'] != lvl:
                    continue                         # 某一段里面的小标题，跟着那一段走
                stats['sections'] += 1
                want = c.get('type') if c else None
                if not s['mark']:
                    self.add('error', 'layout', rel, s['line'] + 1,
                             say("lintLayoutNoType", section=s["key"][:30], hint=say("lintLayoutWant", want=want) if want else say("lintLayoutOwnType")),
                             None, self.area)
                elif s['mark'] not in types:
                    self.add('error', 'layout', rel, s['line'] + 2, say("lintLayoutBadType", section=s["key"][:30], mark=s["mark"]), None, self.area)
                elif want and s['mark'] != want:
                    self.add('error', 'layout', rel, s['line'] + 2, say("lintLayoutTypeDiffers", section=s["key"][:30], mark=s["mark"], want=want), None, self.area)
                kind = want or s['mark']
                body = section_body(lines, s)
                if c and c.get('maxChars') and len(body) > c['maxChars']:
                    self.add('warn', 'layout-size', rel, s['line'] + 1,
                             say("lintLayoutTooLong", section=s["key"][:30], size=len(body), maxchars=c["maxChars"], hint=say("lintLayoutDemote") if kind == '详情' else ''), None, self.area)
                if base is not None:
                    self.layout_changes(rel, s, kind, c, lines, base)
                if kind == '详情':
                    self.layout_detail(rel, lines, s, today, fade, pins, stats)
            if f.get('maxChars') and len(text) > f['maxChars']:
                self.add('warn', 'layout-size', rel, None, say("lintFileTooLong", size=len(text), maxchars=f["maxChars"]),
                         None, self.area)
            n = stats['pins'].get(rel, 0)
            if n > int(fade.get('pinWarnPerFile') or 10):
                self.add('warn', 'layout-detail', rel, None, say("lintTooManyPins", pin=pin, n=n, limit=fade.get("pinWarnPerFile") or 10),
                         None, self.area)
        self.stats['layout'] = stats

    def layout_changes(self, rel, s, kind, c, lines, base):
        """今晚的提案和原文件比：锁定段不许动；原话段只许往后加；设定段改了要有「以前 → 现在」。"""
        blines = base.splitlines()
        bs = next((x for x in layout_sections(blines) if x['key'] == s['key']), None)
        if not bs:
            bs = next((x for x in layout_sections(blines) if c and x['key'].startswith(c['title'])), None)
        if not bs:
            return                                   # 新段
        old = [norm_line(l) for l in section_body(blines, bs).splitlines() if l.strip()]
        new_raw = [l for l in section_body(lines, s).splitlines() if l.strip()]
        new = [norm_line(l) for l in new_raw]
        if old == new:
            return
        name = s['key'][:30]
        if c and c.get('locked'):
            self.add('error', 'layout', rel, s['line'] + 1, say("lintLocked", name=name), None, self.area)
        elif kind == '原话':
            if new[:len(old)] != old:
                k = next((i for i, (a, b) in enumerate(zip(old, new)) if a != b), min(len(old), len(new)))
                gone = old[k] if k < len(old) else ''
                self.add('error', 'layout', rel, s['line'] + 1, say("lintQuotesAppendOnly", name=name), gone[:60] or None, self.area)
        elif kind == '设定':
            added = [l for l, n in zip(new_raw, new) if n not in set(old)]
            if not any(SUPERSEDED_RE.search(l) for l in added):
                self.add('error', 'layout', rel, s['line'] + 1, say("lintSettingChanged", name=name),
                         None, self.area)

    def layout_detail(self, rel, lines, s, today, fade, pins, stats):
        """详情：每条带日期；14 天后还是原话长度、60 天后还不是标题的列出来；数〔不淡〕。"""
        short_days, title_days = int(fade.get('detailDays') or 14), int(fade.get('summaryDays') or 60)
        cur = None
        for i in range(s['line'] + 1, s['end']):
            l = lines[i]
            if is_heading(l):
                cur = line_date(l, today) or cur     # 详情按日期分小节时，条目跟着小节的日期
                continue
            if not re.match(r'^[-*+]\s', l):
                continue
            item = l[2:].strip()
            if item.startswith(pins):
                stats['pins'][rel] = stats['pins'].get(rel, 0) + 1
                continue
            d = line_date(l, today) or cur
            if not d:
                self.add('warn', 'layout-detail', rel, i + 1, say("lintDetailNoDate"), item[:40], self.area)
                continue
            age = (today - d).days
            n = len(META_RE.sub('', item))
            if age > title_days and n > DETAIL_TITLE_CHARS:
                self.add('warn', 'layout-detail', rel, i + 1, say("lintDetailOld60", age=age, n=n), item[:40], self.area)
            elif age > short_days and n > DETAIL_SHORT_CHARS:
                self.add('warn', 'layout-detail', rel, i + 1, say("lintDetailOld14", age=age, n=n), item[:40], self.area)

    def inv_events(self, props):
        """soul/80 的「记得的事」（主人 10-29 按重要度进长期记忆）：常驻那段只许〔4〕〔5〕，其余里的只许〔2〕〔3〕，每条都要有为什么重要。"""
        rel = next((r for r in props if re.fullmatch(r'soul/80-[^/]*\.md', r)), None) or \
            next((r for r in self.base.list('soul/') if re.fullmatch(r'soul/80-[^/]*\.md', r)), None)
        if not rel:
            return
        text = props[rel] if rel in props else self.base.read(rel)
        if not text:
            return
        lines = text.splitlines()
        for s in layout_sections(lines):
            if not s['key'].startswith('记得的事'):
                continue
            allowed = ('4', '5') if s['level'] == 2 else ('2', '3')
            where = say("lintEventsResident") if s['level'] == 2 else say("lintEventsRest")
            for i in range(s['line'] + 1, s['end']):
                l = lines[i]
                if is_heading(l):
                    break
                if not re.match(r'^[-*+]\s', l):
                    continue
                m = IMPORTANCE_RE.search(l)
                if not m:
                    self.add('error', 'layout-events', rel, i + 1, say("lintEventsNoImportance", where=where), l[2:42], self.area)
                elif m.group(1) not in allowed:
                    self.add('error', 'layout-events', rel, i + 1,
                             say("lintEventsWrongImportance", where=where, allowed=say("lintImportanceSep").join(allowed), group=m.group(1)), l[2:42], self.area)
                if '为什么重要' not in l:
                    self.add('error', 'layout-events', rel, i + 1, say("lintEventsNoWhy", where=where), l[2:42], self.area)

    def compute_sizes(self, props):
        rows = []
        th = {'new': 0, 'updated': 0, 'same': 0}
        jg_added = 0
        for rel in sorted(props):
            b = self.bases.get(rel)
            p = props[rel]
            rows.append({'file': rel, 'base_chars': len(b) if b is not None else None, 'chars': len(p)})
            if kind_of(rel) == 'thread':
                if b is None:
                    th['new'] += 1
                elif b.strip() == p.strip():
                    th['same'] += 1
                else:
                    th['updated'] += 1
                old = {norm_line(l) for l in (b or '').splitlines()}
                jg_added += sum(1 for _, l in thread_jg(p) if not is_skippable(l) and norm_line(l) not in old)
        self.sizes = rows
        ol = props.get('memory/open-loops.md') or self.base.read('memory/open-loops.md') or ''
        body = loops_open(ol)
        bol = self.base.read('memory/open-loops.md') or ''
        bbody = loops_open(bol)
        lessons = props.get('memory/lessons.md') or ''
        soul_changed = sum(1 for r in props if re.fullmatch(r'soul/[^/]+\.md', r) and
                           (self.bases.get(r) or '').strip() != props[r].strip())
        self.stats['counts'] = {
            'threads': th, 'jg_lines_added': jg_added,
            'soul_files_changed': soul_changed, 'changelog_new': self.stats.get('changelog_new', 0),
            'open_loops_in_progress': {'base': sum(1 for l in bbody.splitlines() if l.startswith('- [ ]')),
                                       'proposed': sum(1 for l in body.splitlines() if l.startswith('- [ ]'))},
            'lessons': sum(1 for l in lessons.splitlines() if l.startswith(tuple('- ' + w for w in form.every('noteLesson')))),
        }

    # ----- 输出 -----

    def result(self):
        P = [i for i in self.issues if i['area'] == 'proposed']
        failed = sorted({i['file'] for i in P if i['sev'] == 'error' and (i['file'] in self.P or i['check'] == 'inv-delete')})
        return {
            'day': self.day, 'mode': 'report',
            'generated_at': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
            'base': self.base.rev or 'live',
            'failed_files': failed,
            'counts': {'errors': sum(1 for i in P if i['sev'] == 'error'),
                       'warnings': sum(1 for i in P if i['sev'] == 'warn'),
                       'files_checked': len(self.P)},
            'stats': self.stats,
            'sizes': self.sizes,
            'issues': [i for i in self.issues if i['area'] == 'proposed'],
            'sunday_merge': {'files_checked': len(self.S),
                             'errors': sum(1 for i in self.issues if i['area'] == 'sunday-merge' and i['sev'] == 'error'),
                             'issues': [i for i in self.issues if i['area'] == 'sunday-merge']},
        }

    def markdown(self, r):
        c = r['counts']
        ts = r['stats']['thread_summary']
        out = ['<!-- lint:start -->', say("lintReportHeading"), '']
        out.append(say("lintReportFiles", files_checked=c['files_checked'], errors=c['errors'], warnings=c['warnings'], result=say("lintReportFailed", count=len(r['failed_files']), files=say("lintListSep").join(r['failed_files'])) if r['failed_files'] else say("lintReportAllPassed")))
        out.append(say("lintReportFacts", checked=ts['checked'], a=ts['error'] + ts['warn'], error=ts['error'], warn=ts['warn']))
        inv_names = [('inv-jg', say("lintInvLogGrows")), ('inv-jg-dup', say("lintInvLogNoDup")), ('inv-delete', say("lintInvDeleteKept")),
                     ('inv-removed', say("lintInvRemovedKept")), ('inv-unsure', say("lintInvUnsure")), ('inv-recent-owner', say("lintInvRecentOwner")), ('inv-written-at', say("lintInvWrittenAt")),
                     ('inv-goodbad', say("lintInvGoodBad")), ('inv-goodbad-day', say("lintInvGoodBadDay")),
                     ('inv-changelog', say("lintInvChangelog")), ('inv-rewrite', say("lintInvSummary")), ('inv-story', say("lintInvStory")),
                     ('inv-lessons', say("lintInvLessons")),
                     ('layout', say("lintInvLayout")),
                     ('layout-size', say("lintInvSize")), ('layout-detail', say("lintInvDetail")),
                     ('layout-events', say("lintInvEvents"))]
        def mark(k):
            e = sum(1 for i in r['issues'] if i['check'] == k and i['sev'] == 'error')
            w = sum(1 for i in r['issues'] if i['check'] == k and i['sev'] == 'warn')
            return '✅' if not (e or w) else ' '.join(x for x in (f'❌ {e}' if e else '', f'⚠️ {w}' if w else '') if x)
        out.append(say("lintReportInvariants", list=say("lintSemicolon").join(f'{label} {mark(k)}' for k, label in inv_names)))
        cnt = r['stats'].get('counts', {})
        if cnt:
            t = cnt['threads']
            out.append(say("lintReportNumbers", new=t['new'], updated=t['updated'], same=t['same'], jg_lines_added=cnt['jg_lines_added'], soul_files_changed=cnt['soul_files_changed'], changelog_new=cnt['changelog_new'], base=cnt['open_loops_in_progress']['base'], proposed=cnt['open_loops_in_progress']['proposed'], lessons=cnt['lessons']))
        big = [s for s in r['sizes'] if s['base_chars'] is None or abs(s['chars'] - (s['base_chars'] or 0)) >= 1000]
        if big:
            out.append(say("lintReportSizes", list=say("lintSemicolon").join(
                f"{s['file']} {s['base_chars'] if s['base_chars'] is not None else say('lintNew')}→{s['chars']}" for s in big[:20])))
        if r['sunday_merge']['files_checked']:
            out.append(say("lintReportSunday", files_checked=r['sunday_merge']['files_checked'], errors=r['sunday_merge']['errors']))
        by = {}
        for i in r['issues']:
            if i['sev'] in ('error', 'warn'):
                by.setdefault(i['file'], []).append(i)
        if by:
            out += ['', say("lintReportEachHeading") % LIST_CAP]
            for f in sorted(by, key=lambda f: (-sum(1 for i in by[f] if i['sev'] == 'error'), f)):
                items = sorted(by[f], key=lambda i: (i['sev'] != 'error', i['line'] or 0))
                ne = sum(1 for i in items if i['sev'] == 'error')
                out.append(say("lintReportFile", f=f, ne=ne, nw=len(items) - ne))
                for i in items[:LIST_CAP]:
                    loc = f":{i['line']}" if i['line'] else ''
                    atom = f" `{i['atom']}`" if i['atom'] else ''
                    out.append(f"  - {'❌' if i['sev'] == 'error' else '⚠️'}{loc}{atom} {i['msg']}")
                if len(items) > LIST_CAP:
                    out.append(say("lintReportMore", count=len(items) - LIST_CAP))
        out.append('<!-- lint:end -->')
        return '\n'.join(out)


COMMON_EN = {*(a.lower() for a in (OWNER_KEY, *OWNER_ALIASES, *COMMON_WORDS)), 'the', 'and', 'for', 'with', 'app', 'ai', 'up', 'ok', 'whatsapp', 'qq', 'cron', 'claude', 'code',
             'codex', 'soul', 'memory', 'midterm', 'threads', 'skills', 'json', 'python', 'mac', 'macos',
             'git', 'bug', 'opus', 'sonnet', 'haiku', 'token', 'tokens', 'max', 'plan', 'bgm',
             'docker', 'harness', 'agent', 'agents', 'nan', 'adb', 'id', 'url', 'api',
             'cc', 'leak', 'guard', 'build', 'fish', 'tts', 'gpt', 'llm', 'sqlite', 'web', 'pdf', 'readme', 'result', 'todo'}


def write_report(day_dir, block):
    p = Path(day_dir) / 'report.md'
    t = p.read_text(encoding='utf-8') if p.exists() else ''
    t = re.sub(r'<!-- lint:start -->.*?<!-- lint:end -->\n*', '', t, flags=re.S)
    head = ''
    if t.startswith('# '):          # 报告标题留在最上面
        first, _, rest = t.partition('\n')
        head, t = first + '\n\n', rest.lstrip('\n')
    tmp = p.with_suffix('.md.tmp')
    tmp.write_text(head + block + '\n\n' + t, encoding='utf-8')
    tmp.replace(p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=say("lintHelp"), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('day', help=say("lintDayHelp"))
    ap.add_argument('--root', default=str(WS_DEFAULT), help=say("lintRootHelp"))
    ap.add_argument('--day-dir', help=say("lintDirHelp"))
    ap.add_argument('--all', action='store_true', help=say("lintAllHelp"))
    ap.add_argument('--base-rev', help=say("lintBaseHelp"))
    ap.add_argument('--no-raw-db', action='store_true', help=say("lintNoRawDbHelp"))
    ap.add_argument('--report', action='store_true', help=say("lintReportHelp"))
    ap.add_argument('--json', action='store_true', help=say("lintJsonHelp"))
    a = ap.parse_args(argv)
    ws = Path(a.root)
    day_dir = Path(a.day_dir) if a.day_dir else ws / 'sleep' / a.day
    if not day_dir.is_dir():
        print(say("lintNoDir", day_dir=day_dir), file=sys.stderr)
        return 1
    lint = Lint(ws, a.day, day_dir, Base(ws, a.base_rev), check_all=a.all, raw_db=not a.no_raw_db).run()
    r = lint.result()
    md = lint.markdown(r)
    if a.report:
        tmp = day_dir / 'lint.json.tmp'
        tmp.write_text(json.dumps(r, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        tmp.replace(day_dir / 'lint.json')
        write_report(day_dir, md)
    print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else md)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # 脚本自己出错：退出 1，让整理者在报告里写一句
        import traceback
        traceback.print_exc()
        print(say("lintFailed", e=e), file=sys.stderr)
        sys.exit(1)
