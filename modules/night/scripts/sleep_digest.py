#!/usr/bin/python3
"""睡眠整理的材料：把她一天（凌晨 4 点到次日 4 点）的原始记录汇成一份，给整理者读。

  sleep_digest.py pending [--no-write]      还没整理的日子，从最早的一天起，一行一个（没有就不输出）。
                                             一点内容都没有的日子（没消息、没笔记、没新「经过」）脚本直接记成整理完
                                             （state.json 的 empty），不列出来；--no-write 只看不记。
  sleep_digest.py YYYY-MM-DD                做这一天的材料：sleep/<日期>/input.md 和 sources.json，打印各部分字数
  sleep_digest.py done YYYY-MM-DD           记下这一天整理完了。这一天的夜里（次日凌晨 2 点）还没到就拒绝；
                                             材料不完整就拒绝并记一次推迟；同一天已经推迟过两晚，第三晚照样记完成，
                                             在 state.json 的 deferred 里写明材料不全
  sleep_digest.py defer YYYY-MM-DD 原因      只记一次推迟（比如省电模式），不标完成
测试用的参数：--root DIR（材料、state.json 都读写 DIR 下的 sleep/）、--ws DIR（从别的工作目录读源文件）、
  --db PATH（OpenClaw 的对话库）、--honcho URL（只用来算覆盖率）、--now 时间（假装现在是几点，必须和 --root 一起用）。
退出码：0 正常；3 材料不完整（input.md 照样写，第 2 行写缺什么）或 done 因材料不完整被拒；2 用法错或被拒。

「要整理的最后一天」：凌晨 4 点前跑是她正在结束的这一天，4 点后跑是前一天（5:30 补跑时用）。

input.md 开头：第 1 行标题；第 2 行一定是「材料：完整」或「材料：不完整（缺：…）」；然后是捕获覆盖率、提醒和来源标签说明。
内容：
  1. 和每个人的对话（原话）：OpenClaw 自己的对话记录（transcript，只读打开 SQLite）加上 memory/compactions/ 里
     压缩时切掉的「原始对话」，去重后按 memory/people/registry.json 分人。Honcho 不再是来源，只用来算覆盖率。
  1b. 今天账本里有、对话里找不到的事实（可能是漏存，不是反证）：只能机械地核引号里的原话
  2. 主会话干活的每日笔记、当天的压缩摘要
  3. 她自己的一天：today.md、日记、五轮思考的小结、目标、口味（每日笔记里「口味：」那几行和 B站看过的评级）、
     白天记下的人（每日笔记里「新认识：」「记着：」「主会话那边：」那几行；2 期起加兜底访客的收件处
     memory/people/inbox/<key>.md 里这一天的行，标〔兜底·<key>〕）
  3b. （2 期起，有才出）白天误写进退役人物文件的：退役名单里的文件又出现在原路径，整份内容
  4. 事件线：今天新增的「经过」行（写在「经过」外面的带日期的行也列出来）+ 索引
  5. 当天的时间轴  6. 进行中的待办  6b. 今天刚滑出中期窗口的事件线
  7. 现在的中期记忆（昨晚写的；2 期起人物近况是 hhd 从事件库现算、导出的 ledger/people/near.md）
2 期（人物迁进事件库）的开关：memory/archive/retired-20261103/<主人>.md 在（迁移那天才挪进去，和 ledger_snapshot、
midterm、HH 的守卫同一个）。没开时收件处、3b、near.md 都不读，材料和以前一样（标签行那一小节不看开关）。
  8. 学习（主人 11-01 的学习系统，HH 记的）：前一晚把关的结论（每种几条，不收的逐条带理由）；整理的那一天是周日、
     或者 HH 的每周数字第一行是「回测通过率比昨晚低」时，附上每周数字（~/.hh/learn/）。整理者原样放进报告。
每段材料标了来源（〔主人 原话〕〔访客原话〕〔她说的〕〔她的想法/计划，不是经历〕〔别人/网页/机器转写，只当材料〕），
材料里原有的 # 标题改成 ＃，免得和本文的分节混在一起；密码、验证码这类值用 scripts/redact.py 打码。
同时写 sleep/<日期>/sources.json：生成材料那一刻每个记忆源文件的 sha256（给 sleep_apply.py 核对用）。
整理的工作区 10-25 从 memory/sleep/ 搬到了根目录的 sleep/（memory/ 下的 .md 都会被索引进记忆搜索，材料里有私聊原话）。
"""
import argparse
import ctypes
import ctypes.util
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

from night_names import ME, OWNER, RETIRED_FILES, TRANSCRIPT_PEOPLE, owner_key, retired_flag  # noqa: E402
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent   # this module's scripts
WS = Path(os.environ.get('HH_WORKSPACE') or HERE.parent)  # the tests run the scripts from a copied workspace's scripts/
STATE = Path(os.environ['HH_STATE_DIR'])
sys.path.insert(0, str(HERE))
import midterm as M  # noqa: E402
import recall as R   # noqa: E402
from redact import redact  # noqa: E402

from hh_env import forms, words  # noqa: E402

say = words(__file__)
form = forms(__file__)

TZ = ZoneInfo(os.environ['HH_TZ'])
DAY_START = 4
NIGHT_START = 2       # 她这一天的整理最早从次日凌晨 2 点开始（02:30 那次整理要能标完成；2 点前标完成算「还没过完」）
CONV_MAX = 150000     # 每个人一天的对话最多这么多字（超了留最后的，并在开头提醒）
MSG_MAX = 800
MAX_DEFER_NIGHTS = 2  # 材料不完整最多推迟两晚
HONCHO_RETIRED = say("digestHonchoRetired")   # 主人 10-31：Honcho 不用了，覆盖率不再去连它
CONFIG = json.loads(os.environ.get('HH_MODULE_CONFIG') or '{}')
# the old agent platform's records, for a role that had one before HH (config legacyAgentDb); none = there is no such file
NO_LEGACY = STATE / 'no-legacy-agent.sqlite'   # the path when there is none
DB_DEFAULT = Path(CONFIG.get('legacyAgentDb') or NO_LEGACY)
MAIN_KEY = 'agent:main:main'

ROOT = None           # --root：材料和 state.json 写到这里（测试）
DB = DB_DEFAULT
NOW = None            # --now（测试）

LABEL_HER = say("digestLabelHers")
LABEL_PLAN = say("digestLabelPlan")
LABEL_OTHER = say("digestLabelOther")
LABEL_LAST = say("digestLabelLast")
OWNER_KEY = owner_key(WS)
# the source tags of what a person said themselves: the owner and the people whose whole conversations HH keeps
PERSON_LABEL = {OWNER_KEY: say("digestLabelOwnerWords", first=OWNER[:1].upper(), rest=OWNER[1:]), **{k: say("digestLabelPersonWords", n=n) for k, n in TRANSCRIPT_PEOPLE.items()}}
# 2 期（人物迁进事件库）：迁移那天这 11 个文件挪进 memory/archive/retired-20261103/<memory/ 下的相对路径>（计划 P9）
RETIRED_FLAG = retired_flag(OWNER_KEY)
RETIRED_PEOPLE = RETIRED_FILES
PEOPLE_NEAR = 'ledger/people/near.md'     # hhd 从事件库现算、导出的人物近况
PEOPLE_OLD = 'memory/midterm/people.md'   # 迁移前夜里写的人物近况
INBOX_DIR = 'memory/people/inbox'         # 兜底访客的收件处（一行 `- MM-DD HH:MM …`）
PEOPLE_TAGS = form.every("peopleTags")   # 白天每日笔记里关于人的标签行（新认识、记着、主会话那边；every language's）
LEGEND = (say("digestLegend", labels="".join(PERSON_LABEL.values())))


def now_local():
    return NOW or dt.datetime.now(TZ)


def retired_active():
    """2 期的新行为开没开：memory/archive/retired-20261103/<主人>.md 在不在（迁移那天才挪进去）。"""
    return (WS / RETIRED_FLAG).exists()


def her_day(t):
    return (t - dt.timedelta(hours=DAY_START)).date()


def her_today(now=None):
    return her_day(now or now_local())


def bounds(day):
    start = dt.datetime.combine(day, dt.time(DAY_START), TZ)
    return start, dt.datetime.combine(day + dt.timedelta(days=1), dt.time(DAY_START), TZ)


def night_id(now=None):
    """「哪一晚」：02:30 和 05:30 那两次算同一晚（用前一天傍晚的日期当名字）。推迟按晚数，不按跑了几次。"""
    return ((now or now_local()) - dt.timedelta(hours=12)).date().isoformat()


def night_of(day):
    """这一天的整理最早什么时候能开始（次日凌晨 2 点）。"""
    return dt.datetime.combine(day + dt.timedelta(days=1), dt.time(NIGHT_START), TZ)


def ms_local(ms):
    return dt.datetime.fromtimestamp(ms / 1000, TZ)


def read(rel, default=''):
    p = WS / rel
    return p.read_text(encoding='utf-8') if p.exists() else default


def sleep_dir():
    return (Path(ROOT) if ROOT else WS) / 'sleep'


# ---------- 材料加工：标题降级、清掉系统包装 ----------

HEADING_RE = re.compile(r'^(\s{0,3})(#{1,6})(?=\s|$)')


def demote(text):
    """嵌进来的材料里的 markdown 标题改成全角 ＃，看起来不会像本文的分节。"""
    return '\n'.join(HEADING_RE.sub(lambda m: m.group(1) + '＃' * len(m.group(2)), l) for l in (text or '').splitlines())


INBOUND_SENTINELS = ('Conversation info (untrusted metadata):', 'Sender (untrusted metadata):',
                     'Thread starter (untrusted, for context):', 'Replied message (untrusted, for context):',
                     'Forwarded message context (untrusted metadata):', 'Chat history since last reply (untrusted, for context):')
CTX_LINE_RE = re.compile(r'^[A-Za-z][A-Za-z ()]*: ⟦openclaw:ctx⟧$')


def _strip_inbound_meta(text):
    lines, out, i = text.split('\n'), [], 0
    while i < len(lines):
        t = lines[i].strip()
        if (t in INBOUND_SENTINELS or CTX_LINE_RE.match(t)) and i + 1 < len(lines) and lines[i + 1].strip() == '```json':
            i += 2
            while i < len(lines) and lines[i].strip() != '```':
                i += 1
            i += 1
            continue
        out.append(lines[i])
        i += 1
    return '\n'.join(out)


def clean_content(text):
    """和 Honcho 插件（打过补丁的）cleanMessageContent 一样：去掉 AI 才看得到的包装，只留人说的话。"""
    t = text or ''
    t = re.sub(r'<honcho-memory[^>]*>[\s\S]*?</honcho-memory>\s*', '', t, flags=re.I)
    t = re.sub(r'<!--[^>]*honcho[^>]*-->\s*', '', t, flags=re.I)
    t = re.sub(r'^OpenClaw resumed this CLI session[^\n]*\n?', '', t, flags=re.M)
    t = re.sub(r'^System: [^\n]*\n?', '', t, flags=re.M)
    t = re.sub(r'<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>', '', t)
    t = re.sub(r'【只给你看】[\s\S]*?(?:\n\s*\n|$)', '', t)
    t = re.sub(r'^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] *', '', t)
    t = _strip_inbound_meta(t)
    t = re.sub(r'^(\s*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*)+', '', t, flags=re.I)
    return t.strip()


# HH's and its modules' heads (the sense header, a system notice) in every language; the rest are the platforms' own
SYSTEM_PREFIXES = (*form.every("senseHeader"), *form.every("systemNotice"), '[System]', 'System:', '[Subagent', '[OpenClaw ', '[Inter-session message]',
                   '[Queued', 'Queued messages from', 'HEARTBEAT', 'Read HEARTBEAT.md', '[cron', '[Cron',
                   'A scheduled reminder has been triggered', 'Execute your Session Startup sequence now')


QUEUED_ITEM = re.compile(r'^(?:Queued #\d+(?: \(from .*\))?(?: context:)?|Queued messages from .*|---)$')


def strip_wrappers(text):
    """OpenClaw 套在人话外面的系统包装（排队合并的标题、「[System]」通知行）去掉，人说的话留下。"""
    t = text or ''
    queued = '[Queued' in t or re.search(r'(?m)^Queued (?:#\d+|messages from)', t)
    out = []
    for line in t.split('\n'):
        s = line.strip()
        if s.startswith('[System]') or s.startswith('[Queued'):
            continue
        if queued and QUEUED_ITEM.match(s):
            continue
        out.append(line)
    return '\n'.join(out).strip()


def is_system(text):
    t = (text or '').lstrip()
    return any(t.startswith(p) for p in SYSTEM_PREFIXES)


def her_noise(text):
    """她那边不是对人说的话：空、NO_REPLY、英文内部旁白（和 recall.py 同一个规则）。"""
    t = (text or '').strip()
    if not t or t in ('NO_REPLY', 'HEARTBEAT_OK') or t.startswith('[Inter-session message]'):
        return True
    return bool(R.SPEECH) and len(re.findall(R.SPEECH, t)) < max(2, len(t) * 0.05)


def display(text):
    """一条消息变成一行：语音、文件、图片换成说明。"""
    t = text
    voice = re.match(r'^\[Audio transcript[^\]]*\]:\s*"?([\s\S]*?)"?\s*$', t)
    if voice:
        t = say("digestVoice", group=voice.group(1))
    t = re.sub(r'<file name="([^"]*)">[\s\S]*?</file>', lambda m: say("digestFile", group=m.group(1)), t)
    t = re.sub(r'\[media attached[^\]]*\]', say("digestPicture"), t)
    t = re.sub(r'\s*\n\s*', ' ', t).strip()
    return t if len(t) <= MSG_MAX else t[:MSG_MAX] + '…'


def norm(text):
    return re.sub(r'\s+', '', redact(text or '')).lower()


FILE_RE = re.compile(r'<file name="([^"]*)">[\s\S]*?</file>')


def canon(text):
    """和 Honcho 里存的比对用：去掉系统包装，附件换成〔文件 名〕（补存的时候就是这么存的），再去空白、打码。"""
    return norm(FILE_RE.sub(lambda m: f'〔文件 {m.group(1)}〕', strip_wrappers(text or '')))


# ---------- 人物表 ----------

class People:
    def __init__(self, reg=None):
        self.reg = R.registry() if reg is None else reg
        self.by_sender, self.by_key = {}, {}
        self.owner = None
        for who, p in self.reg.items():
            for s in p.get('senders', []):
                self.by_sender[str(s).lower()] = who
                self.by_sender[str(s).lower().lstrip('+')] = who
            for k in p.get('sessionKeys', []):
                self.by_key[k] = who
            if p.get('privacy') == 'owner' and not self.owner:
                self.owner = who

    def name(self, who):
        return self.reg.get(who, {}).get('name', who) if who else say("digestUnregistered")

    def of_sender(self, sender):
        s = str(sender or '').strip().lower()
        return self.by_sender.get(s) or self.by_sender.get(s.lstrip('+'))

    def honcho_sessions(self, who):
        return set(self.reg.get(who, {}).get('honchoSessions', {}).values())

    def honcho_peers(self, who):
        return set(self.reg.get(who, {}).get('honchoPeers', []))


def load_people():
    try:
        return People()
    except (OSError, ValueError):   # 人物表坏了：照样出材料（全部算没登记），build() 会标材料不完整
        return People(reg={})


def honcho_session_id(session_key, agent='main'):
    """和 Honcho 插件的 buildSessionKey 一样，把 OpenClaw 的会话名换成 Honcho 会话 id。"""
    n = (session_key or 'default').strip() or 'default'
    low = n.lower()
    if ':subagent:' in low:
        cls = 'subagent'
    elif low.startswith(f'agent:{agent}:cron:') or ':cron:' in low:
        cls = 'cron'
    elif ':thread:' in low:
        cls = 'thread'
    elif re.match(r'^agent:[^:]+:[^:]+', n):
        cls = 'chat'
    else:
        cls = 'unknown'
    m = re.match(r'^agent:[^:]+:([^:]+)', n)
    prov = m.group(1).lower() if m else None
    digest = hashlib.sha256(f'{agent}\0{n}'.encode()).hexdigest()[:24]
    parts = [cls] + ([prov] if prov and cls not in ('cron', 'subagent') else []) + [agent, digest]
    return '-'.join(parts)


# ---------- 对话：transcript ----------

class MaterialError(Exception):
    pass


_ZSTD = None


def _zstd_lib():
    global _ZSTD
    if _ZSTD is None:
        _ZSTD = False
        for cand in ('/opt/homebrew/lib/libzstd.1.dylib', '/opt/homebrew/lib/libzstd.dylib',
                     '/usr/local/lib/libzstd.1.dylib', ctypes.util.find_library('zstd')):
            if cand and (cand.startswith('lib') or os.path.exists(cand)):
                try:
                    lib = ctypes.CDLL(cand)
                    lib.ZSTD_decompress.restype = ctypes.c_size_t
                    lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
                    lib.ZSTD_isError.restype = ctypes.c_uint
                    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
                    _ZSTD = lib
                    break
                except OSError:
                    continue
    return _ZSTD


def zstd_decompress(blob, size):
    """有的事件是 zstd 压过的：Python 3.14+ 用自带模块，3.9 用 libzstd（ctypes），再不行用 zstd 命令。"""
    try:
        from compression import zstd as Z  # type: ignore
        return Z.decompress(blob)
    except ImportError:
        pass
    lib = _zstd_lib()
    if lib:
        out = ctypes.create_string_buffer(max(int(size or 0), 1))
        n = lib.ZSTD_decompress(out, len(out), blob, len(blob))
        if lib.ZSTD_isError(n):
            raise ValueError(say("digestZstdFailed"))
        return out.raw[:n]
    exe = shutil.which('zstd') or '/opt/homebrew/bin/zstd'
    r = subprocess.run([exe, '-d', '-c', '-q'], input=bytes(blob), capture_output=True, timeout=30)
    if r.returncode != 0:
        raise ValueError(say("digestZstdCmdFailed"))
    return r.stdout


def open_db():
    if not Path(DB).exists():
        raise MaterialError(say("digestNoDb", db=DB))
    try:
        conn = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=30)
        conn.execute('PRAGMA query_only=1')
        conn.execute('select 1 from transcript_events limit 1').fetchall()
        return conn
    except sqlite3.Error as e:
        raise MaterialError(say("digestNoTranscript", e=e))


def text_of(content, images=True):
    """消息正文。images=False 时和 Honcho 插件一样只取文字块（比对用）。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ''
    parts = []
    for p in content:
        if not isinstance(p, dict):
            continue
        if p.get('type') == 'text' and isinstance(p.get('text'), str):
            parts.append(p['text'])
        elif p.get('type') == 'image' and images:
            parts.append(say("digestPictureOnly"))
    return '\n'.join(parts)


def old_sender(raw):
    """2026-10-09 以前的 QQ 消息：发送人写在正文里的 Conversation info JSON 里。"""
    m = re.search(r'Conversation info \(untrusted metadata\):\s*\n```json\n([\s\S]*?)\n```', raw or '')
    if not m:
        return ''
    try:
        d = json.loads(m.group(1))
        return str(d.get('sender_id') or d.get('sender') or '')
    except ValueError:
        return ''


def her_sends(m):
    """message 工具发出去的话：[(文字, 目标)]。2026.10.3 起是 role=custom 的 nested-tool，老版本在 assistant 的 toolCall 里。"""
    out = []
    if m.get('role') == 'custom':
        d = m.get('details') or {}
        if d.get('toolName') == 'message':
            out.append(d.get('input') or {})
    if m.get('role') in ('assistant', 'custom') and isinstance(m.get('content'), list):
        for p in m['content']:
            if isinstance(p, dict) and p.get('type') in ('toolCall', 'tool_use') and p.get('name') == 'message':
                out.append(p.get('arguments') or p.get('input') or {})
    res = []
    for a in out:
        if not isinstance(a, dict) or a.get('action') not in ('send', None):
            continue
        msg = a.get('message') if isinstance(a.get('message'), str) else ''
        if not msg.strip():
            if a.get('media') or a.get('asVoice') or a.get('filePath') or a.get('path'):
                msg = say("digestSentMedia")
            else:
                continue
        res.append((msg.strip(), str(a.get('target') or a.get('to') or '')))
    return res


class Entry:
    __slots__ = ('ts', 'minute_only', 'block', 'speaker', 'who', 'kind', 'text', 'raw', 'src', 'seq', 'hsid', 'console',
                 'match')

    def __init__(self, ts, block, speaker, who, kind, raw, src, seq=0, minute_only=False, hsid=None, console=False,
                 match=None):
        self.ts, self.block, self.speaker, self.who, self.kind = ts, block, speaker, who, kind
        self.raw, self.text, self.src, self.seq = raw, display(raw), src, seq
        self.minute_only, self.hsid, self.console = minute_only, hsid, console
        self.match = canon(match if match is not None else raw)   # 和 Honcho 比对用的写法

    def minute(self):
        return self.ts.strftime('%m-%d %H:%M')

    def key(self):
        first = (self.raw.strip().split('\n') or [''])[0]
        return (self.block, 'human' if self.kind == 'human' else 'her', self.minute(), norm(first)[:40])


def transcript_entries(people, start, end, stats):
    """时间段里所有人的会话消息（人说的 + 她回的），按会话主人分组。读不到就抛 MaterialError。"""
    conn = open_db()
    pad = 3 * 3600 * 1000
    s_ms, e_ms = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    keys = {}
    try:
        for sid, skey in conn.execute('select session_id, session_key from session_windows'):
            if skey in people.by_key or re.match(r'^agent:[^:]+:(?:[^:]+:)*direct:', skey or ''):
                keys[sid] = skey
        rows = []
        for sid, skey in keys.items():
            rows += [(skey,) + tuple(r) for r in conn.execute(
                'select seq, created_at, event_json, event_zstd, event_utf8_bytes, navigation_json '
                'from transcript_events where session_id=? and created_at between ? and ?', (sid, s_ms - pad, e_ms + pad))]
    except sqlite3.Error as e:
        raise MaterialError(say("digestNoTranscript", e=e))
    finally:
        conn.close()
    out = []
    last_person = {}
    rows.sort(key=lambda r: (r[0], r[2], r[1]))   # 同一个会话名可能有好几个 session_id：按时间排
    for skey, seq, created, ej, ez, size, nav in rows:
        if ej is None:
            try:
                role = json.loads(nav or '{}').get('navigation', {}).get('message', {}).get('role')
            except ValueError:
                role = None
            if role not in (None, 'user', 'assistant', 'custom'):
                continue
            try:
                ej = zstd_decompress(ez, size).decode('utf-8')
            except Exception:  # noqa: BLE001 — 解压不了就算材料不完整
                stats['bad'] += 1
                continue
        try:
            e = json.loads(ej)
        except ValueError:
            stats['bad'] += 1
            continue
        if e.get('type') != 'message' or not isinstance(e.get('message'), dict):
            continue
        m = e['message']
        ts = m.get('timestamp') if isinstance(m.get('timestamp'), (int, float)) else created
        when = ms_local(ts)
        owner = people.by_key.get(skey)
        hsid = honcho_session_id(skey)
        role = m.get('role')
        if role == 'user':
            oc = m.get('__openclaw') or {}
            raw = text_of(m.get('content'))
            sender = str(oc.get('senderId') or '') or old_sender(raw)
            txt = strip_wrappers(clean_content(raw))
            if not txt:
                continue
            who = people.of_sender(sender)
            console = False
            if who:
                speaker = people.name(who)
            elif sender and (sender == 'gateway-owner' or oc.get('senderIsOwner')):
                who, console, speaker = people.owner, True, say("digestConsole", name=people.name(people.owner))
            elif not sender:
                if is_system(raw) or not (oc.get('transport') or {}).get('channel'):
                    continue
                speaker = say("digestUnregisteredOn", channel=(oc.get('transport') or {}).get('channel'))
            else:
                speaker = say("digestUnregisteredOn", channel=(oc.get('transport') or {}).get('channel') or '?')
            if is_system(txt):
                continue
            block = owner or who or '_unknown'
            last_person[skey] = block
            out.append(Entry(when, block, speaker, who, 'human', txt, 'tx', seq, hsid=hsid, console=console,
                             match=clean_content(text_of(m.get('content'), images=False))))
        elif role in ('assistant', 'custom'):
            block_default = owner or last_person.get(skey) or '_unknown'
            if role == 'assistant':
                txt = clean_content(text_of(m.get('content')))   # 只取 text 块：thinking、toolCall 不算她说的话
                if txt and not her_noise(txt):
                    out.append(Entry(when, block_default, say("digestMe"), None, 'her', txt, 'tx', seq, hsid=hsid))
            for msg, target in her_sends(m):
                block = people.of_sender(target) or block_default
                out.append(Entry(when, block, say("digestMe"), None, 'her', msg, 'tx', seq, hsid=hsid))
    return out


# ---------- 对话：压缩存档里的「原始对话」 ----------

ARC_LINE = re.compile(rf'^\[(\d\d)-(\d\d) (\d\d):(\d\d)\] (用户|{re.escape(ME)}|{re.escape(ME)}调用 message): ?(.*)$')
ARC_RANGE = re.compile(r'压掉的范围：(\d{4}-\d\d-\d\d \d\d:\d\d) → (\d{4}-\d\d-\d\d \d\d:\d\d)')


def _arc_send(args_text):
    try:
        a = json.loads(args_text)
        if isinstance(a, dict):
            return her_sends({'role': 'custom', 'details': {'toolName': 'message', 'input': a}})
    except ValueError:
        pass
    m = re.search(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)', args_text)   # 存档里截到 2000 字，JSON 可能不完整
    if not m:
        return []
    try:
        msg = json.loads('"' + m.group(1) + '"')
    except ValueError:
        msg = m.group(1)
    t = re.search(r'"target"\s*:\s*"([^"]*)"', args_text)
    return [(msg.strip(), t.group(1) if t else '')] if msg.strip() else []


def archive_entries(people, start, end, stats):
    """memory/compactions/*.md 的「原始对话」：主会话压缩时切掉的部分（只到分钟；老存档多行消息只留了第一行）。"""
    out = []
    owner = people.by_key.get(MAIN_KEY) or people.owner
    hsid = honcho_session_id(MAIN_KEY)
    for p in sorted((WS / 'memory/compactions').glob('*.md')):
        fm = re.match(r'(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)', p.stem)
        if not fm:
            continue
        try:
            text = p.read_text(encoding='utf-8')
        except OSError as e:
            stats['missing'].append(say("digestArchiveUnreadable", name=p.name, e=e))
            continue
        rg = ARC_RANGE.search(text[:600])
        if rg:
            a = dt.datetime.strptime(rg.group(1), '%Y-%m-%d %H:%M').replace(tzinfo=TZ)
            b = dt.datetime.strptime(rg.group(2), '%Y-%m-%d %H:%M').replace(tzinfo=TZ)
            if b < start - dt.timedelta(hours=1) or a > end + dt.timedelta(hours=1):
                continue
        if '## 原始对话' not in text:
            continue
        year, fmonth = int(fm.group(1)), int(fm.group(2))
        cur = None
        for line in text.split('## 原始对话', 1)[1].splitlines():
            m = ARC_LINE.match(line)
            if not m:
                if cur is not None and line.startswith('  '):   # 2026-10-25 起多行消息的后续行缩进两格
                    cur[3].append(line[2:])
                continue
            if cur is not None:
                out += _arc_make(people, owner, hsid, cur, start, end)
            mo, d, h, mi, kind, body = m.groups()
            y = year - 1 if int(mo) > fmonth else year
            try:
                when = dt.datetime(y, int(mo), int(d), int(h), int(mi), tzinfo=TZ)
            except ValueError:
                cur = None
                continue
            cur = [when, kind, p.name, [body]]
        if cur is not None:
            out += _arc_make(people, owner, hsid, cur, start, end)
    return out


def _arc_make(people, owner, hsid, cur, start, end):
    when, kind, name, lines = cur
    if not (start <= when < end):
        return []
    body = '\n'.join(lines)
    if kind == '用户':
        txt = strip_wrappers(clean_content(body))
        if not txt or is_system(txt):
            return []
        return [Entry(when, owner, people.name(owner), owner, 'human', txt, 'arc', minute_only=True, hsid=hsid)]
    if kind == ME:
        txt = clean_content(body)
        return [] if her_noise(txt) else [Entry(when, owner, say("digestMe"), None, 'her', txt, 'arc', minute_only=True, hsid=hsid)]
    return [Entry(when, people.of_sender(t) or owner, say("digestMe"), None, 'her', msg, 'arc', minute_only=True, hsid=hsid)
            for msg, t in _arc_send(body)]


HH_CUTOVER = dt.datetime(2026, 10, 29, 0, 38).astimezone()   # 这之后她的对话在 Human Harness 的中央记忆里
HH_HONCHO_BACK = HH_CUTOVER   # HH 的真人消息也写进 Honcho（10-29 21:05 起实时写；00:38–21:05 那段当晚按原时间戳补写了，metadata backfill:true）


def hh_honcho_session(people, who):
    """HH 写 Honcho 用的会话：和 human-harness/src/memory/honcho.ts 一样，<名字>-main，没有就第一个不是 history- 的。"""
    ss = people.reg.get(who, {}).get('honchoSessions') or {}
    return ss.get(f'{who}-main') or next((v for v in ss.values() if not str(v).startswith('history-')), None)


def hh_entries(people, start, end, stats):
    """2026-10-29 起：Human Harness 中央记忆里的对话（人说的 + 她发出去的），按人分组。"""
    if end <= HH_CUTOVER:
        return []
    import hh_messages
    try:
        recs = hh_messages.load(int(start.timestamp() * 1000), int(end.timestamp() * 1000), reg=people.reg)
    except Exception as e:  # noqa: BLE001 — 读不到就算材料不完整
        stats['missing'].append(say("digestNoCentral", e=e))
        return []
    out = []
    for r in recs:
        when, who = ms_local(r['ts']), r['who']
        if r['dir'] == 'in':
            console = r.get('channel') == 'app'
            speaker = people.name(who) + (say("digestConsoleMark") if console else '') if who else say("digestUnregisteredOn", channel=r.get('channel') or '?')
            hsid = hh_honcho_session(people, who) if who and when >= HH_HONCHO_BACK else None
            out.append(Entry(when, who or '_unknown', speaker, who, 'human', r['text'], 'hh', r['seq'], console=console, hsid=hsid))
        else:
            out.append(Entry(when, who or '_unknown', say("digestMe"), None, 'her', r['text'], 'hh', r['seq']))
    return out


# ---------- HH：她做事的过程（2026-10-29 起，补回 OpenClaw 时代「主会话干活的记录」那一层） ----------

HH_SKIP_TOOLS = {'message', 'jot_down', 'meanwhile', 'ToolSearch'}   # 前三个在「记下 / 发出的话」里已经有了
HH_SELF_TOOLS = {'hands', 'remind', 'goals', 'on_it', 'done_with', 'think_it_over', 'ack', 'computer'}   # 她的决定：入参照原样
HH_WORK_CAP = 40000      # 切 HH 前第 1 节有她的文字回复、第 2 节有压缩摘要（合起来约 7 万字）；HH 里这些都在这一节和翻页块里
HOME_DIR = os.path.expanduser('~')


def _flat(text):
    """压成一行（只合并空白，标点保留；squash 是给比对用的，会去掉标点）"""
    return re.sub(r'\s+', ' ', str(text)).strip()


HH_CONFIG = Path(os.environ.get('HH_CONFIG') or STATE / 'config.json')   # 读 memory.promptFolds（进提示前折成一句的表，跟 HH 那边是同一张；测试换成临时文件）


def prompt_folds():
    """HH 配置里的 memory.promptFolds：[{find, say, word?}]；读不到、没配、配坏了给 []（材料照旧出）"""
    try:
        raw = json.loads(HH_CONFIG.read_text(encoding='utf-8'))
        fs = (raw.get('memory') or {}).get('promptFolds') or []
    except Exception:
        return []
    out = []
    for f in fs:
        if not (isinstance(f, dict) and isinstance(f.get('find'), str) and f['find'].strip() and isinstance(f.get('say'), str)):
            continue
        try:   # from / until：只在这段时间里的记录上认（本地时间「2026-11-13 16:20」、带时区的 ISO 或毫秒）；写坏了这一条不用
            g = dict(f, _from=_fold_time(f.get('from')), _until=_fold_time(f.get('until')))
        except (ValueError, TypeError):
            continue
        out.append(g)
    return out


def _fold_time(v):
    """-> 毫秒或 None；跟 HH 的 parseTime 一样：数字是毫秒，带时区的 ISO 照它，没写时区的按她的时区"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()
    if re.search(r'[zZ]$|[+-]\d{2}:?\d{2}$', s):
        return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?', s)
    if not m:
        raise ValueError(s)
    d = dt.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4] or 0), int(m[5] or 0), tzinfo=TZ)
    return int(d.timestamp() * 1000)


def _fold_usable(f, start=None, end=None):
    """不限时间的总能用；限了时间的要跟 [start, end] 有重叠，不知道时间就不用"""
    if f.get('_from') is None and f.get('_until') is None:
        return True
    if start is None:
        return False
    end = start if end is None else end
    return (f['_until'] is None or start <= f['_until']) and (f['_from'] is None or end >= f['_from'])


def _fold_hit(text, folds, start=None, end=None):
    t = (text or '').lower()
    return next((f for f in folds if f['find'].lower() in t and _fold_usable(f, start, end)), None)


def fold_text(text, folds, human=False, ts=None):
    """跟 HH 的 src/memory/folds.ts 同一个规矩（运维 11-13）：真人的话只把命中的那几个字换成短语（word，没有就 say），别的命中就整条换成 say"""
    if not folds or not text:
        return text
    if human:
        for f in folds:
            if _fold_usable(f, ts):
                text = re.sub(re.escape(f['find']), lambda _m, f=f: f.get('word') or f['say'], text, flags=re.IGNORECASE)
        return text
    f = _fold_hit(text, folds, ts)
    return f['say'] if f else text


def fold_lines(text, folds, start=None, end=None):
    """压缩块：命中的那一行整行换成 say（留着行首的「- 」），别的行原样；start / end 是那一页的起止（限时间段的条目按它判）"""
    if not folds or not text:
        return text
    out = []
    for line in text.split('\n'):
        f = _fold_hit(line, folds, start, end)
        if f:
            lead = re.match(r'^(\s*[-*]\s+)', line)
            out.append((lead.group(1) if lead else '') + f['say'])
        else:
            out.append(line)
    return '\n'.join(out)


def _is_human(kind, meta):
    if kind != 'input' or not meta:
        return False
    try:
        return (json.loads(meta) or {}).get('human') is True
    except Exception:
        return False


def hh_rows(start, end, db=None):
    """-> (中央记忆里这段时间的记录, 这段时间写下的翻页压缩块)。读不到抛 MaterialError。"""
    import hh_messages
    s, e = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
    try:
        conn = sqlite3.connect(f"file:{db or hh_messages.DB}?mode=ro", uri=True, timeout=30)
        try:
            rows = conn.execute('select seq, ts, src, kind, text, meta from central where ts >= ? and ts < ? order by seq', (s, e)).fetchall()
            blocks = conn.execute('select created, epoch, text from blocks where created >= ? and created < ? order by created', (s, e)).fetchall()
        finally:
            conn.close()
    except sqlite3.Error as ex:
        raise MaterialError(say("digestNoCentralEx", ex=ex))
    folds = prompt_folds()   # 进材料前也过同一张折叠表（库里照原样）
    if folds:
        rows = [(seq, ts, src, kind, fold_text(text, folds, _is_human(kind, meta), ts), meta) for seq, ts, src, kind, text, meta in rows]
        # 压缩块按那一页的起止判：上一块压完是这一页开始（这段时间的第一块从这段的开头算）
        starts = [s] + [b[0] for b in blocks[:-1]]
        blocks = [(created, epoch, fold_lines(text, folds, start, created)) for (created, epoch, text), start in zip(blocks, starts)]
    return rows, blocks


def hh_tasks(db=None):
    """并行大脑的 tasks 表（迁移 v5 加的）：[(owner, topic, started, ended)]。表还没有、读不到就是空的。"""
    import hh_messages
    try:
        conn = sqlite3.connect(f"file:{db or hh_messages.DB}?mode=ro", uri=True, timeout=30)
        try:
            return conn.execute('select owner, topic, started, ended from tasks').fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []


def _hh_who(src, ts=None, meta=None, tasks=()):
    """谁做的：都是她自己。后台的按「弄什么时」标（tasks 表里它名下、这一刻在做的那件），不写结构词（10-31 定）。"""
    if src == 'main':
        return say("digestMe")
    if src.startswith('side-'):
        for owner, topic, started, ended in tasks:
            if owner == src and ts is not None and started <= ts and (ended is None or ts <= ended):
                return say("digestMeOnTopic", topic=topic)
        return say("digestMe")
    if src.startswith('perception'):
        return say("digestMeSubconscious")
    if src == 'deep' and (meta or {}).get('insight'):
        return say("digestMe")      # 潜意识想通的结论；它的过程是 inner，不进材料
    return None   # 海马（压缩/整理的产出另有一节）、外界（在第 1 节）


def _hh_act(text, meta):
    """act 记录 -> (工具名, 入参 dict 或 None, 入参原文)。记录形如「工具名 {json}」，json 超过 2000 字会被截断。"""
    tool, _, raw = text.partition(' ')
    tool = (meta or {}).get('tool') or tool
    tool = re.sub(r'^mcp__self__', '', tool)
    try:
        args = json.loads(raw)
    except ValueError:
        args = None
    return tool, args if isinstance(args, dict) else None, raw


def _hh_brief(args, raw):
    """内置 / 外部工具折成一行：description + 路径；Bash 没写 description 就取命令前 80 字。"""
    if args is None:
        return _flat(raw)[:80]
    parts = []
    if args.get('description'):
        parts.append(_flat(str(args['description'])))
    path = args.get('file_path') or args.get('path') or args.get('notebook_path')
    if path:
        parts.append(str(path).replace(HOME_DIR, '~'))
    if not parts and args.get('command'):
        parts.append(_flat(str(args['command'])).replace(HOME_DIR, '~')[:80])
    if not parts:
        for k in ('url', 'query', 'pattern', 'keyword', 'bvid', 'prompt', 'text'):
            if args.get(k):
                parts.append(_flat(str(args[k]))[:80])
                break
    return say("digestComma").join(parts)[:120]


def _hh_self_args(tool, args, raw):
    if args is None:
        return _flat(raw)[:300]
    if tool in ('think_it_over', 'ack') and args.get('what'):
        return _flat(str(args['what']))[:300]
    if tool in ('on_it', 'done_with') and args.get('topic'):
        return _flat(str(args['topic']))[:300]
    return _flat(json.dumps(args, ensure_ascii=False))[:300]


def hh_work_lines(rows, tasks=()):
    """中央记忆 -> 按时间的做事记录。返回 [(seq, 类别, 行)]，类别给超长时降级用：talk / burst / err。"""
    sent = set()
    for seq, ts, src, kind, text, meta in rows:
        m = json.loads(meta) if meta else {}
        if kind == 'note' and (m or {}).get('sent'):
            sent.add(norm(re.sub('|'.join(form.every('sentHead')), '', text)))
    out, bursts = [], {}

    def flush(src):
        b = bursts.pop(src, None)
        if not b:
            return
        counts = say("digestListSep").join(f'{t}×{n}' if n > 1 else t for t, n in b['tools'].items())
        briefs = [x for x in b['briefs'] if x][:4]
        more = len(b['briefs']) - len(briefs)
        line = say("digestBurst", t=b['t'], who=b['who'], n=b['n'], counts=counts, briefs=(say("digestBurstBriefs", briefs=say("digestSemicolon").join(briefs), more=say("digestBurstMore", more=more) if more > 0 else '')) if briefs else '')
        out.append((b['seq'], 'burst', line, counts and say("digestBurstShort", t=b['t'], who=b['who'], n=b['n'], counts=counts)))
        for e in b['errs']:
            out.append((b['seq'], 'err', f'    ✗ {e}', None))

    for seq, ts, src, kind, text, meta in rows:
        m = (json.loads(meta) if meta else None) or {}
        if m.get('inner') or kind == 'think' or m.get('gateDigest'):    # 闸门每日总结单独一小节（hh_gate_digest）
            continue
        t = ms_local(ts).strftime('%H:%M')
        if kind == 'system':
            out.append((seq, 'talk', say("digestSystemLine", t=t, flat=_flat(text)[:200]), None))
            continue
        who = _hh_who(src, ts, m, tasks)
        if not who:
            continue
        if kind == 'act':
            tool, args, raw = _hh_act(text, m)
            if tool in HH_SKIP_TOOLS:
                continue
            if tool in HH_SELF_TOOLS:
                flush(src)
                out.append((seq, 'talk', say("digestSelfTool", t=t, who=who, tool=tool, hh_self_args=_hh_self_args(tool, args, raw)), None))
                continue
            b = bursts.setdefault(src, {'seq': seq, 't': t, 'who': who, 'n': 0, 'tools': {}, 'briefs': [], 'errs': []})
            short = tool.replace('mcp__', '').replace('__', ':')
            b['n'] += 1
            b['tools'][short] = b['tools'].get(short, 0) + 1
            b['briefs'].append(_hh_brief(args, raw))
            continue
        if kind == 'result':
            if m.get('error') and src in bursts:
                bursts[src]['errs'].append(_flat(text)[:200])
            continue
        if kind in ('say', 'note'):
            if m.get('sent'):
                continue
            body = text.strip()
            if not body or re.fullmatch(r'NO_REPLY\W*', body) or (kind == 'say' and norm(body) in sent):
                continue
            flush(src)
            out.append((seq, 'talk', f"[{t} {who}{say('digestSaid') if kind == 'say' else say('digestNoted')}] {_flat(body)[:300]}", None))
    for src in list(bursts):
        flush(src)
    out.sort(key=lambda x: x[0])
    return out


def hh_work(rows, cap=HH_WORK_CAP, tasks=()):
    """超长时一步步降级（不砍掉后半天）：先去掉每步的说明只留工具计数，再缩短说的话，再去掉工具行，最后每行按平均长度截。"""
    items = hh_work_lines(rows, tasks)
    if not items:
        return say("digestNoRecords")
    stages = [
        lambda kind, line, short: line,
        lambda kind, line, short: (short or line) if kind == 'burst' else line,
        lambda kind, line, short: (short or line) if kind == 'burst' else line[:200],
        lambda kind, line, short: None if kind == 'burst' else line[:200],
        lambda kind, line, short: None if kind == 'burst' else line[:120],
    ]
    lines = []
    for stage in stages:
        lines = [x for x in (stage(k, l, s) for _, k, l, s in items) if x]
        if len('\n'.join(lines)) <= cap:
            return '\n'.join(lines)
    per = max(20, cap // max(1, len(lines)) - 1)
    return '\n'.join(l if len(l) <= per else l[:per - 1] + '…' for l in lines)[:cap]


GATE_DIGEST_CAP = 2000     # 闸门每日总结：小判断写的不超过 600 字，问不到时是材料前 1500 字


def hh_gate_digest(rows):
    """HH 睡前记的闸门每日总结（note 的 meta.gateDigest，主人 11-04 开）：整段放单独一小节，不跟做事的过程挤在一起被截成 300 字。"""
    out = []
    for seq, ts, src, kind, text, meta in rows:
        m = (json.loads(meta) if meta else None) or {}
        if kind != 'note' or not m.get('gateDigest'):
            continue
        body = re.sub(r'^（今天下意识放下的）', '', (text or '').strip()).strip()
        if body:
            out.append(f'[{ms_local(ts):%m-%d %H:%M} #{seq}]\n{demote(body[:GATE_DIGEST_CAP])}')
    return '\n\n'.join(out)


def hh_blocks_text(blocks):
    if not blocks:
        return say("digestNoPageTurn")
    return '\n\n'.join(say("digestPageTurn", ms_local=ms_local(c), ep=ep, label_her=LABEL_HER, demote=demote(t.strip())) for c, ep, t in blocks)


def hh_section(day, warnings, db=None):
    """第 2 节里 HH 的部分：翻页压缩记忆 + 做事的过程。切 HH 之前的日子返回空。"""
    start, end = bounds(day)
    if end <= HH_CUTOVER:
        return ''
    try:
        rows, blocks = hh_rows(start, end, db)
    except MaterialError as e:
        warnings.append(str(e))
        return say("digestHhRecordsFailed", e=e)
    return (say("digestHhSection", hh_blocks_text=hh_blocks_text(blocks), hh_work=hh_work(rows, tasks=hh_tasks(db)), gate_digest_text=gate_digest_text(rows)))


def gate_digest_text(rows):
    gate = hh_gate_digest(rows)
    return (say("digestGateDigest", gate=gate)) if gate else ''


def gather(day, people=None, days_before=0):
    """这一天（往前多带 days_before 天）的对话。返回 (entries, missing)；missing 非空表示材料不完整。"""
    people = people or load_people()
    start, end = bounds(day)
    start -= dt.timedelta(days=days_before)
    stats = {'bad': 0, 'missing': []}
    # the old platform's records only for a role that had one (config legacyAgentDb, or --db); without it HH's own are all
    # there is, so a day with nothing in them is empty, not short of material
    tx = []
    if DB != NO_LEGACY:
        try:
            tx = transcript_entries(people, start, end, stats)
        except MaterialError as e:
            tx = None
            stats['missing'].append(str(e))
    arc = archive_entries(people, start, end, stats)
    arc = hh_entries(people, start, end, stats) + arc
    if stats['bad']:
        stats['missing'].append(say("digestBadEvents", bad=stats["bad"]))
    entries = [e for e in (tx or []) if start <= e.ts < end]
    seen = {e.key() for e in entries}
    for e in arc:
        if e.key() in seen:
            continue
        seen.add(e.key())
        entries.append(e)
    # 她的同一句话可能既是文字回复又是 message 工具发的：两分钟内同一块里重复的只留一条
    entries.sort(key=lambda e: (e.ts, e.seq))
    kept, recent = [], {}
    for e in entries:
        if e.kind == 'her':
            k = (e.block, norm(e.raw)[:80])
            if k in recent and abs((e.ts - recent[k]).total_seconds()) < 120:
                continue
            recent[k] = e.ts
        kept.append(e)
    return kept, stats['missing']


def label_for(people, who):
    if not who or who == '_unknown':
        return LABEL_OTHER
    return PERSON_LABEL.get(who) or say("digestLabelWords", name=people.name(who))


def render_conversations(people, entries, notes):
    out = []
    blocks = list(people.reg) + sorted({e.block for e in entries if e.block not in people.reg})
    for who in blocks:
        es = [e for e in entries if e.block == who]
        title = say("digestWith", name=people.name(who)) if who != '_unknown' else say("digestWithUnregistered")
        if not es:
            if who in people.reg:
                out.append(say("digestNoTalk", title=title))
            continue
        humans = [e for e in es if e.kind == 'human']
        hers = [e for e in es if e.kind == 'her']
        speakers = sorted({e.speaker for e in humans})
        lab = say("digestListSep").join(say("digestSpeakerCount", s=s, sum=sum(1 for e in humans if e.speaker == s)) for s in speakers)
        head = (say("digestConvHead", title=title, a=len(es), lab=lab, b=say("digestListSep") if lab else "", c=len(hers), label_for=label_for(people, who if who in people.reg else None), label_her=LABEL_HER))
        lines = []
        for e in es:
            mark = '' if e.who or e.kind == 'her' else LABEL_OTHER
            lines.append(say("digestConvLine", minute=e.minute(), speaker=e.speaker, mark=mark, text=e.text))
        body = '\n'.join(lines)
        if len(body) > CONV_MAX:
            notes.append(say("digestConvTooLong", name=people.name(who), a=len(body) - CONV_MAX))
            body = say("digestConvCut", body=body[-CONV_MAX:])
        if any(e.src == 'arc' for e in es):
            body = (say("digestConvArchiveNote", body=body))
        out.append(head + '\n' + body)
    return '\n\n'.join(out)


# ---------- 捕获覆盖率（Honcho 只用在这里） ----------

def match_count(cands, items, hits=None):
    """一对一配对：每条消息（时间, 文字, 早多少秒, 晚多少秒, 只比开头）找一条还没被占用的 Honcho 消息，时间差最小的先配。
    Honcho 里的时间是那一轮开始处理的时间，比原消息晚几秒到几分钟；连发时被并进同一轮的消息则是原时间。"""
    pairs = []
    for i, (t, txt, lo, hi, prefix) in enumerate(items):
        for j, (ht, htxt) in enumerate(cands):
            d = (ht - t).total_seconds()
            if lo <= d <= hi and (htxt == txt or (prefix and txt and htxt.startswith(txt)) or
                                  (len(txt) >= 6 and txt in htxt)):
                pairs.append((abs(d), i, j))
    used_i, used_j = set(), set()
    for _, i, j in sorted(pairs):
        if i not in used_i and j not in used_j:
            used_i.add(i)
            used_j.add(j)
    if hits is not None:
        hits.update(used_i)
    return len(used_i)


def coverage(people, day, entries):
    """每个人：今天说的话（transcript + 压缩存档）有几成存进了 Honcho。读不到 Honcho 就返回说明文字。"""
    start, end = bounds(day)
    res = []
    for who in people.reg:
        mine = [e for e in entries if e.kind == 'human' and e.who == who and not e.console
                and e.hsid in people.honcho_sessions(who)]
        if not mine:
            continue
        peers = people.honcho_peers(who)
        cands = []
        for sid in sorted({e.hsid for e in mine}):
            try:
                ms = R.list_msgs(sid, R.iso(start - dt.timedelta(hours=1)), R.iso(end + dt.timedelta(hours=1)))
            except Exception as e:  # noqa: BLE001 — Honcho 读不到只影响覆盖率
                return say("digestCoverageHonchoDown", a=str(e)[:80])
            cands += [(R.utc(m['created_at']).astimezone(TZ), canon(clean_content(m['content'])))
                      for m in ms if m.get('peer_id') in peers]
        # 压缩存档的行只到分钟、只有第一行：时间放宽一分钟，只比开头
        # 排在长任务后面的消息，Honcho 记的是那一轮开始的时间，可能晚到一小时
        items = [(e.ts, canon((e.raw.split('\n') or [''])[0]), -60, 3660, True) if e.minute_only else
                 (e.ts, e.match, -10, 3600, False) for e in mine]
        hits = set()
        hit = match_count(cands, items, hits)
        n = len(mine)
        arc = [i for i, e in enumerate(mine) if e.minute_only]
        detail = ''
        if arc:   # 压缩存档里的行只到分钟、不知道是谁的渠道，Honcho 漏了也补不回来：单独列出来
            a_hit = len(hits & set(arc))
            detail = say("digestCoverageDetail", a=hit - a_hit, b=n - len(arc), a_hit=a_hit, c=len(arc))
        res.append(say("digestCoverageLine", name=people.name(who), a=hit * 100 // n, hit=hit, n=n, detail=detail, b=say("digestCoverageLow") if hit * 100 < 98 * n else ''))
    if res:
        return say("digestSemicolon").join(res)
    if any(e.kind == 'human' and e.src == 'hh' for e in entries):   # 2026-10-29 切 HH 后对话不再写 Honcho
        return say("digestCoverageNa", hh_honcho_back=HH_HONCHO_BACK)
    return say("digestNobodyTalked")


# ---------- 1b. 账本里有、对话里找不到的原话 ----------

QUOTE_RE = re.compile(form('digestQuote'))     # a quote and a word that says someone said it, in the role's language
SPEECH_RE = re.compile(form('digestSpeech'))
HE_SHE = re.compile('{0}(?:{1}){0}'.format(form('wordEdge'), '|'.join(re.escape(p) for k in ('he', 'she', 'they') for p in form('pronouns')[k])))


def squash(text):
    """比对原话用：去掉标点和空白，只留字。"""
    return re.sub(r'\W+', '', redact(text or '')).lower()


def _attributed(prefix, names):
    """引号前面 30 个字里有没有「谁说的」：人名（或他/她）加上 说/问/回/原话/冒号。"""
    p = prefix[-30:].lower()
    if form('ownWords') in p:
        return True
    who = any(n and n in p for n in names) or HE_SHE.search(p)
    return bool(who and SPEECH_RE.search(p))


def unmatched_quotes(people, ledger_lines, convo_entries):
    """账本今天的行里引了某人的原话（「…」），在今天和昨天的对话里却找不到的：可能是漏存，不是反证。
    只能机械地核引号里的原话；没加引号的转述核不了。"""
    hay = squash('\n'.join(e.raw for e in convo_entries))
    names = [people.name(w).lower() for w in people.reg] + [w.lower() for w in people.reg]
    out = []
    for src, line in ledger_lines:
        for m in QUOTE_RE.finditer(line):
            if not _attributed(line[:m.start()], names):
                continue
            frags = [squash(f) for f in re.split(r'…+|\.{3,}|⋯+', m.group(1))]
            frags = [f for f in frags if len(f) >= 4]
            if frags and any(f not in hay for f in frags):
                out.append(say("digestUnmatched", src=src, strip=line.strip()[:220], group=m.group(1)[:40]))
                break
    if not out:
        return say("digestAllMatched")
    head = (say("digestUnmatchedNote", label_her=LABEL_HER))
    return head + '\n' + '\n'.join(out[:30]) + (say("digestUnmatchedMore", a=len(out) - 30) if len(out) > 30 else '')


# ---------- 2–7：笔记、她的一天、账本 ----------

NOTE_TIME = re.compile(r'^\s*(?:[-*+]\s*)?(?:\*\*)?\[?(?:(\d{4}-\d\d-\d\d)[ T])?(\d{1,2})[:：]([0-5][0-9xX]|[xX]{1,2})(?![0-9])')


def line_day(line, file_date):
    """笔记里一行属于她的哪一天：「- 00:2x …」这种凌晨的写法算前一天；没有时间的行返回 None。"""
    m = NOTE_TIME.match(line)
    if not m:
        return None
    d = dt.date.fromisoformat(m.group(1)) if m.group(1) else file_date
    h = int(m.group(2))
    if h > 23:
        return None
    return d - dt.timedelta(days=1) if h < DAY_START else d


def daily_note_lines(day):
    """memory/<日期>.md 里属于这一天的行：当天文件去掉凌晨 4 点前的（那是前一天的），加上第二天文件里凌晨 4 点前的。"""
    out = {}
    for d in (day, day + dt.timedelta(days=1)):
        t = read(f'memory/{d.isoformat()}.md')
        if not t:
            continue
        keep, cur = [], d
        for line in t.splitlines():
            ld = line_day(line, d)
            if ld is not None:
                cur = ld
            if cur == day and line.strip():
                keep.append(line)
        if keep:
            out[f'memory/{d.isoformat()}.md'] = keep
    return out


def daily_notes(day):
    parts = [say("digestDailyNote", rel=rel, label_her=LABEL_HER, demote=demote(chr(10).join(lines)))
             for rel, lines in daily_note_lines(day).items()]
    return '\n\n'.join(parts) or say("digestNone")


def compaction_files(day):
    out = []
    for p in sorted((WS / 'memory/compactions').glob('*.md')):
        m = re.match(r'(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)', p.stem)
        if not m:
            continue
        t = dt.datetime.fromisoformat(m.group(1)).replace(hour=int(m.group(2)), minute=int(m.group(3)), tzinfo=TZ)
        if her_day(t) == day:
            out.append(p)
    return out


def compaction_summaries(day):
    out = []
    for p in compaction_files(day):
        text = p.read_text(encoding='utf-8').split('## 原始对话', 1)[0]
        out.append(say("digestCompactionSummary", name=p.name, label_other=LABEL_OTHER, demote=demote(text.strip())))
    return '\n\n'.join(out) or say("digestNoCompaction")


DIARY_RE = re.compile(r'^- (\d{4}-\d\d-\d\d)(?:[ T](\d{1,2})[:：]([0-5][0-9xX]|[xX]{1,2}))?')


def diary_lines(day):
    """my-life.md 和 memory/diary/<月>.md（这一天所在月、下个月各一份：凌晨条目会写进下月）里属于这一天的行。"""
    nxt = (day.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
    rels = ['memory/my-life.md', f'memory/diary/{day:%Y-%m}.md', f'memory/diary/{nxt:%Y-%m}.md']
    out = []
    for rel in rels:
        for line in read(rel).splitlines():
            m = DIARY_RE.match(line)
            if not m:
                continue
            d = dt.date.fromisoformat(m.group(1))
            if m.group(2) is not None and int(m.group(2)) < DAY_START:
                d -= dt.timedelta(days=1)
            if d == day:
                out.append(line)
    return out


def today_file(day):
    for rel in (f'memory/life/today-{day.isoformat()}.md', 'memory/life/today.md'):
        t = read(rel)
        if t and (rel.endswith(f'{day.isoformat()}.md') or day.isoformat() in t[:300]):
            return rel, t
    return None, ''


def think_cycles(day):
    return [c for c in sorted((WS / 'memory/life/think/cycles').glob(f'{day.isoformat()}-*')) if (c / 'summary.md').exists()]


def material_reason(status):
    """input.md's line 2 without its head (材料：, in any language): 完整, or 不完整（缺：…）."""
    return status[len(next(h for h in form.every('materialHead') if status.startswith(h))):]


TASTE_RE = re.compile(r'^- \d{1,2}[:：][0-5][0-9xX] (?:' + '|'.join(map(re.escape, form.every("tasteTag"))) + r')[:：]')


def taste_lines(day):
    """口味（主人 11-03：taste.md 只读了）：每日笔记里这一天的「- HH:MM 口味：…」行原样，
    加 memory/bili/seen.jsonl 里这一天（按 4 点归属）的评级，一行「- HH:MM 《标题》（UP）：评级｜一句话」；
    只标了「看过」、没写一句话的不逐条列（一天能有上百条），最后只给个条数。"""
    out = [l for ls in daily_note_lines(day).values() for l in ls if TASTE_RE.match(l)]
    bare = 0
    for raw in read('memory/bili/seen.jsonl').splitlines():
        try:
            r = json.loads(raw)
            t = dt.datetime.strptime(r['time'], '%Y-%m-%d %H:%M')
        except (ValueError, KeyError, TypeError):
            continue
        if her_day(t) != day:
            continue
        one = lambda k: ' '.join(str(r.get(k) or '').split())   # noqa: E731
        up, note, verdict = one('up'), one('note'), one('verdict')
        if verdict == '看过' and not note:
            bare += 1
            continue
        out.append(say("digestTasteLine", t=t, one=one("title"), a=say("digestTasteUp", up=up) if up else '', verdict=verdict, b=say("digestTasteNote", note=note) if note else ''))
    if bare:
        out.append(say("digestTasteBare", bare=bare))
    return out


TAG_RE = re.compile(r'^\s*[-*+]\s+(?:\d{1,2}[:：](?:[0-5][0-9xX]|[xX]{1,2})\s*)?(' + '|'.join(PEOPLE_TAGS) + r')[:：]')


def tag_lines(day, tag):
    """白天每日笔记里这一天关于人的标签行原样：「- HH:MM 新认识：〔谁〕…」「- 记着：〔谁 MM-DD HH:MM〕「原话」——…」
    「- HH:MM 主会话那边：〔谁〕…」。tag 是一种（字符串）或几种（元组），几种一起时照笔记里的顺序。
    归属照 daily_note_lines：凌晨 4 点前的算前一天；「- 记着：」没有钟点，跟上一行的日子。"""
    tags = (tag,) if isinstance(tag, str) else tuple(tag)
    return [l for ls in daily_note_lines(day).values() for l in ls if (m := TAG_RE.match(l)) and m.group(1) in tags]


INBOX_RE = re.compile(r'^\s*[-*+]\s+(\d{1,2})-(\d{1,2})\s+(\d{1,2})[:：](?:[0-5][0-9xX]|[xX]{1,2})(?![0-9])')
LIST_MARK_RE = re.compile(r'^\s*[-*+]\s+')


def inbox_day(month, mday, hour, day):
    """收件处的行只写 MM-DD HH:MM：年份取离 day 最近的那个（跨年也对），凌晨 4 点前算前一天；日子不对返回 None。"""
    near = None
    for y in (day.year - 1, day.year, day.year + 1):
        try:
            c = dt.date(y, month, mday)
        except ValueError:
            continue
        if near is None or abs((c - day).days) < abs((near - day).days):
            near = c
    if near is None or hour > 23:
        return None
    return near - dt.timedelta(days=1) if hour < DAY_START else near


def inbox_lines(day):
    """2 期起兜底访客写的收件处 memory/people/inbox/<key>.md 里这一天（按 4 点归属）的行，前面标〔兜底·<key>〕；
    没有日期的续行（缩进的子项）跟上一行的日子、原样放；标题、注释不放。开关没开返回 []。"""
    if not retired_active():
        return []
    base = WS / INBOX_DIR
    out = []
    for p in sorted(base.glob('*.md')) if base.is_dir() else []:
        if p.is_symlink() or not p.is_file():
            continue
        cur = None
        for line in p.read_text(encoding='utf-8', errors='replace').splitlines():
            m = INBOX_RE.match(line)
            if m:
                cur = inbox_day(int(m.group(1)), int(m.group(2)), int(m.group(3)), day)
                if cur == day:
                    out.append(say("digestInboxLine", stem=p.stem, sub=LIST_MARK_RE.sub('', line, count=1)))
            elif cur == day and line.strip() and not line.lstrip().startswith(('#', '<!--')):
                out.append(line)
    return out


def reappeared_retired():
    """2 期起：退役名单里又出现在原路径的文件（她派的帮手不过 HH 的守卫，可能照老习惯写进去）：[(原路径, 整份内容)]，
    照名单的顺序。开关没开时这些就是正常的人物文件，返回 []。"""
    if not retired_active():
        return []
    return [(rel, (WS / rel).read_text(encoding='utf-8', errors='replace'))
            for rel in RETIRED_PEOPLE if (WS / rel).is_file()]


def reappeared_section(files):
    head = say("digestReappeared", label_her=LABEL_HER)
    return head + '\n\n' + '\n\n'.join(f'#### {rel}\n{demote(t.strip()) or say("digestEmptyFile")}' for rel, t in files)


def people_near():
    """第 7 节的人物近况：2 期起读 hhd 从事件库现算、导出的 ledger/people/near.md；没开照旧读昨晚写的 midterm/people.md。"""
    if retired_active():
        return say("digestPeopleNear", a=demote(M.read_part(PEOPLE_NEAR)) or say("digestNotYet"))
    return say("digestPeopleOld", a=demote(M.read_part(PEOPLE_OLD)) or say("digestNotYet"))


def her_life(day, warnings):
    parts = []
    rel, t = today_file(day)
    if rel:
        parts.append(say("digestPlans", rel=rel, label_plan=LABEL_PLAN, demote=demote(t.strip())))
    parts.append(say("digestDiary", label_her=LABEL_HER, a='\n'.join(diary_lines(day)) or say("digestNone")))
    for c in think_cycles(day):
        parts.append(say("digestFiveRounds", name=c.name, label_plan=LABEL_PLAN, demote=demote((c / "summary.md").read_text(encoding="utf-8").strip())))
    try:
        r = subprocess.run(['goals', 'ls'], capture_output=True, text=True, timeout=30)   # the goals module's command
        if r.returncode != 0 or not r.stdout.strip():
            raise RuntimeError((r.stderr or say("digestNoOutput")).strip()[-200:])
        parts.append(say("digestGoals", label_plan=LABEL_PLAN, demote=demote(r.stdout.strip())))
    except Exception as e:  # noqa: BLE001
        warnings.append(say("digestGoalsFailed", a=str(e)[:120]))
        parts.append(say("digestGoalsUnreadable", e=e))
    taste = taste_lines(day)
    if taste:
        parts.append(say("digestTaste", label_her=LABEL_HER, demote=demote('\n'.join(taste))))
    people = tag_lines(day, PEOPLE_TAGS) + inbox_lines(day)
    if people:
        parts.append(say("digestPeopleNoted", label_her=LABEL_HER, demote=demote('\n'.join(people))))
    return '\n\n'.join(parts)


SUMMARY_SECTIONS = ('一句话', '简述', '现在的状态')   # 这几节本来就是摘要，带日期很正常


def thread_day_lines(t, day, raw=False):
    """一条事件线里属于这一天的行：「经过」里的，加上误写在「经过」外面的带日期的行（标出来；raw=True 不加标注）。"""
    log = set(t.log.splitlines())
    new = [l for l in t.log.splitlines() if (d := M.parse_when(l)) and her_day(d) == day]
    outside, sec = [], None
    for l in t.text.splitlines():
        if l.startswith('## '):
            sec = l[3:].strip()
            continue
        if sec is None or sec.startswith('经过') or sec.startswith(SUMMARY_SECTIONS) or l in log or '<!--' in l:
            continue
        if (d := M.parse_when(l)) and her_day(d) == day:
            outside.append(l if raw else say("digestUnderSection", l=l, sec=sec))
    return new + outside


def threads(day):
    today_lines, index = [], []
    for t in M.load_threads():
        new = thread_day_lines(t, day)
        meta = say("digestHasMeta") if t.has_meta else say("digestNoMeta")
        imp = t.meta.get('重要')
        imp = say("digestImportance", imp=imp, why=t.meta.get("为什么") or say("digestNoWhy")) if imp else say("digestNoImportance")
        index.append(say("digestThreadIndex", name=t.path.name, title=t.title, dates_label=t.dates_label(), meta=meta, imp=imp, line=t.line or say("digestNotWritten")))
        if new:
            today_lines.append(say("digestThreadNew", name=t.path.name, title=t.title, label_her=LABEL_HER, demote=demote('\n'.join(new))))
    return '\n'.join(index), '\n\n'.join(today_lines) or say("digestNoThreadProgress")


TIMELINE_RE = re.compile(r'^- (\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2})[:：]([0-5][0-9xX]|[xX]{1,2}))?')


def timeline_lines(day):
    out = []
    for l in read('memory/timeline.md').splitlines():
        m = TIMELINE_RE.match(l)
        if m:
            d = dt.date.fromisoformat(m.group(1))
            if m.group(2) is not None and int(m.group(2)) < DAY_START:
                d -= dt.timedelta(days=1)
            if d == day:
                out.append(l)
    return out


def timeline(day):
    return demote('\n'.join(timeline_lines(day))) or say("digestNone")


def open_loops():
    t = read('memory/open-loops.md')
    body = t.split('## 进行中', 1)[-1].split('\n## ', 1)[0]
    items = [l for l in body.splitlines() if l.startswith('- [ ]')]
    return say("digestLoopsCount", count=len(items), demote=demote('\n'.join(items)))


# ---------- sources.json ----------

def source_files():
    files = []
    mem = WS / 'memory'
    for p in sorted(mem.rglob('*.md')) if mem.exists() else []:
        rel = p.relative_to(WS).as_posix()
        if not rel.startswith('memory/sleep/') and p.is_file():    # 搬家前的老地方：万一又冒出来也不算源文件
            files.append(rel)
    for pat in ('soul/*.md', 'skills/**/*.md'):
        files += sorted(p.relative_to(WS).as_posix() for p in WS.glob(pat) if p.is_file())
    return files + ['MEMORY.md', 'USER.md', 'SOUL.md']


def write_sources(day, out_dir):
    files = {}
    for rel in source_files():
        p = WS / rel
        files[rel] = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
    doc = {'day': day.isoformat(), 'generated_at': now_local().isoformat(timespec='seconds'), 'files': files}
    atomic_write(out_dir / 'sources.json', json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    return len(files)


# ---------- state.json ----------

def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.tmp-{os.getpid()}')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


class State:
    """state.json 的读改写：加锁（sleep/.state.lock），只动自己的键，别人的键原样保留，先写临时文件再改名。"""

    def __init__(self):
        self.path = sleep_dir() / 'state.json'

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = open(self.path.parent / '.state.lock', 'w')
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        self.st = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {}
        return self.st

    def __exit__(self, et, ev, tb):
        try:
            if et is None:
                self.st['updated'] = now_local().isoformat(timespec='seconds')
                atomic_write(self.path, json.dumps(self.st, ensure_ascii=False, indent=1) + '\n')
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            self.lock.close()


def read_state():
    p = sleep_dir() / 'state.json'
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}


def _advance(st):
    """last_done 只往前挪到「之前每一天都整理过（或是空的）」的地方。"""
    finished = set(st.get('done', [])) | set(st.get('empty', []))
    if not st.get('last_done'):
        return
    d = dt.date.fromisoformat(st['last_done'])
    while (d + dt.timedelta(days=1)).isoformat() in finished:
        d += dt.timedelta(days=1)
    st['last_done'] = d.isoformat()


def _add_day(st, key, day):
    st[key] = sorted(set(st.get(key, [])) | {day.isoformat()})
    if not st.get('last_done'):
        st['last_done'] = (day - dt.timedelta(days=1)).isoformat()
    _advance(st)


def last_target(now=None):
    now = now or now_local()
    return her_today(now) if now.hour < DAY_START else her_today(now) - dt.timedelta(days=1)


def has_content(day):
    """这一天有没有任何东西可整理。读不到对话库就当有（宁可让整理者看一眼，也不悄悄跳过）。"""
    entries, missing = gather(day)
    if missing or entries:
        return True
    if daily_note_lines(day) or diary_lines(day) or think_cycles(day) or today_file(day)[0] or inbox_lines(day):
        return True
    if compaction_files(day) or timeline_lines(day):
        return True
    return any(thread_day_lines(t, day) for t in M.load_threads())


def pending(now=None, mark=True):
    now = now or now_local()
    st = read_state()
    end = last_target(now)
    last = dt.date.fromisoformat(st['last_done']) if st.get('last_done') else end - dt.timedelta(days=1)
    finished = set(st.get('done', [])) | set(st.get('empty', []))
    days, d = [], last + dt.timedelta(days=1)
    while d <= end:
        if d.isoformat() not in finished:
            days.append(d)
        d += dt.timedelta(days=1)
    out = []
    for d in days:
        if mark and now >= night_of(d) and not has_content(d):
            with State() as s:
                _add_day(s, 'empty', d)
            continue
        out.append(d)
    return out


def material_status(day):
    p = sleep_dir() / day.isoformat() / 'input.md'
    if not p.exists():
        return None
    lines = p.read_text(encoding='utf-8').splitlines()
    return lines[1] if len(lines) > 1 else ''


def mark_done(day, now=None):
    now = now or now_local()
    if now < night_of(day):
        print(say("digestDoneTooEarly", day=day, night_of=night_of(day)), file=sys.stderr)
        return 2
    status = material_status(day)
    if status is None:
        print(say("digestDoneNoMaterial", day=day), file=sys.stderr)
        return 2
    tonight = night_id(now)
    with State() as st:
        if status in form.every('materialFull'):
            _add_day(st, 'done', day)
            if day.isoformat() in st.get('deferred', {}):
                st['deferred'][day.isoformat()] += say("digestDoneComplete", tonight=tonight)
            print(say("digestMarked"), day)
            return 0
        if not status.startswith(form.every('materialPartialHead')):
            print(say("digestDoneOldFormat", day=day), file=sys.stderr)
            return 2
        reason = material_reason(status)
        nights = st.setdefault('defer_nights', {}).setdefault(day.isoformat(), [])
        earlier = [n for n in nights if n != tonight]
        if len(earlier) >= MAX_DEFER_NIGHTS:
            _add_day(st, 'done', day)
            st.setdefault('deferred', {})[day.isoformat()] = (
                say("digestDoneAnyway", reason=reason, a=len(earlier), tonight=tonight))
            print(say("digestMarked"), day, say("digestMarkedAnyway"))
            return 0
        if tonight not in nights:
            nights.append(tonight)
        st.setdefault('deferred', {})[day.isoformat()] = reason
        print(say("digestDoneDeferred", day=day, reason=reason, a=len(earlier) + 1, max_defer_nights=MAX_DEFER_NIGHTS),
              file=sys.stderr)
        return 3


def defer(day, reason, now=None):
    with State() as st:
        st.setdefault('deferred', {})[day.isoformat()] = reason
    print(say("digestMarkedDeferred"), day, reason)
    return 0


# ---------- 学习（主人 11-01：HH 记的分和把关的结论，整理者原样放进报告） ----------

HH_LEARN = STATE / 'learn'   # HH 写的：每周数字 weekly.md、夜里把关的结论 check/<日>.json（测试换成临时目录）
REPLAY_DROP = '回测通过率比昨晚低'      # HH 写 weekly.md 时回测比前一晚差，就把这句放在第一行
VERDICTS = (('add', say("digestVerdictAdd")), ('merge', say("digestVerdictMerge")), ('reject', say("digestVerdictReject")), ('unchecked', say("digestVerdictUnchecked")))
CHECK_CLIP = 80                        # 不收的候选在材料里最多显示这么多字（全文在 check/<日>.json）


def checked_days(day):
    """要报把关结论的日子：前一天（前一晚整理的那天）；前一天是空的日子（没整理、没做材料）就接着往前，到不是空的那天为止。"""
    empty = set(read_state().get('empty', []))
    out, d = [], day - dt.timedelta(days=1)
    for _ in range(7):
        out.append(d)
        if d.isoformat() not in empty:
            break
        d -= dt.timedelta(days=1)
    return out[::-1]


def verdict_lines(d):
    """那一天交给把关的候选的结论：每种几条，不收的逐条带理由（收下的进了页，应用报告里有）。没交过把关就是空的。"""
    p = HH_LEARN / 'check' / f'{d.isoformat()}.json'
    try:
        vs = json.loads(p.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as e:
        return [say("digestVerdictHeading", d=d), say("digestVerdictUnreadable", p=p, e=e)]
    if not isinstance(vs, list):
        return [say("digestVerdictHeading", d=d), say("digestVerdictNotList", p=p)]
    vs = [v for v in vs if isinstance(v, dict)]
    if not vs:
        return []

    def flat(s):
        return re.sub(r'\s+', ' ', str(s or '')).strip()

    count = {k: sum(1 for v in vs if v.get('verdict') == k) for k, _ in VERDICTS}
    out = [say("digestVerdictHeadingN", d=d, a=len(vs)),
           '- ' + say("digestSemicolon").join(say("digestVerdictCount", cn=cn, count=count[k]) for k, cn in VERDICTS if count[k])]
    for v in vs:
        if v.get('verdict') != 'reject':
            continue
        t = flat(v.get('text'))
        t = t[:CHECK_CLIP] + '…' if len(t) > CHECK_CLIP else t
        out.append(say("digestVerdictRejected", a=v.get('kind') or '?', b=v.get('page') or '?', t=t, c=flat(v.get('why')) or say("digestNoReason")))
    return out


def learn_section(day):
    """材料第 8 节：前一晚把关的结论；整理的那一天是周日、或者 weekly.md 第一行是回测变差，附上 HH 写的每周数字。"""
    out = [l for d in checked_days(day) for l in verdict_lines(d)]
    p = HH_LEARN / 'weekly.md'
    try:
        weekly = p.read_text(encoding='utf-8').strip()
        at = dt.datetime.fromtimestamp(p.stat().st_mtime, TZ)
    except OSError:
        weekly = ''
    if weekly and (day.weekday() == 6 or weekly.startswith(REPLAY_DROP)):
        why = say("digestWeeklySunday") if day.weekday() == 6 else say("digestWeeklyWorse")
        # 写的时刻在前一晚：里面「这一天花了多少、叫醒几次」数的是那之前 24 小时，不是正在整理的这一天（11-04 夜里拿 $0.31 对当天用完 $1，以为对不上）
        out += [say("digestWeekly", why=why, at=at, a=at - dt.timedelta(days=1)), demote(weekly)]
    return '\n'.join(out) or say("digestNoLearning")


HH_LOG = STATE / 'logs/hh.jsonl'          # HH 的运行日志（测试换成临时文件）
HH_REPAIR_LOG = STATE / 'repair/log.jsonl'  # 修理的留痕：检查、合并、部署、重启、退回、核对
HH_LIVE = HERE.parents[2]   # the HH checkout this module is in


def _iso_local(t):
    try:
        return dt.datetime.fromisoformat(t.replace('Z', '+00:00')).astimezone(TZ)
    except (ValueError, AttributeError):
        return None


def hh_audit_json():
    """线上核对（hh fix audit --json）；跑不了就是 None，这一节照样出"""
    if not (HH_LIVE / 'src/cli.ts').exists():
        return None
    node = os.environ.get('HH_NODE') or shutil.which('node') or 'node'   # the node HH runs on, not the first on PATH
    try:
        # 直接跑 cli.ts：HH 的配置分层上线后不带 HH_CONFIG 会在启动检查处退出，不靠继承（11-14 运维）
        env = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(HH_CONFIG))
        r = subprocess.run([node, str(HH_LIVE / 'src/cli.ts'), 'fix', 'audit', '--json'], capture_output=True, text=True, timeout=120, cwd=str(HH_LIVE), env=env)
        return r.stdout if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def repair_section(day, log_path, repair_log, audit_json):
    """材料第 9 节：这一天 HH 日志里的报错（按消息归类）、hhd 起了几次、修理记录、线上核对查出的变化。找毛病用（指南第 9 步）。"""
    start, end = bounds(day)
    groups, ups = {}, 0
    try:
        lines = log_path.read_text(encoding='utf-8').splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        t = _iso_local(r.get('t'))
        if not t or not (start <= t < end):
            continue
        if r.get('msg') == 'hhd up':
            ups += 1
        if r.get('level') not in ('warn', 'error'):
            continue
        rest = {k: v for k, v in r.items() if k not in ('t', 'level', 'mod', 'msg')}
        groups.setdefault(r.get('msg', '?'), []).append(f"{t:%H:%M} {redact(json.dumps(rest, ensure_ascii=False))[:160]}")
    out = []
    if groups:
        out.append(say("digestErrorsHeading"))
        for msg, rows in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            out.append(say("digestErrorCount", msg=msg, a=len(rows)))
            out += [f'  - {x}' for x in rows[:2]]
    if ups > 1:
        out.append(say("digestHhdStarts", ups=ups))
    elif ups == 1:
        out.append(say("digestHhdStartedOnce"))
    events = []
    try:
        for line in repair_log.read_text(encoding='utf-8').splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            t = _iso_local(e.get('t'))
            if t and start <= t < end and e.get('kind') in ('merge', 'deploy', 'refused', 'rollback', 'audit', 'watch'):
                events.append(say("digestRepairLine", t=t, a=e.get('kind'), b=' ' + e['fix'] if e.get('fix') else '', c=e.get('text', '')[:300]))
    except OSError:
        pass
    if events:
        out += [say("digestRepairHeading")] + events
    try:
        a = json.loads(audit_json) if audit_json else None
    except ValueError:
        a = None
    if a and a.get('live'):
        # her own edits to the live copy are not a fault: one line, the next deploy keeps them on a branch for the team
        out.append(say("digestAuditLocal", n=len(a['live']), head=(a.get('deployed') or '')[:7],
                       files=say("digestListSep").join(say("digestAuditLive", path=d['path'], how=d['how']) for d in a['live'][:10])))
    if a and (a.get('sensitive') or a.get('note') or a.get('appNote')):
        out.append(say("digestAuditHeading"))
        out += [say("digestAuditChange", path=d['path'], was=d['was'], now=d['now']) for d in a.get('sensitive', [])]
        out += [f"- {a[k]}" for k in ('appNote', 'note') if a.get(k)]   # the audit's own sentences, in the role's language
    return '\n'.join(out) or say("digestNoErrors")


# ---------- 生成材料 ----------

def build(day):
    now = now_local()
    people = load_people()
    warnings, notes = [], []
    entries2, missing = gather(day, people, days_before=1)       # 带上前一天，给 1b 找原话用
    if not people.reg:
        missing.insert(0, say("digestNoRegistry"))
    start, _ = bounds(day)
    entries = [e for e in entries2 if e.ts >= start]
    if now < night_of(day):
        missing.append(say("digestDayNotOver", bounds=bounds(day)[1]))
    convo = render_conversations(people, entries, notes)
    cov = HONCHO_RETIRED
    idx, today_threads = threads(day)
    # 10-31 起事件只在事件库里：事件线和时间轴收进了 memory/archive/，这几节指向夜里的工作单
    events_only = not (WS / 'memory/threads').is_dir()
    ledger = ([(f'threads/{t.path.name}', l) for t in M.load_threads() for l in thread_day_lines(t, day, raw=True)] +
              [('memory/timeline.md', l) for l in timeline_lines(day)] +
              [(rel, l) for rel, ls in daily_note_lines(day).items() for l in ls])
    life = her_life(day, warnings)
    back = reappeared_retired()
    parts = [
        (say("digestSec1"), convo),
        (say("digestSec1b"), unmatched_quotes(people, ledger, entries2)),
        (say("digestSec2"), say("digestSec2Body", daily_notes=daily_notes(day), compaction_summaries=compaction_summaries(day), hh_section=hh_section(day, warnings))),
        (say("digestSec3"), life),
    ] + ([(say("digestSec3b"), reappeared_section(back))] if back else []) + [
        (say("digestSec4"), say("digestSec4EventsOnly")
         if events_only else say("digestSec4Body", today_threads=today_threads, demote=demote(idx))),
        (say("digestSec5", label_her=LABEL_HER), say("digestSec5EventsOnly") if events_only else timeline(day)),
        (say("digestSec6", label_her=LABEL_HER), open_loops()),
        (say("digestSec6b"),
         say("digestSec6bEventsOnly") if events_only else
         '\n'.join(say("digestLeavingLine", name=t.path.name, title=t.title, dates_label=t.dates_label(), one_line=t.one_line()) for t in M.leaving(day)) or say("digestNone")),
        (say("digestSec7", label_last=LABEL_LAST),
         say("digestSec7Body", a=demote(M.read_part('memory/midterm/self.md')) or say("digestNotYet"), people_near=people_near())),
        (say("digestSec8"), learn_section(day)),
        (say("digestSec9"), repair_section(day, HH_LOG, HH_REPAIR_LOG, hh_audit_json())),
    ]
    out_dir = sleep_dir() / day.isoformat()
    status = form('materialFull') if not missing else form('materialPartial').format(missing=form('materialSep').join(missing))
    if missing and now >= night_of(day):
        with State() as st:
            nights = st.setdefault('defer_nights', {}).setdefault(day.isoformat(), [])
            if night_id(now) not in nights:
                nights.append(night_id(now))
            st.setdefault('deferred', {})[day.isoformat()] = material_reason(status)
            earlier = [n for n in nights if n != night_id(now)]
        if len(earlier) >= MAX_DEFER_NIGHTS:
            warnings.append(say("digestDeferredEnough", a=len(earlier)))
        else:
            warnings.append(say("digestIncompleteTonight", a=len(earlier) + 1, max_defer_nights=MAX_DEFER_NIGHTS))
    header = [
        say("digestTitle", isoformat=day.isoformat(), day=day, a=day + dt.timedelta(days=1)),
        status,
        say("digestCoverage", cov=cov),
    ] + [say("digestNote", w=w) for w in warnings + notes] + [LEGEND]
    body = '\n\n'.join(f'{h}\n\n{redact(b)}'.strip() for h, b in parts)
    atomic_write(out_dir / 'input.md', '\n'.join(header) + '\n\n' + body + '\n')
    n = write_sources(day, out_dir)
    print(out_dir / 'input.md')
    print('  ' + status)
    print(say("digestPrintCoverage", cov=cov))
    for w in warnings + notes:
        print(say("digestPrintNote", w=w))
    for h, b in parts:
        print(say("digestPrintSize", a=len(b), h=h))
    print(say("digestPrintSources", n=n))
    return 3 if missing else 0


def main(argv=None):
    global WS, ROOT, DB, NOW
    ap = argparse.ArgumentParser(description=say("digestHelp"), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('args', nargs='*')
    ap.add_argument('--root')
    ap.add_argument('--ws')
    ap.add_argument('--db')
    ap.add_argument('--honcho')
    ap.add_argument('--now')
    ap.add_argument('--no-write', action='store_true')
    a = ap.parse_args(argv)
    if a.now and not a.root:
        ap.error(say("digestNowNeedsRoot"))
    if a.ws:
        WS = Path(a.ws).resolve()
        M.WS = WS
        R.WS, R.REG = WS, WS / 'memory/people/registry.json'
    ROOT = Path(a.root).resolve() if a.root else None
    DB = Path(a.db) if a.db else DB_DEFAULT
    if a.honcho:
        R.BASE = a.honcho.rstrip('/')
    if a.now:
        NOW = dt.datetime.fromisoformat(a.now)
        NOW = NOW.replace(tzinfo=TZ) if NOW.tzinfo is None else NOW.astimezone(TZ)
    args = a.args
    if args[:1] == ['pending']:
        for d in pending(mark=not a.no_write):
            print(d.isoformat())
        return 0
    if args[:1] == ['done'] and len(args) == 2:
        return mark_done(dt.date.fromisoformat(args[1]))
    if args[:1] == ['defer'] and len(args) >= 3:
        return defer(dt.date.fromisoformat(args[1]), ' '.join(args[2:]))
    if len(args) > 1:
        ap.error(say("digestUsage"))
    day = dt.date.fromisoformat(args[0]) if args else last_target()
    return build(day)


if __name__ == '__main__':
    sys.exit(main())
