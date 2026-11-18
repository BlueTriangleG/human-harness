#!/usr/bin/python3
"""中期记忆：事件线分层 + 按时间分档的窗口（2026-10-24 主人 定的；10-25 按验证报告 P0-3 修）。

每条事件线是 memory/threads/<名>.md，顶部有一行元数据和两层简述：

    # B站30天挑战
    <!-- 事件线 开始=2026-10-21 最近进展=2026-10-24 17:37 状态=进行中 置顶到=2026-10-30 下次=2026-11-01 -->
    ## 一句话
    用「一辈子吃素」号做 UP 主，30 天回本 150 刀；首条自介 10-24 已发。
    ## 简述
    一段话：大概经过 + 现在到哪。
    ## 现在的状态 / ## 经过（详情，从头到尾） / ## 因果和判断

一句话、简述、元数据由每晚的睡眠整理维护；白天只往「经过」里追加。
「最近进展」取两者中较新的：元数据里写的，和文件里最新一条带日期的事件行（「经过」里的，也算误放在
「因果和判断」下面的）。只写到月的（2026-10）按那个月 1 号算；一个日期都没有就用文件修改时间，标「缺日期」。

窗口只按时间分档（外加「还在进行」这一条状态规则，主人 10-25 批的），不按条数：
    最近进展在 3 天内（今天、昨天、前天）→ 放简述
    3–13 天前 → 只放一句话
    14–60 天前，或者还在进行中（不论多久）→ 只记个名（标题 · 最近日期 · 状态）
    更久，或已了结超过 7 天 → 不放（被问到再去读事件线 / 搜时间轴）
    置顶到某天的 → 到那天前都放简述
    下次=某天的（有日子的事）→ 到那天前至少放一句话，最后 3 天放简述
简述缺失、或「现在的状态」比最新的事件行旧时，不用过时的状态段，改放最新 1–2 条带日期的原文。
快照太长时由 ledger_snapshot.py 决定先缩哪里（中期记忆最后才缩）；缩只按时间、单调地缩（LADDER），不砍条数。

  midterm.py show                 打印窗口（她自己看、或核对）
  midterm.py list                 每条事件线的日期、状态、分档
  midterm.py build [--root DIR]   写 memory/recent.md；--root 是睡眠整理草稿目录（里面同名文件优先）
  midterm.py leaving [日期]        这一天刚滑出窗口（简述和一句话都看不到了）的事件线（要写进「我的经历」）
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import sys
from pathlib import Path

from night_names import owner_key, retired_flag  # noqa: E402
from zoneinfo import ZoneInfo

from hh_env import forms, words  # noqa: E402

say = words(__file__)

WS = Path(os.environ.get('HH_WORKSPACE') or Path(__file__).resolve().parent.parent)  # the tests run the scripts from a copied workspace's scripts/
TZ = ZoneInfo(os.environ['HH_TZ'])
DAY_START = 4                       # 她的一天凌晨 4 点才换（goals.py 同）
BRIEF_DAYS = (3, 2, 1)              # 简述窗口（旧接口，留着）
LINE_DAYS = (14, 10, 7)             # 一句话窗口（旧接口，留着）
NAME_DAYS = 60                      # 只记个名的窗口
# 缩窗阶梯：每一步只缩不放（简述天数、一句话天数、记名天数都不增加）。第 0 档是平时的窗口。
LADDER = ((3, 14, 60), (3, 10, 60), (3, 7, 60), (2, 7, 60), (2, 7, 30), (1, 7, 30), (1, 7, 14))
DONE_KEEP_DAYS = 7                  # 已了结的事，超过这么多天就不放
NEXT_BRIEF_DAYS = 3                 # 下次=某天：最后这么多天放简述
EVENTS_MAX_CHARS = 9000             # show/build 时事件线部分的软上限（快照那边由 ledger_snapshot.py 管）
BRIEF_MAX = 260                     # 单条简述最长
LINE_MAX = 60                       # 单条一句话最长
EVENT_MAX = 130                     # 放原文时，单条事件行最长
STALE_HOURS = 36                    # 这两天的我 / 人物近况 超过这么久没整理就提醒可能过时
WINDOW_LOG = Path('ledger/.midterm-window.json')   # 每天实际渲染过的窗口（leaving 用）
# 2 期（人物迁进事件库）：退役的 <主人>.md 挪进 archive 以后，人物近况读 hhd 导出的 near.md（和 HH 守卫同一个开关）
RETIRED_FLAG = retired_flag(owner_key(WS))
PEOPLE_NEAR = 'ledger/people/near.md'
PEOPLE_OLD = 'memory/midterm/people.md'

META_RE = re.compile(r'<!--\s*事件线\s+(.*?)-->')
DATE_RE = re.compile(r'(20\d\d)-(\d\d)-(\d\d)(?:[ T](\d{1,2}):(\d\d))?')
# 事件行：行首（去掉列表符号、加粗、括号）就是日期；支持只写到月的 2026-10
EVENT_RE = re.compile(r'^\s*(?:[-*+]\s+)?(?:\*\*|【|\[|「)?\s*(20\d\d)-(\d{1,2})(?:-(\d{1,2}))?(?![\d])(?:[ T]*(\d{1,2}):(\d\d))?')
ANY_DATE_RE = re.compile(r'(20\d\d)-(\d{1,2})(?:-(\d{1,2}))?(?![\d])')
STAMP_RE = re.compile(r'<!--\s*(?:' + '|'.join(map(re.escape, forms(__file__).every('stampWord'))) + r')\s*(20\d\d)-(\d\d)-(\d\d)[ T](\d{1,2}):(\d\d)\s*-->')   # 写于, written
DONE_WORDS = ('已结束', '已完成', '已了结', '已放弃', '结束了', '不再跟进')
SUMMARY_SECTIONS = ('一句话', '简述', '现在的状态')
PLACEHOLDER_RE = re.compile(r'^[（(][^）)]*[）)]$')     # 整行只有一句括号里的提示，是模板没填


def retired_active():
    """2 期的新行为开没开：memory/archive/retired-20261103/<主人>.md 在不在（迁移那天才挪进去）。
    没开时一切照旧：near.md 在 HH 部署后就有，迁移前只有标题，不能拿它当准。"""
    return (WS / RETIRED_FLAG).exists()


def her_today(now=None):
    now = now or dt.datetime.now(TZ)
    return (now - dt.timedelta(hours=DAY_START)).date()


def her_day(t):
    """一个时间点算她的哪一天（凌晨 4 点前算前一天）。"""
    return (t - dt.timedelta(hours=DAY_START)).date()


def parse_when(s):
    m = DATE_RE.search(s or '')
    if not m:
        return None
    y, mo, d, h, mi = m.groups()
    try:
        return dt.datetime(int(y), int(mo), int(d), int(h or 12), int(mi or 0), tzinfo=TZ)
    except ValueError:
        return None


def parse_event(line):
    """事件行的时间：(datetime, 'day' 或 'month')；不是事件行就 None。"""
    m = EVENT_RE.match(line or '')
    if not m:
        return None
    y, mo, d, h, mi = m.groups()
    try:
        t = dt.datetime(int(y), int(mo), int(d or 1), int(h or 12) if d else 12, int(mi or 0) if d else 0, tzinfo=TZ)
    except ValueError:
        return None
    return t, ('day' if d else 'month')


def sections(text):
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith('## '):
            cur = line[3:].strip()
            out.setdefault(cur, [])
        elif cur is not None:
            out[cur].append(line)
    return {k: '\n'.join(v).strip() for k, v in out.items()}


def find_section(secs, *names):
    for k, v in secs.items():
        if any(k.startswith(n) for n in names):
            return v
    return ''


def parse_meta(text):
    """事件线元数据。「为什么=」（重要度的理由，主人 10-29）可以带空格，必须写在最后：它后面到 --> 为止都算它的。"""
    m = META_RE.search(text)
    if not m:
        return {}
    body, why = m.group(1), None
    k = body.find('为什么=')
    if k >= 0:
        body, why = body[:k], body[k + len('为什么='):].strip()
    out = dict(kv.split('=', 1) for kv in re.findall(r'(\S+=\S+(?: \d\d:\d\d)?)', body))
    if why is not None:
        out['为什么'] = why
    return out


def first_line(s):
    for line in (s or '').splitlines():
        line = re.sub(r'^\s*[-*]\s*', '', line).strip()
        if line:
            return line
    return ''


def clip(s, n):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n] + '…'


def drop_placeholders(s):
    """去掉模板里没填的提示行（整行只有一句括号话，比如「（30 字以内：这是什么事、到哪了）」）。"""
    keep = []
    for line in (s or '').splitlines():
        core = re.sub(r'^\s*[-*+]\s*', '', line).strip()
        if not core or PLACEHOLDER_RE.match(core):
            continue
        keep.append(line)
    return '\n'.join(keep).strip()


def short_date(t, prec='day'):
    if t is None:
        return '?'
    if prec == 'month':
        return t.strftime('%Y-%m')
    return t.strftime('%m-%d') + (say("midNoDate") if prec == 'mtime' else '')


def event_text(ev):
    """事件原文（去掉列表符号），太长就截。"""
    return clip(re.sub(r'^\s*[-*+]\s+', '', ev[2]), EVENT_MAX)


class Thread:
    def __init__(self, path):
        self.path = path
        self.text = path.read_text(encoding='utf-8')
        self.name = path.stem
        h1 = next((l[2:].strip() for l in self.text.splitlines() if l.startswith('# ')), self.name)
        self.title = re.sub(r'^故事线[:：]\s*', '', re.sub(r'<!--.*?-->', '', h1)).strip() or self.name
        self.meta = parse_meta(self.text)
        secs = sections(self.text)
        self.status_text = drop_placeholders(find_section(secs, '现在的状态'))
        self.log = find_section(secs, '经过')
        self.line = first_line(drop_placeholders(find_section(secs, '一句话')))
        self.brief = drop_placeholders(find_section(secs, '简述'))
        self.events = self._events()
        horizon = dt.datetime.now(TZ) + dt.timedelta(days=1)
        past = [e for e in self.events if e[0] <= horizon]   # 写在事件行里的将来日期是计划，不算进展
        self.meta_last = parse_when(self.meta.get('最近进展'))
        meta_start = parse_when(self.meta.get('开始'))
        self.start, self.start_prec = (meta_start, 'day') if meta_start else ((past[0][0], past[0][1]) if past else (None, 'day'))
        ev_last = past[-1] if past else None
        if self.meta_last and (not ev_last or self.meta_last >= ev_last[0]):
            self.last, self.last_prec = self.meta_last, 'day'
        elif ev_last:
            self.last, self.last_prec = ev_last[0], ev_last[1]
        else:
            self.last, self.last_prec = dt.datetime.fromtimestamp(path.stat().st_mtime, TZ), 'mtime'
        self.past_events = past
        st = self.meta.get('状态')
        if not st:
            st = '已了结' if any(w in self.status_text[:200] for w in DONE_WORDS) else '进行中'
        self.status = st
        self.pin = parse_when(self.meta.get('置顶到'))
        self.next = parse_when(self.meta.get('下次'))
        self.has_meta = bool(self.meta)
        self.status_date = self._status_date()

    def _events(self):
        """文件里所有带日期的事件行（一句话、简述、现在的状态这几节是摘要，不算），按时间排好。"""
        out, cur = [], None
        for i, line in enumerate(self.text.splitlines()):
            if line.startswith('## '):
                cur = line[3:].strip()
                continue
            if line.startswith('# '):
                cur = None
                continue
            if cur and any(cur.startswith(s) for s in SUMMARY_SECTIONS):
                continue
            if META_RE.search(line):
                continue
            p = parse_event(line)
            if p:
                out.append((p[0], p[1], line, i))
        out.sort(key=lambda e: (e[0], e[3]))
        return [(t, prec, line) for t, prec, line, _ in out]

    def _status_date(self):
        """「现在的状态」写于哪天：优先「最后更新：」，否则取里面不晚于明天的最大日期。"""
        m = re.search(r'最后更新[:：]\s*(20\d\d)-(\d{1,2})-(\d{1,2})', self.status_text)
        if m:
            try:
                return dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 12, tzinfo=TZ)
            except ValueError:
                pass
        horizon = dt.datetime.now(TZ) + dt.timedelta(days=1)
        ds = []
        for y, mo, d in ANY_DATE_RE.findall(self.status_text):
            try:
                t = dt.datetime(int(y), int(mo), int(d or 1), 12, tzinfo=TZ)
            except ValueError:
                continue
            if t <= horizon:
                ds.append(t)
        return max(ds) if ds else None

    def newest_events(self, n):
        return self.past_events[-n:] if n > 0 else []

    def status_is_stale(self):
        """状态段比最新的事件行旧（按天比）。状态段没写日期时说不准，当它不旧。"""
        newest = self.newest_events(1)
        if not newest or not self.status_text:
            return bool(newest)
        if self.status_date is None:
            return False
        return self.status_date.date() < newest[-1][0].date()

    def age(self, today):
        if not self.last:
            return 10 ** 6
        return (today - her_day(self.last)).days

    def tier(self, today, brief_days=BRIEF_DAYS[0], line_days=LINE_DAYS[0], name_days=NAME_DAYS):
        """'brief' 放简述，'line' 放一句话，'name' 只记个名，None 不放。"""
        a = self.age(today)
        if self.pin and her_day(self.pin) >= today:
            return 'brief'
        if self.next:
            until = (her_day(self.next) - today).days
            if 0 <= until < NEXT_BRIEF_DAYS:
                return 'brief'
        if self.status in ('已了结', '已放弃') and a > DONE_KEEP_DAYS:
            return None
        if a < brief_days:
            return 'brief'
        if a < line_days or (self.next and her_day(self.next) >= today):
            return 'line'
        if a <= name_days or self.status == '进行中':
            return 'name'
        return None

    def visible(self, today, window):
        """简述或一句话能看到（只记个名不算：内容已经看不到了）。"""
        return self.tier(today, *window) in ('brief', 'line')

    def one_line(self):
        newest = self.newest_events(1)
        if self.line:
            s = clip(self.line, LINE_MAX)
            if newest and self.meta_last and newest[-1][0] > self.meta_last:
                s += say("midNewSince", newest=newest[-1][0])
            return s
        first = first_line(self.status_text)
        if first and not self.status_is_stale():
            return clip(first, LINE_MAX)
        if newest:
            return clip(event_text(newest[-1]), LINE_MAX)
        return clip(first or self.title, LINE_MAX)

    def brief_text(self):
        newest = self.newest_events(2)
        if self.brief:
            s = clip(self.brief, BRIEF_MAX)
            later = [e for e in newest if self.meta_last and e[0] > self.meta_last]
            if later:   # 简述是整理那晚写的，之后「经过」又有了新的：原文接在后面
                s += say("midLater", later=say("midJoin").join(event_text(e) for e in later))
            return s
        if self.status_text and not self.status_is_stale():
            s = clip(self.status_text, BRIEF_MAX)
            if self.status_date is None and newest:
                s += say("midNewest", event_text=event_text(newest[-1]))
            return s
        if newest:
            sd = self.status_date
            shown = [e for e in newest if not sd or e[0].date() > sd.date()] or newest[-1:]
            if not self.status_text:
                note = say("midNoStatus")
            else:
                note = say("midStatusDate", sd=sd) if sd else say("midStatusNoDate")
            return say("midLogNewest", shown=say("midJoin").join(event_text(e) for e in shown), note=note)
        return clip(self.status_text or self.line or self.title, BRIEF_MAX)

    def dates_label(self):
        f = lambda t: t.strftime('%m-%d') + (t.strftime(' %H:%M') if (t.hour, t.minute) != (12, 0) else '')
        bits = []
        if self.start:
            bits.append(say("midStarted", short_date=short_date(self.start, self.start_prec if self.start_prec != 'mtime' else 'day')))
        if self.last:
            if self.last_prec == 'month':
                bits.append(say("midLastMonth", strftime=self.last.strftime('%Y-%m')))
            elif self.last_prec == 'mtime':
                bits.append(say("midLastMtime", strftime=self.last.strftime('%m-%d')))
            else:
                bits.append(say("midLast", f=f(self.last)))
        if self.next:
            bits.append(say("midNext", strftime=self.next.strftime('%m-%d')))
        bits.append(self.status)
        return say("midBar").join(bits)

    def name_line(self):
        """只记个名：标题 · 最近日期 · 状态。"""
        return f'{self.title} · {short_date(self.last, self.last_prec)} · {self.status}'


def load_threads(root=None):
    live = WS / 'memory/threads'
    paths = {p.name: p for p in live.glob('*.md')}
    if root:
        for p in (Path(root) / 'memory/threads').glob('*.md'):
            paths[p.name] = p
    return [Thread(p) for p in sorted(paths.values())]


def read_part(rel, root=None):
    for base in ([Path(root)] if root else []) + [WS]:
        p = base / rel
        if p.exists():
            t = p.read_text(encoding='utf-8')
            return '\n'.join(l for l in t.splitlines() if not l.startswith('# ')).strip()
    return ''


def demote(text, level=4):
    """块里的标题统一降成 level 级，免得打乱快照的层级（F64：people.md 的「## 人名」）。"""
    return '\n'.join(('#' * level + ' ' + l.lstrip('#').strip()) if re.match(r'^#{1,6} ', l) else l
                     for l in (text or '').splitlines())


def stamped_part(rel, root=None, now=None):
    """(正文, 写于, 过时提示)。正文去掉标题和「写于」那行；写于取文件里的 <!-- 写于 … -->，没有就用修改时间。"""
    now = now or dt.datetime.now(TZ)
    for base in ([Path(root)] if root else []) + [WS]:
        p = base / rel
        if not p.exists():
            continue
        raw = p.read_text(encoding='utf-8')
        m = STAMP_RE.search(raw)
        if m:
            y, mo, d, h, mi = map(int, m.groups())
            written = dt.datetime(y, mo, d, h, mi, tzinfo=TZ)
        else:
            written = dt.datetime.fromtimestamp(p.stat().st_mtime, TZ)
        body = '\n'.join(l for l in raw.splitlines() if not l.startswith('# ') and not STAMP_RE.search(l)).strip()
        if not body:
            return '', '', ''
        hours = (now - written).total_seconds() / 3600
        stale = say("midStale", max=max(1, math.floor(hours / 24))) if hours > STALE_HOURS else ''
        return body, say("midWritten", written=written), stale
    return '', '', ''


def render_events(threads, today, brief_days, line_days, name_days=NAME_DAYS):
    briefs, lines, names = [], [], []
    for t in sorted(threads, key=lambda t: t.last or dt.datetime.min.replace(tzinfo=TZ), reverse=True):
        tier = t.tier(today, brief_days, line_days, name_days)
        ref = f'threads/{t.path.name}'
        if tier == 'brief':
            briefs.append(say("midBriefItem", title=t.title, dates_label=t.dates_label(), brief_text=t.brief_text(), ref=ref))
        elif tier == 'line':
            lines.append(say("midLineItem", title=t.title, dates_label=t.dates_label(), one_line=t.one_line()))
        elif tier == 'name':
            names.append(f'- {t.name_line()}')
    out = []
    if briefs:
        out += [say('midTierBrief', brief_days=brief_days), *briefs, '']
    if lines:
        out += [say('midTierLine', brief_days=brief_days, last=line_days - 1), *lines, '']
    if names:
        out += [say('midTierName', line_days=line_days, name_days=name_days), *names, '']
    return '\n'.join(out).strip()


def window_sentence(used):
    b, l, n = used
    # 主人 10-29：记忆里少放文档式的说明，一句话就够
    s = say('midWindow', b=b, l=l, n=n)
    if tuple(used) != LADDER[0]:
        s += say('midWindowShrunk', a=LADDER[0][0], b=LADDER[0][1], c=LADDER[0][2])
    return s + say('midWindowEnd')


def render(root=None, now=None, events_max=EVENTS_MAX_CHARS, shrink=0, threads=None):
    """中期记忆全文和实际用的窗口 (简述天数, 一句话天数, 记名天数)。
    shrink=k 从缩窗阶梯第 k 档开始；events_max=None 表示不自己缩（快照那边按总长决定）。"""
    today = her_today(now)
    threads = load_threads(root) if threads is None else threads
    start = min(max(shrink, 0), len(LADDER) - 1)
    events, used = '', LADDER[start]
    for w in LADDER[start:]:
        events, used = render_events(threads, today, *w), w
        if events_max is None or len(events) <= events_max:
            break
    me, me_at, me_stale = stamped_part('memory/midterm/self.md', root, now)
    people, people_at, people_stale = stamped_part(PEOPLE_NEAR if retired_active() else PEOPLE_OLD, root, now)
    parts = [
        window_sentence(used),
        '',
        say("midMeHeading", me_at=me_at), *([me_stale] if me_stale else []), demote(me) or say("midNotWritten"), '',
        say("midPeopleHeading", people_at=people_at), *([people_stale] if people_stale else []), demote(people) or say("midNotWritten"), '',
        events or say('midNoThreads'),
    ]
    return '\n'.join(parts).strip(), used


def _window_log():
    try:
        return json.loads((WS / WINDOW_LOG).read_text(encoding='utf-8'))
    except Exception:
        return {}


def window_for(day, which='min'):
    """那一天实际渲染过的窗口：min=缩得最小的一次，max=最宽的一次；没记录就是平时的窗口。"""
    rec = _window_log().get(day.isoformat()) or {}
    w = rec.get(which)
    return tuple(w) if isinstance(w, list) and len(w) == 3 else LADDER[0]


def remember_window(used, now=None):
    """记下今天快照实际用的窗口（ledger_snapshot.py 生成实时快照时调）。只在有变化时写。"""
    day = her_today(now).isoformat()
    log = _window_log()
    used = list(used)
    rec = log.get(day) or {}
    mn = rec.get('min') or used
    mx = rec.get('max') or used
    new = {'min': [min(a, b) for a, b in zip(mn, used)], 'max': [max(a, b) for a, b in zip(mx, used)]}
    if rec == new:
        return False
    log[day] = new
    log = {k: log[k] for k in sorted(log)[-30:]}
    p = WS / WINDOW_LOG
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.tmp')
    tmp.write_text(json.dumps(log, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.replace(tmp, p)
    return True


def leaving(today, root=None):
    """今天刚滑出中期窗口的事件线（昨天还能看到简述或一句话，今天看不到了）：睡眠整理要把它们写进「我的经历」。
    用的是那两天快照实际渲染过的窗口（缩过窗就按缩过的算）：昨天按最宽的，今天按最窄的，宁可多报不漏。"""
    y = today - dt.timedelta(days=1)
    wy, wt = window_for(y, 'max'), window_for(today, 'min')
    return [t for t in load_threads(root) if t.visible(y, wy) and not t.visible(today, wt)]


def cmd_leaving(a):
    today = dt.date.fromisoformat(a.day) if a.day else her_today()
    for t in leaving(today, a.root):
        print(say("midLeaving", name=t.path.name, title=t.title, dates_label=t.dates_label(), one_line=t.one_line()))


def cmd_show(a):
    print(render(a.root)[0])


def cmd_list(a):
    today = her_today()
    mark = {'month': say("midMonthOnly"), 'mtime': say("midNoDate")}
    for t in sorted(load_threads(a.root), key=lambda t: t.age(today)):
        nxt = say("midListNext", next=t.next) if t.next else ''
        print(say("midListLine", age=t.age(today), tier=t.tier(today) or '-', kind=say("midKindMeta") if t.has_meta else say("midKindGuess"), status=t.status, title=t.title, mark=mark.get(t.last_prec, ''), nxt=nxt))


def cmd_build(a):
    text, used = render(a.root)
    out = (Path(a.root) if a.root else WS) / 'memory/recent.md'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(say("midRecentFile", now=dt.datetime.now(TZ), text=text), encoding='utf-8')
    print(say("midBuilt", out=out, size=len(text), used=used[0], used2=used[1], used3=used[2]))


def main():
    ap = argparse.ArgumentParser(description=say("midHelp"), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', help=say("midRootHelp"))
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('show').set_defaults(f=cmd_show)
    sub.add_parser('list').set_defaults(f=cmd_list)
    sub.add_parser('build').set_defaults(f=cmd_build)
    s = sub.add_parser('leaving'); s.add_argument('day', nargs='?'); s.set_defaults(f=cmd_leaving)
    a = ap.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
