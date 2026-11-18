#!/usr/bin/python3
"""睡眠整理的「应用」：整理者把改好的文件写在 sleep/<日期>/proposed/，这里按 hash 安全地换进原文件、分开提交。
（整理的工作区 10-25 从 memory/sleep/ 搬到了工作目录根下的 sleep/：OpenClaw 把 memory/ 下所有 .md 都索引进主会话的记忆搜索，
草稿、报告、材料（里面有访客私聊的原话）不该被搜到。）
不用大模型，只做机械的事（主人 2026-10-25 批准的 P0-2）。

  sleep_apply.py gate                         第 0 步：看额度，打印 go / defer（这一跑不整理，05:30 再来）/ save（省电：只做前几步，不应用、不标完成）
  sleep_apply.py begin <日期>                 第 0 步：记下「敏感区」指纹，先把她白天没提交的改动提交成 day/<日期>，
                                              打印进度和以前推迟的文件；上一跑材料不完整只做了一部分的，开新一轮
  sleep_apply.py material <日期>              digest 之后：full 照常全做 / partial 材料不完整，只做不靠对话的步骤 /
                                              redigest 还没有新格式的材料，先跑 digest
  sleep_apply.py step <日期> <步骤> [状态]     记一步的进度（state.json 的 steps，默认 done）；重跑时跳过做完的
  sleep_apply.py steps <日期>                 看进度
  sleep_apply.py plan <日期>                  演练：每个提案会被应用 / 推迟 / 拒绝 / 留给她，什么都不改
  sleep_apply.py finish <日期> [--partial]    第 10 步收尾：live 应用 + 重建 + 记忆、人格分开提交 + 标完成；draft 演练 + 提交 + 标完成；
                                              --partial（材料不完整的那一跑）：照样应用和提交，但不标完成
  sleep_apply.py carry-diff <那天> <文件>      以前推迟的文件：那一晚想怎么改（当时的原文件 → 当时的提案）
  sleep_apply.py memory-merge <日期>          生成 memory-merge.md：MEMORY.md / USER.md 的改动清单，给她在干净的回合里自己改
  sleep_apply.py soul-week <日期>             周日那天：本周 soul-changelog + soul/ 的真实 git 改动（按提交分谁改的）+ 今晚的提案
  sleep_apply.py restart <日期>               手动重做某一天（比如上线后回放 draft 期间的日子）：旧提案挪进 cycle-<n>/，进度清零

人工放行和回滚（主人 或 Claude Code 用，整理者不用）：
  sleep_apply.py approve <日期> <文件>...      批准这几个提案：把提案现在的 sha 记进 sleep/<日期>/approved.json；之后 finish
                                              对它不再做缩水保护和人格上限（提案再被改过，sha 对不上就不算批准）
  sleep_apply.py promote <日期> <文件>...      那一天已经收尾、被推迟的提案现在换进去：原文件必须还是 digest 时的样子（sources.json
                                              的 hash），不是就拒绝（要在现在的原文件上重做）；重建，只提交这些文件（记忆、人格各一个
                                              提交，tag sleep/<日期>/promote，再来是 .2、.3……），写 last_applied_at 让主会话重新冻结
  sleep_apply.py rollback <日期> [--soul|--memory]  git revert 那一晚打了 tag 的提交（promote → soul → memory，新的先），重建，
                                              写 last_applied_at；这些提交动过的文件有没提交的改动就拒绝；打印回滚了什么

规矩：
- 原文件现在的 sha256 等于 sleep/<日期>/sources.json 里记的（digest 那一刻的），才用提案覆盖；
  不等（整理之后有人改过）就推迟：这一晚不动它，写进报告，下一晚以新的原文件为底重做。
- 原文件已经和提案一样的，算「已应用」，所以中途死掉再跑不会重复写。
- MEMORY.md、USER.md 永远不由脚本写：OpenClaw 记着每个记忆文件最后一次 agent 写入的 hash，
  文件在那之外被改过，下一次写入就记成「不可信」，这两个文件从此不再每轮加载。
  它们的改动写进 memory-merge.md，由她在主会话里没碰过网页的回合，用 edit 工具自己改。
- SOUL.md、memory/recent.md 是生成的：应用后重跑 soul_build.py、midterm.py build、ledger_snapshot.py，不拷预览。
- 只收 memory/、soul/、skills/ 下的 .md，和 sleep/soul-changelog.md（按行追加；写成旧路径 memory/sleep/soul-changelog.md
  的也照样追加进 sleep/ 那份）；写到这些以外（脚本、AGENTS、sleep/ 下别的、memory/sleep/ 下别的……）的提案说明整理出了岔子：
  整晚拒绝应用。
- 2 期（人物迁进事件库）：迁移那天 RETIRED_PEOPLE 那 11 个人物文件挪进 memory/archive/retired-20261103/；挪了以后
  （开关 = 那里的 <主人>.md 在，和 ledger_snapshot、midterm、HH 的守卫同一个）这些路径的提案、删除都跳过（不新建回来），
  报告「应用」节写一行警告，别的照常应用；approve / promote 也不收它们。没挪之前照旧当记忆应用。
- 缩水保护（学 OpenClaw 自己的 dreaming）：记忆或人格提案比原文件少了超过 25% 的内容行（至少 5 行；改写的、挪进
  memory/archive/ 的都算少了：archive 不在她常驻的上下文里）就推迟，等人看过 approve / promote。
  每晚从材料重写的中期记忆（memory/midterm/self.md、people.md）不算。事件线（memory/threads/）不按 25% 算，
  只看「经过」：原文件「经过」里的每一行提案里都还在就放行（一句话、简述、现在的状态、因果和判断、元数据随便改写），
  少了就推迟；没有「经过」这一节的照 25% 算。
- 笔记本的闸门（学习系统 11-01）：skills/ 的提案应用前过两道。丢行：被覆盖、被删的文件里的内容行，在应用后的 skills/
  （含任何一层的 归档/）里要找得到——按「核心」比（去掉编号注释、开头的列表记号、编号、勾选框、✓、「没验证过」这类状态标记），
  是应用后某一行核心的一部分，或者按「；」「。」「｜」切开每段都找得到；页的封面（简介、什么时候翻）、SKILL.md 的 frontmatter
  和目录条目、skills/MAP.md、CHANGELOG.md 不核。编号：HH 认得（hh learn ids，10 秒拿不到就跳过这道、报告写一行）、
  应用前 skills/ 里也有的编号，应用后要还在 HH 认的位置（页的标题行、「## 教训」下的教训行）。任何一道不过，这一晚 skills/
  的提案整批推迟（要删的也不删），其余照常，报告写「笔记本这晚没换：…」；下一晚原样重提没问题的那几个照常应用（原文件没变）。
  应用后新出现的教训行和「## 做法」下的行，不等于 <状态目录>/learn/check/<日期>.json 里把关收下（add / merge）的 finalText 的，
  报告里列「没过把关就进来的：…」（只报告，不拦）。
- 人格上限（主人 10-29 去掉了，SOUL_CAP = None；下面是设成数字时的行为）：当晚人格块的提案和原文件比，改动（difflib 不是 equal 的段；中间只隔 2 行没改的算一处）合计超过 SOUL_CAP 处，
  这些人格块的提案（连同它们的 changelog 行、要删的人格块）全部推迟。带「<!-- 注入：快照 -->」的学习记录
  （70 教训、75 学到的、80 我的经历，每晚重写快照）不算人格上限，只过缩水保护。SOUL_CAP_SKIP 里列的小节（现在没有；
  以前 30 喜好的「最近的口味和兴趣」，11-04 那一节没了）里的改动不算上限、也不过缩水保护。批准过的提案不受这几条管。
- 指纹：begin 时记下脚本、AGENTS、LaunchAgents、cron 定义、git 钩子和配置、openclaw.json、插件……；收尾时和这一晚
  第一次 begin 比，有变化、整理任务自己写了 sleep/<日期>/ 以外的文件（记忆文件的写入记录）、或者人格文件 / 人物表在整理期间被直接改了
  又没提交（不是应用改的），整晚拒绝应用（退出码 2，整理者最后回复第一行写 AUTOMATION_FAILED）。
  这只是绊线：整理者自己能跑 exec，真被攻破的整理者能绕过它。
- 提交：begin 时 day/<日期>（白天的改动）→ 收尾时 sleep/<日期>/memory、sleep/<日期>/soul，各打 tag，
  人格那个可以单独回滚（rollback --soul）；全部成功才 sleep_digest.py done <日期>，再写 state.json 的 last_applied_at。
- begin 时发现 memory/sleep/soul-changelog.md（她照旧说明记到了老地方）：新行去重并进 sleep/soul-changelog.md，删掉旧文件。
退出码：0 好了；2 拒绝或失败（看报告）；3 另一个整理正在应用。
"""
import argparse
import contextlib
import datetime as dt
import difflib
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath

from night_names import OWNER, RETIRED_FILES, owner_key, retired_flag  # noqa: E402
from zoneinfo import ZoneInfo

from hh_env import forms, words  # noqa: E402

say = words(__file__)
form = forms(__file__)

TZ = ZoneInfo(os.environ['HH_TZ'])
DAY_START = 4                     # 她的一天凌晨 4 点才换
SCRIPTS = Path(__file__).resolve().parent   # this module's scripts
WS = Path(os.environ.get('HH_WORKSPACE') or SCRIPTS.parent)  # the tests run the scripts from a copied workspace's scripts/
OWNER_KEY = owner_key(WS)
HOME = Path(os.path.expanduser('~'))
PY = '/usr/bin/python3'
ORGANIZER_JOB = 'sleep-organize'  # cron 任务名（查它自己用 write/edit 写过哪些记忆文件）

DEFER_PCT = 70                    # 5 小时窗口 ≥ 这个、而且 05:30 前会重置：02:30 那一跑推迟到 05:30
SAVE_PCT = 85                     # 5 小时窗口 ≥ 这个，或 7 天窗口 ≥ SAVE_WEEK_PCT：省电模式
SAVE_WEEK_PCT = 97
LATE_RUN = (5, 30)                # 补跑的钟点

HELD = ('MEMORY.md', 'USER.md')   # 只留给她自己合并
PREVIEWS = ('SOUL.md', 'SOUL.memory.md', 'memory/recent.md')   # SOUL.memory.md：soul_build 拼的记忆块（主人 10-29）
# 访客镜头 SOUL.lens-<id>.md：soul_build.py 和 SOUL.md 一起拼的（根目录、--root 草稿目录都写），也是预览
LENS_RE = re.compile(r'SOUL\.lens-[^/\\]+\.md')
CHANGELOG = 'sleep/soul-changelog.md'
OLD_CHANGELOG = 'memory/sleep/soul-changelog.md'   # 10-25 搬家前的位置：begin 时并进新的；写在这里的提案也算 changelog
KEEP_STEP_DAYS = 30               # state.json 的 steps 只留最近这么多天
MAX_INCOMPLETE_NIGHTS = 2         # 材料不完整最多拖这么多晚（和 sleep_digest.py 的 MAX_DEFER_NIGHTS 一样）
KEEP_KEYS = ('cycle', 'material', 'deferred_files', 'refused_deletes', 'carried', 'guard_deferred', 'promoted')   # 开新一轮时保留的记录
# 白天提交的范围：她和白天任务没提交的改动（整理的工作目录、进度、锁文件不算；sleep/ 下的 changelog、config.json 算）
# memory/sleep/ 是搬家前的老地方：万一又冒出来，各天的目录、state.json、锁文件照旧不提交
DAY_SPEC = ('memory', 'soul', 'skills', 'MEMORY.md', 'USER.md', 'SOUL.md', 'SOUL.memory.md', 'senses/gate.json', 'sleep',
            ':(exclude)sleep/2*', ':(exclude)sleep/state.json', ':(exclude)sleep/.*',
            ':(exclude)memory/sleep/2*', ':(exclude)memory/sleep/state.json', ':(exclude)memory/sleep/.*')
# 整理的工作目录、进度（各天的 sleep/<日期>/、state.json）跟记忆提交；人格 changelog 跟人格提交
SLEEP_SPEC = ('sleep', ':(exclude)sleep/soul-changelog.md', ':(exclude)sleep/config.json', ':(exclude)sleep/.*')
# 整理期间（begin 之后）除了应用，谁都不该动的：动了就整晚不应用
GUARD_BLOCK = ('soul', 'memory/people/registry.json')
# 整理期间被别人改了要写进报告（不拦）：会留到下一晚的白天提交
GUARD_NOTE = ('skills', 'MEMORY.md', 'USER.md')
GUARD_IGNORE = ('soul/.protected.json',)            # soul_build.py --root 会顺手重写它（内容不变）
LAUNCH_AGENTS_SELF_UPDATING = ('com.google.GoogleUpdater.wake.plist', 'com.google.keystone.agent.plist',
                               'com.google.keystone.xpcservice.plist')   # 谷歌自己会改的
REBUILD = (                       # 应用后重新生成（脚本在 SCRIPTS 里，跑的时候才拼路径）
    ('midterm.py build', ['midterm.py', 'build']),
    ('soul_build.py', ['soul_build.py']),
    ('ledger_snapshot.py', ['-I', 'ledger_snapshot.py']),
)
DAY_RE = re.compile(r'^\d{4}-\d\d-\d\d$')
SHRINK_PCT = 25                   # 缩水保护：一个提案删掉 / 改写了原文件超过这么多的内容行就推迟……
SHRINK_MOVE_PCT = 50              # 原样挪进 archive / 别的文件的不算丢（主人 10-26：只淡出，不删）；但一晚挪走超过这么多还是大压缩，等人批
SHRINK_MIN = 5                    # ……而且至少这么多行
SHRINK_EXEMPT = ('memory/midterm/self.md', 'memory/midterm/people.md')   # 指南第 2、3 步：每晚从材料重写，不算缩水
# 2 期（人物迁进事件库）：迁移那天这 11 个文件挪进 memory/archive/retired-20261103/<memory/ 下的相对路径>（计划 P9）
RETIRED_FLAG = retired_flag(OWNER_KEY)
RETIRED_PEOPLE = RETIRED_FILES
SOUL_CAP = None                   # 人格上限：主人 10-29 去掉（照 memory/layout.json 的原则改，不限处数；缩水保护、大压缩照旧）。设成数字就恢复：当晚人格块合计改动超过这么多处，人格块的提案全部推迟……
SOUL_GAP = 2                      # ……中间只隔这么几行没改的两段改动算一处
SNAPSHOT_MARK = '<!-- 注入：快照 -->'  # 带这个的人格文件（70 教训、75 学到的、80 我的经历）是学习记录，每晚重写快照：不算人格上限
# 指南第 5 步每晚重写、文件却没带快照标记的那一节（标题里有这几个字，到下一个同级或更高级的标题为止）：里面的改动不算人格上限
SOUL_CAP_SKIP = {}   # 11-04 清掉「最近的口味和兴趣」：soul/30 已经没有那一节（口味进了总结段「口味」，那是要受保护的，不跳过）
# 笔记本（skills/，学习系统 11-01）：两道闸门（不丢行、编号都在）不过，这一晚 skills/ 的提案整批不应用
NOTEBOOK = 'skills'
NOTEBOOK_ARCHIVE = form.every('noteArchive')   # skills/ 里任何一层的 归档/ 都是归档（照样算 skills/，丢行检查照样找）
NOTEBOOK_SHOW = 10                # 报告里每样最多列这么多条
LEARN_IDS_TIMEOUT = 10            # hh learn ids 最多等这么多秒：hhd 没开、卡住就跳过编号闸门
# HH 认的编号注释（和 human-harness/src/learning/notebook.ts 的 PAGE_ID、LESSON_ID 一样）：
# 页 <!-- p:0012 -->，教训 <!-- l:0039 -->；一个注释里可以有几个号（后面的是并进来的旧号）
PAGE_ID = re.compile(r'<!-- (p:\d{4,}(?:\s+p:\d{4,})*) -->')
LESSON_ID = re.compile(r'<!-- (l:\d{4,}(?:\s+l:\d{4,})*) -->')
HH_LESSON_LINE = re.compile(r'^[-*]\s+(?:' + '|'.join(map(re.escape, form.every('noteLesson'))) + r')[：:]')    # HH 读页时认的教训行（notebook.ts 的 LESSON_LINE）
FENCE = re.compile(r'^\s*(```|~~~)')
NOT_PAGES = ('SKILL.md', 'CHANGELOG.md', 'MAP.md')   # 不是页：里面的编号 HH 不认
LESSON_LINE = re.compile(r'^\s*[-*]\s+(?:' + '|'.join(map(re.escape, form.every('noteLesson'))) + r')[：:]')
LIST_ITEM = re.compile(r'^\s*(?:[-*+]|\d+[.)、])\s+')
# 比内容用的「核心」：开头的列表记号、编号、勾选框、✓、状态标记（「没验证过」「学会了」「待验证」「靠谱」「不再用（…）」，
# 连同后面的冒号）一层层去掉——改编号、打勾、升级、标没验证过、标不再用都算原样还在
CORE_PREFIX = re.compile(r'^(?:[-*+]\s+|\d+[.)、]\s*|\[[ xX]\]\s*|[✓✔]\s*'
                         r'|「?(?:' + '|'.join(form.every('noteStatus')) + r')」?\s*[：:]?\s*)')
CLAUSE_SEP = re.compile(r'[；。｜]')    # 一行拆成几行、教训行加犯的日子和出处：按这几个切开，每段都在就算还在
COVER_LINE = re.compile(r'^(?:' + '|'.join(map(re.escape, form.every('noteCover'))) + r')[：:]')   # 页的封面（第一个 ## 之前）：常收紧，丢行检查不管


class Ctx:
    """工作目录和外部路径（测试用 --root / --home / --state-db 换成沙箱）。"""

    def __init__(self, root=None, home=None, state_db=None):
        self.ws = Path(root).resolve() if root else WS
        self.home = Path(home) if home else HOME
        self.sleep = self.ws / 'sleep'
        self.state = self.sleep / 'state.json'
        self.config = self.sleep / 'config.json'
        # 应用锁放 .git/ 里（不会被提交）；没有 .git 就放 sleep/
        self.locks = self.ws / '.git' if (self.ws / '.git').is_dir() else self.sleep
        # cron 任务和记忆写入记录都在 OpenClaw 的状态库里；'none' = 不查
        # the old agent platform's scheduler database (config legacyStateDb); 'none' = this role has no such platform
        self.state_db = state_db if state_db is not None else (json.loads(os.environ.get('HH_MODULE_CONFIG') or '{}').get('legacyStateDb') or 'none')

    def day_dir(self, day):
        return self.sleep / day


# ---------- 小工具 ----------

def now():
    return dt.datetime.now(TZ)


def now_iso():
    return now().isoformat(timespec='seconds')


def night_id(t=None):
    """「哪一晚」：02:30 和 05:30 算同一晚（和 sleep_digest.py 的 night_id 一样）。"""
    return ((t or now()) - dt.timedelta(hours=12)).date().isoformat()


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha(p):
    try:
        with open(p, 'rb') as f:
            return sha_bytes(f.read())
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        return None
    except OSError as e:   # there but not readable (permissions, a sandbox): that is its fingerprint, not a crash
        return f'unreadable:{type(e).__name__}'


def read_text(p, default=''):
    try:
        return Path(p).read_text(encoding='utf-8')
    except (FileNotFoundError, IsADirectoryError):
        return default


def read_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def write_atomic(p, data, mode=None):
    """先写临时文件再改名；保留原文件的权限。"""
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    if mode is None:
        try:
            mode = os.stat(p).st_mode & 0o777
        except FileNotFoundError:
            mode = 0o644
    tmp = p.with_name(f'.{p.name}.tmp{os.getpid()}')
    with open(tmp, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, p)


def write_json_atomic(p, obj):
    write_atomic(p, json.dumps(obj, ensure_ascii=False, indent=1) + '\n')


def check_day(s):
    if not DAY_RE.match(s or ''):
        raise SystemExit(say("applyBadDay", s=s))
    dt.date.fromisoformat(s)
    return s


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def soul_name(rel):
    """soul/20-性格.md → 性格（changelog 里的「块名」）。"""
    return re.sub(r'^\d+-', '', PurePosixPath(rel).stem)


def changelog_block(line):
    m = next((m for r in form.every('changelogBlock') if (m := re.search(r, line or ''))), None)   # 「块名」, "block"
    return m.group(1) if m else None


# ---------- state.json（只动 steps 和 last_applied_at，别人的键原样保留） ----------

@contextlib.contextmanager
def file_lock(path, blocking=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def state_update(ctx, fn):
    # 和 sleep_digest.py 用同一把锁（sleep/.state.lock），谁改 state.json 都排队
    with file_lock(ctx.sleep / '.state.lock'):
        st = read_json(ctx.state, {})
        fn(st)
        write_json_atomic(ctx.state, st)
        return st


def get_steps(ctx, day):
    return dict(read_json(ctx.state, {}).get('steps', {}).get(day, {}))


def set_step(ctx, day, name, status='done', **extra):
    def f(st):
        steps = st.setdefault('steps', {})
        d = steps.setdefault(day, {})
        if name:
            d[name] = status
        d.update(extra)
        d['updated'] = now_iso()
        for k in sorted(steps)[:-KEEP_STEP_DAYS]:
            steps.pop(k, None)
    state_update(ctx, f)


def is_done(steps, name):
    return steps.get(name) == 'done'


# ---------- 提案 ----------

def is_preview(rel):
    return rel in PREVIEWS or bool(LENS_RE.fullmatch(rel))


def lens_files(ctx):
    """根目录的访客镜头：和 SOUL.md 一样是生成的，跟着 SOUL.md 一起提交。"""
    return sorted(p.name for p in ctx.ws.glob('SOUL.lens-*.md') if LENS_RE.fullmatch(p.name))


def events_only(ctx):
    """10-31 起事件只在事件库里（主人）：工作区里没有 memory/threads/ 了 = 事件线和时间轴已经收进档案。"""
    return not (ctx.ws / 'memory' / 'threads').is_dir()


def retired_active(ctx):
    """2 期的新行为开没开：memory/archive/retired-20261103/<主人>.md 在不在（迁移那天才挪进去）。"""
    return (ctx.ws / RETIRED_FLAG).exists()


def kind_of(rel, retired=False, people=False):
    """提案路径归类：memory / soul / changelog / held / preview / refuse（不应用，不拦）/ bad（整晚拒绝）/
    retired（退役的人物文件：跳过，报告里警告一行）。
    retired：事件线和时间轴已经收进档案（events_only），它们的提案不收。
    people：2 期的人物文件已经退役（retired_active），RETIRED_PEOPLE 的提案跳过。"""
    parts = PurePosixPath(rel).parts
    if not parts or rel.startswith('/') or '..' in parts or any(x.startswith('.') for x in parts):
        return 'bad', say("applyBadPath")
    if rel in HELD:
        return 'held', say("applyHeld")
    if is_preview(rel):
        return 'preview', say("applyPreview")
    if rel in (CHANGELOG, OLD_CHANGELOG):
        return 'changelog', ''
    top = parts[0]
    if top == 'sleep':
        return 'bad', say("applySleepOnly")
    if top == 'memory':
        if people and rel in RETIRED_PEOPLE:
            return 'retired', (say("applyRetired"))
        if retired and len(parts) > 1 and (parts[1] == 'threads' or rel == 'memory/timeline.md'):
            return 'refuse', say("applyEventsOnly")
        if len(parts) > 1 and parts[1] == 'sleep':
            return 'bad', say("applyOldSleepDir")
        if not rel.endswith('.md'):
            return 'refuse', say("applyMdOnly")
        return 'memory', ''
    if top == 'skills' and len(parts) >= 2:
        if not rel.endswith('.md'):
            return 'bad', say("applySkillsMdOnly")
        return 'memory', ''          # 手册和记忆一起提交
    if top == 'soul':
        if len(parts) == 2 and rel.endswith('.md'):
            return 'soul', ''
        return 'refuse', say("applySoulMdOnly")
    return 'bad', say("applyOutside")


def proposed_files(ctx, day, sub='proposed'):
    base = ctx.day_dir(day) / sub
    out = []
    if not base.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        dirnames.sort()
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            out.append((p.relative_to(base).as_posix(), p))
    return out


def load_sources(ctx, day):
    p = ctx.day_dir(day) / 'sources.json'
    d = read_json(p, None)
    if d is None:
        return None
    if d.get('day') not in (None, day):
        raise ValueError(say("applySourcesWrongDay", p=p, a=d.get("day"), day=day))
    return d.get('files') or {}


OFF_WS = say("applyOffWs")


def off_ws(ctx, live):
    """The file's real path leaves the workspace through a linked directory (a module's manuals linked onto the shelf
    live in the HH code every role shares): the night neither writes nor deletes it."""
    return not os.path.realpath(live).startswith(os.path.realpath(ctx.ws) + os.sep)


def read_delete_list(ctx, day):
    out = []
    for line in read_text(ctx.day_dir(day) / 'delete.txt').splitlines():
        line = line.split('#', 1)[0].strip()
        if line:
            out.append(line)
    return out


def changelog_additions(live, prop):
    """提案里有、原文件里没有的行（按行追加，她白天记的行不动）。"""
    have = {l.rstrip() for l in read_text(live).splitlines()}
    out = []
    for l in read_text(prop).splitlines():
        l = l.rstrip()
        if l.strip() and l not in have and l not in out:
            out.append(l)
    return out


def content_lines(text):
    out = []
    for l in text.splitlines():
        s = norm(l)
        if len(s) < 4 or s.startswith('#') or s.startswith('<!--'):
            continue
        out.append(s)
    return out


def shrink_of(live_text, prop_text):
    """提案比原文件少了哪些内容行（原文件里有、提案里哪都没有的；改写过的旧说法、挪进 archive 的都算），和原文件一共几行。"""
    old = content_lines(live_text)
    keep = set(content_lines(prop_text))
    return [l for l in old if l not in keep], len(old)


def drop_sections(text, titles):
    """去掉标题里含 titles 之一的那几节的正文（每晚重写的快照小节不参与缩水保护）。"""
    lines = text.split('\n')
    cut = set()
    for a, b in section_spans(lines, titles):
        cut.update(range(a, b))
    return '\n'.join(l for i, l in enumerate(lines) if i not in cut)


def preserved_elsewhere(ctx, day):
    """当晚别处还留着的内容行：{提案相对路径: 行集合}，和现有 memory/archive/ 里的行集合。"""
    root = ctx.day_dir(day) / 'proposed'
    by = {str(q.relative_to(root)): set(content_lines(read_text(q))) for q in root.rglob('*.md')} if root.is_dir() else {}
    if retired_active(ctx):              # 2 期：退役人物文件的提案跳过、不会换进去，挪进那里的行不算还在
        by = {k: v for k, v in by.items() if k not in RETIRED_PEOPLE}
    arch = set()
    adir = ctx.ws / 'memory' / 'archive'
    if adir.is_dir():
        for q in adir.rglob('*.md'):
            arch |= set(content_lines(read_text(q)))
    return by, arch


def section_spans(lines, titles):
    """标题里含 titles 之一的那几节的正文（标题下一行起，到下一个同级或更高级的标题为止）：[(起, 止)]。"""
    spans, level, start = [], None, 0
    for i, l in enumerate(lines):
        m = re.match(r'^(#{1,6})\s*(.*)$', l)
        if not m:
            continue
        if level is not None and len(m.group(1)) <= level:
            spans.append((start, i))
            level = None
        if level is None and any(x in m.group(2) for x in titles):
            level, start = len(m.group(1)), i + 1
    if level is not None:
        spans.append((start, len(lines)))
    return spans


def soul_hunks(live_text, prop_text, gap=SOUL_GAP, skip=()):
    """人格提案和原文件比有几处改动：difflib 按行比，不是 equal 的段；中间只隔 gap 行没改的两段算一处；
    skip 里那几节（按标题找）正文里的改动不算（当作没改的行）。"""
    a, b = live_text.splitlines(), prop_text.splitlines()
    sa, sp = (section_spans(a, skip), section_spans(b, skip)) if skip else ([], [])

    def inside(lo, hi, spans):
        return any(s <= lo and hi <= e for s, e in spans)
    n, since = 0, None                     # since：上一处算数的改动之后隔了几行
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag != 'equal' and not (inside(i1, i2, sa) and inside(j1, j2, sp)):
            if since is None or since > gap:
                n += 1
            since = 0
        elif since is not None:
            since += max(i2 - i1, j2 - j1)
    return n


def is_snapshot_block(live_text, prop_text, creating=False):
    """学习记录式的人格文件（带「注入：快照」，指南第 5 步每晚重写快照）：原文件（新建的看提案）和提案里都带着这个标记。"""
    return SNAPSHOT_MARK in prop_text and (creating or SNAPSHOT_MARK in live_text)


def jingguo_lines(text):
    """事件线「经过」那一节（标题以「经过」开头，到下一个同级或更高级的标题为止）的内容行；没有这一节返回 None。"""
    out, level, found = [], None, False
    for l in text.splitlines():
        m = re.match(r'^(#{1,6})\s*(.*)$', l)
        if m:
            if level is not None and len(m.group(1)) <= level:
                level = None
            if level is None and m.group(2).strip().startswith('经过'):
                level, found = len(m.group(1)), True
            continue
        if level is not None:
            out += content_lines(l)
    return out if found else None


def load_approved(ctx, day):
    """人工批准过的提案：{文件: 批准时提案的 sha}（sleep/<日期>/approved.json，approve 写的）。"""
    d = read_json(ctx.day_dir(day) / 'approved.json', {})
    return {rel: (v or {}).get('sha') for rel, v in (d.get('files') or {}).items()}


def texts_after(ctx, day, items, exclude, tops=('memory', 'soul', 'skills')):
    """应用之后（items 里要换的提案换进去以后）tops 这几个目录下每个 .md 的全文：{相对路径: 全文}。
    生成的文件（SOUL.md、memory/recent.md）、要删的文件（exclude）、还没应用的提案都不算。items 给空的 = 现在的样子。"""
    D = ctx.day_dir(day)
    final = {}
    for top in tops:
        base = ctx.ws / top
        if not base.is_dir():
            continue
        for p in base.rglob('*.md'):
            rel = p.relative_to(ctx.ws).as_posix()
            if rel.startswith('memory/sleep/') or p.is_symlink():
                continue
            final[rel] = None                              # 先占位，下面统一读
    for it in items:
        if (it.get('op') != 'delete' and it['kind'] in ('memory', 'soul') and it['action'] in ('apply', 'create')
                and PurePosixPath(it['rel']).parts[0] in tops):
            final[it['rel']] = read_text(D / 'proposed' / it['rel'])
    return {rel: (t if t is not None else read_text(ctx.ws / rel))
            for rel, t in final.items() if rel not in exclude and not is_preview(rel)}


def corpus_after(ctx, day, items, exclude):
    """应用之后记忆、人格、手册的全文，用来核「删了会不会丢」。"""
    return norm('\n'.join(texts_after(ctx, day, items, exclude).values()))


def lost_lines(text, corpus):
    return [l for l in content_lines(text) if l not in corpus]


# ---------- 笔记本（skills/）的闸门（学习系统 11-01，spec 第 7 节「夜里的改动怎么落地」） ----------

def is_notebook(it):
    return it['kind'] == 'memory' and PurePosixPath(it['rel']).parts[0] == NOTEBOOK


def notebook_changes(items):
    """这一晚要换进 skills/ 的：覆盖、新建、删除。"""
    return [it for it in items if is_notebook(it) and it['action'] in ('apply', 'create', 'delete')]


def ids_of(rx, line):
    """这一行编号注释带的编号（不带 p:/l:，和 hh learn ids 一样）。"""
    return {x[2:] for m in rx.finditer(line) for x in m.group(1).split()}


def strip_ids(text):
    """去掉编号注释：挪进归档、并掉的条目，编号注释跟不跟着走都算内容还在（编号由编号闸门管）。"""
    return LESSON_ID.sub('', PAGE_ID.sub('', text))


def core(line):
    """比内容用的样子：去掉编号注释，开头的列表记号、编号、勾选框、✓、状态标记一层层去掉，空白合并。"""
    s = norm(strip_ids(line))
    while True:
        t = CORE_PREFIX.sub('', s, count=1).strip()
        if t == s:
            return s
        s = t


def page_ids(rel, text):
    """HH 读页时认的编号（照 human-harness/src/learning/notebook.ts 的 parsePage）：页号只认第一个 ## 之前的第一个 # 标题行，
    教训号只认「## 教训」下面的 - 教训： 行；代码块里、做法和旧做法里、SKILL.md / CHANGELOG.md / MAP.md 里的都不算。归档的页一样认。"""
    if PurePosixPath(rel).name in NOT_PAGES:
        return set()
    out, section, titled, fence = set(), '', False, False
    for l in text.lstrip('\ufeff').splitlines():
        if FENCE.match(l):
            fence = not fence
        elif fence or l.startswith('### '):
            continue
        elif l.startswith('## '):
            section = l[3:].strip()
        elif section == '' and not titled and l.startswith('# '):
            titled = True
            out |= ids_of(PAGE_ID, l)
        elif section in form.every('noteLessons') and HH_LESSON_LINE.match(l):
            out |= ids_of(LESSON_ID, l)
    return out


def guarded_lines(rel, text):
    """丢行检查要核的内容行（原样）。本来就该常改、不核的：skills/MAP.md、CHANGELOG.md 整个；页第一个 ## 之前的封面
    （标题、简介、什么时候翻）；SKILL.md 开头的 frontmatter（name、description）和目录条目（点到某个 .md 的列表项）。
    SKILL.md 别的行照核（搬家前手册就写在 SKILL.md 里）。"""
    p = PurePosixPath(rel)
    if rel == f'{NOTEBOOK}/MAP.md' or p.name == 'CHANGELOG.md':
        return []
    skill = p.name == 'SKILL.md'
    lines = text.lstrip('\ufeff').splitlines()
    front = skill and bool(lines) and lines[0].strip() == '---'
    cover = not skill
    out = []
    for i, l in enumerate(lines):
        if front:                                  # frontmatter：到第二个 --- 为止（含）
            front = i == 0 or l.strip() != '---'
            continue
        if l.startswith('## '):
            cover = False
        if (cover and COVER_LINE.match(l)) or (skill and LIST_ITEM.match(l) and re.search(r'\.md\b', l)):
            continue
        s = norm(strip_ids(l))
        if len(s) >= 4 and not s.startswith('#') and not s.startswith('<!--'):
            out.append(l)
    return out


def notebook_lost(before, after, rels):
    """rels 这几个文件（被覆盖、被删的）里，应用后的 skills/ 哪都找不到的内容行：[(文件, 那一行)]。
    找得到 = 它的核心是应用后某一行核心的一部分（挪走、改编号、打勾、后面加日期、标状态都算还在）；
    或者按「；」「。」「｜」切开，每一段（核心 4 个字以上）都在应用后的核心里（拆成几行、教训行加犯的日子和出处都算还在）。"""
    cores = '\n'.join(core(l) for t in after.values() for l in t.splitlines())
    out = []
    for rel in rels:
        for l in guarded_lines(rel, before.get(rel, '')):
            c = core(l)
            if c in cores:
                continue
            parts = [x for x in (core(x) for x in CLAUSE_SEP.split(c)) if len(x) >= 4]
            if not (parts and all(x in cores for x in parts)):
                out.append((rel, norm(strip_ids(l))))
    return out


def learn_ids(ctx):
    """HH 认得的编号（hh learn ids：一行一个，含别名；空的 = 还没发过号）。
    返回 (编号集合, None)；拿不到（hhd 没开、超时、跑不起来）返回 (None, 原因)。"""
    cmd = [os.environ['HH_BIN'], 'learn', 'ids']
    try:
        # HH 的配置分层上线后不带 HH_CONFIG 会在启动检查处退出，不靠继承（11-14 运维）
        env = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(Path(os.environ['HH_STATE_DIR']) / 'config.json'))
        p = subprocess.run(cmd, capture_output=True, encoding='utf-8', errors='replace', timeout=LEARN_IDS_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        return None, say("applyLearnIdsTimeout", learn_ids_timeout=LEARN_IDS_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as e:
        return None, say("applyLearnIdsNoRun", name=type(e).__name__)
    if p.returncode != 0:
        return None, say("applyLearnIdsError", returncode=p.returncode, strip=(p.stderr or p.stdout).strip()[-120:])
    return {re.sub(r'^[pl]:', '', x.strip()) for x in p.stdout.splitlines() if x.strip()}, None


def notebook_gate(ctx, day, items):
    """两道闸门，在应用前用计划算（应用前的 skills/ = 现在的样子，应用后的 = 提案换进去、要删的删掉）：
    - 丢行：被覆盖、被删的 skills/ 文件里的内容行，在应用后的 skills/（含归档）里要找得到（挪走可以，丢了不行；怎么算找得到、
      哪些行不核，见 notebook_lost、guarded_lines）；
    - 编号：HH 认得（hh learn ids）、应用前 skills/ 里也有的编号，应用后要还在 HH 认的位置上（页的标题行、「## 教训」下的教训行，
      见 page_ids；白天删掉、HH 还没扫到的不算）。
    任何一道不过，这一晚 skills/ 的提案整批推迟（其余照常）。返回写进报告的几行。"""
    nb = notebook_changes(items)
    if not nb:
        return []
    before = texts_after(ctx, day, [], set(), (NOTEBOOK,))
    after = texts_after(ctx, day, items, {it['rel'] for it in nb if it['action'] == 'delete'}, (NOTEBOOK,))
    why = [say("applyNotebookLost", rel=rel, s=s[:40])
           for rel, s in notebook_lost(before, after, [it['rel'] for it in nb if it['action'] != 'create'])]
    notes = []
    known, err = learn_ids(ctx)
    if known is None:
        notes.append(say("applyNotebookIdsSkipped", err=err))
    else:
        had = {}
        for rel, t in before.items():
            for i in page_ids(rel, t):
                had.setdefault(i, rel)
        kept = set()
        for rel, t in after.items():
            kept |= page_ids(rel, t)
        why += [say("applyNotebookIdGone", i=i, had=had[i]) for i in sorted((set(had) & known) - kept)]
    if why:
        for it in nb:
            it.update(action='defer', reason=say("applyNotebookGate"))
        more = say("applyNotebookMore", a=len(why) - NOTEBOOK_SHOW) if len(why) > NOTEBOOK_SHOW else ''
        notes.insert(0, say("applyNotebookNotSwapped", a=say("applySemicolon").join(why[:NOTEBOOK_SHOW]), more=more))
    return notes


def entry_lines(text):
    """进笔记本要过把关的行：教训行（- 教训：…），和「## 做法」那一节（到下一个一、二级标题为止）里的每一行（条目、段落都算）。"""
    out, method, fence = [], False, False
    for l in text.splitlines():
        if FENCE.match(l):
            fence = not fence
            continue
        m = None if fence else re.match(r'^(#{1,6})\s*(.*)$', l)
        if m:
            if len(m.group(1)) <= 2:
                method = len(m.group(1)) == 2 and m.group(2).strip().startswith(form.every('notePractices'))
            continue
        if LESSON_LINE.match(l) or (method and l.strip()):
            out.append(l)
    return out


def entry_key(s):
    """和把关的 finalText 比的样子：核心（见 core）再去掉开头的「教训：」。"""
    return norm(re.sub(r'^(?:' + '|'.join(map(re.escape, form.every('noteLesson'))) + r')[：:]', '', core(s)))


def unchecked_entries(ctx, day, items):
    """没过把关就进笔记本的：应用后新出现的教训行和「## 做法」下的行，不等于把关收下（add / merge）的任何一条 finalText。
    按核心比（见 core）：核心在应用前 skills/ 哪一行里找得到的、包着应用前某一行核心的（改编号、打勾、加日期）、
    教训正文没变只加了犯的日子和出处的，都是改，不算新进来的。归档不算进笔记本。只报告，不拦。返回 [(文件, 那一行)]。
    把关的结论读 <状态目录>（HH_STATE_DIR）/learn/check/<日>.json（HH 的把关写在那）；没有、读不了 = 一条都没收（全列，好发现没照指南走）。"""
    nb = notebook_changes(items)
    if not nb:
        return []
    olds = {core(l) for t in texts_after(ctx, day, [], set(), (NOTEBOOK,)).values() for l in t.splitlines()}
    before = '\n'.join(olds)
    after = texts_after(ctx, day, items, {it['rel'] for it in nb if it['action'] == 'delete'}, (NOTEBOOK,))
    try:
        verdicts = json.loads((Path(os.environ['HH_STATE_DIR']) / 'learn/check' / f'{day}.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        verdicts = []
    ok = {entry_key(v['finalText']) for v in (verdicts if isinstance(verdicts, list) else [])
          if isinstance(v, dict) and v.get('verdict') in ('add', 'merge') and isinstance(v.get('finalText'), str)}
    out = []
    for rel, text in after.items():
        if any(a in PurePosixPath(rel).parts for a in NOTEBOOK_ARCHIVE):
            continue
        for l in entry_lines(text):
            c = core(l)
            if len(c) < 4 or c in before or entry_key(l) in ok:
                continue
            if any(o in c for o in olds if len(o) >= 4):   # 旧的一行加了东西（✓、日期、说明）：是改，不是新进来的
                continue
            if LESSON_LINE.match(l) and c.split('｜', 1)[0] in before:   # 教训正文没变，只加了犯的日子、出处
                continue
            out.append((rel, norm(strip_ids(l))))
    return out


def unchecked_report(entries):
    """报告里的几行：最多列 NOTEBOOK_SHOW 条，每条截到 80 个字。"""
    out = [say("applyUnchecked", s=s[:80], a=say("applyEllipsis") if len(s) > 80 else '', rel=rel) for rel, s in entries[:NOTEBOOK_SHOW]]
    if len(entries) > NOTEBOOK_SHOW:
        out.append(say("applyUncheckedMore", a=len(entries) - NOTEBOOK_SHOW))
    return out


def load_lint_failed(ctx, day):
    d = read_json(ctx.day_dir(day) / 'lint.json', None)
    if not d:
        return None
    return set(d.get('failed_files') or [])


def gitignored(ctx, rels):
    """这些路径里哪些在 .gitignore 里（换进去也提交不了）。"""
    rels = [r for r in rels if r]
    if not rels or not (ctx.ws / '.git').exists():
        return set()
    p = subprocess.run(['git', '-C', str(ctx.ws), 'check-ignore', '-z', '--stdin'],
                       input='\0'.join(rels) + '\0', capture_output=True, text=True)
    return {x for x in (p.stdout or '').split('\0') if x}


def earlier_deferred(ctx, day, max_days=14):
    """以前那些晚上被推迟的提案：{文件: [(那天, 提案路径, 那晚这个文件的底稿 hash)]}（看最近 max_days 天）。"""
    st = read_json(ctx.state, {}).get('steps', {})
    out = {}
    for d in sorted(st)[-max_days - 1:]:
        if d >= day:
            continue
        for rel in st[d].get('deferred_files') or []:
            D = ctx.day_dir(d)
            for base in [D / 'proposed'] + sorted(D.glob('cycle-*/proposed')):
                p = base / rel
                if p.is_file():
                    try:
                        src = (read_json(base.parent / 'sources.json', {}).get('files') or {}).get(rel)
                    except ValueError:
                        src = None
                    out.setdefault(rel, []).append((d, p, src))
    return out


def make_plan(ctx, day, lint_failed=None):
    """每个提案的去向。action：apply 覆盖 / create 新建 / same 已经一样 / defer 推迟 / refuse 拒绝（不拦）/
    bad 拒绝（整晚不应用）/ held 留给她 / preview 预览 / append 追加 changelog / delete 删除 / gone 已经删了。"""
    srcs = load_sources(ctx, day)
    old = earlier_deferred(ctx, day)
    approved = load_approved(ctx, day)
    # 这一晚回滚过的那一类（rollback）：重跑 finish 不能又把它换回去；要重做就 restart 开新一轮
    rb = {(x.get('kind') or ('soul' if x.get('tag', '').split('/')[-1].startswith('soul') else 'memory')).replace('promote-', '')
          for x in get_steps(ctx, day).get('rolled_back') or []}
    rb_why = (lambda k: say("applyRolledBack", a=say("applyWordSoul") if k == "soul" else say("applyWordMemory"), day=day))
    items, proposed = [], set()
    elsewhere = None                       # 当晚别处还留着的行（缩水保护用，用到才算）
    people = retired_active(ctx)
    for rel, p in proposed_files(ctx, day):
        proposed.add(rel)
        kind, why = kind_of(rel, events_only(ctx), people)
        live = ctx.ws / (CHANGELOG if kind == 'changelog' else rel)    # 写在老地方的 changelog 提案也追加进 sleep/ 那份
        it = {'rel': rel, 'kind': kind, 'new': sha(p), 'cur': None, 'base': None}
        if kind in ('memory', 'soul') and approved.get(rel) and approved[rel] == it['new']:
            it['approved'] = True
        if kind == 'bad':
            it.update(action='bad', reason=why)
            items.append(it)
            continue
        if os.path.islink(p) or os.path.islink(live):
            it.update(action='bad', reason=say("applySymlink"))
            items.append(it)
            continue
        if off_ws(ctx, live):
            it.update(action='refuse', reason=OFF_WS)
            items.append(it)
            continue
        if kind == 'retired':              # 2 期：退役的人物文件，跳过（不算 bad，报告里警告一行）
            it.update(action='retired', reason=why)
            items.append(it)
            continue
        it['cur'] = sha(live)
        if kind in ('refuse', 'preview'):
            it.update(action=kind, reason=why)
        elif kind == 'held':
            it.update(action='held' if it['new'] != it['cur'] else 'same', reason=why)
        elif kind == 'changelog':
            add = changelog_additions(live, p)
            it.update(action='append' if add else 'same', lines=len(add))
        elif it['new'] == it['cur']:
            it.update(action='same', reason=say("applySameAlready"))
        elif srcs is None:
            it.update(action='defer', reason=say("applyNoSources"))
        elif rel in srcs:
            it['base'] = srcs[rel]
            if it['cur'] == srcs[rel]:
                it.update(action='apply' if it['cur'] else 'create')
            else:
                it.update(action='defer', reason=say("applyChangedAfter") if it['cur'] else say("applyDeletedAfter"))
        elif it['cur'] is None:
            it.update(action='create')
        else:
            it.update(action='defer', reason=say("applyAppearedAfter"))
        if it.get('action') in ('apply', 'create'):
            for d, op, src in old.get(rel, []):
                # 那晚的底稿就是现在的原文件（比如被笔记本的闸门整批挡下的）：照着重做一模一样也盖不掉什么，不算拷
                if sha(op) == it['new'] and src != it['cur']:
                    it.update(action='defer', reason=say("applyCopiedDeferred", d=d))
                    break
        if lint_failed is not None and rel in lint_failed and it.get('action') in ('apply', 'create'):
            it.update(action='defer', reason=say("applyLintBlock"))
        if it.get('action') in ('apply', 'create') and kind in rb:
            it.update(action='defer', reason=rb_why(kind))
        if it.get('action') == 'apply' and kind in ('memory', 'soul') and not it.get('approved') and rel not in SHRINK_EXEMPT:
            live_text, prop_text = read_text(live), read_text(p)
            jg = jingguo_lines(live_text) if rel.startswith('memory/threads/') else None
            if jg is not None:
                # 事件线：一句话、简述、现在的状态、因果和判断、元数据随便改写；「经过」只加不删（合并重复可以，每一步都要还在）
                keep = set(jingguo_lines(prop_text) or [])
                miss = [l for l in jg if l not in keep]
                if miss:
                    it.update(action='defer', guard='jingguo', missing=miss[:5],
                              reason=say("applyLogShrank", a=len(miss), miss=miss[0][:30]))
                gone, total = [], 0
            else:
                skip = SOUL_CAP_SKIP.get(rel, ())
                if skip:                                         # SOUL_CAP_SKIP 里每晚重写的小节，不算
                    live_text, prop_text = drop_sections(live_text, skip), drop_sections(prop_text, skip)
                gone, total = shrink_of(live_text, prop_text)
            lost = gone
            if gone:
                if elsewhere is None:
                    elsewhere = preserved_elsewhere(ctx, day)
                by, arch = elsewhere
                lost = [l for l in gone if l not in arch and not any(l in v for k, v in by.items() if k != rel)]
            if len(lost) >= SHRINK_MIN and len(lost) * 100 > SHRINK_PCT * total:
                it.update(action='defer', guard='shrink', shrink=[len(lost), total],
                          reason=say("applyShrinkGuard", a=len(lost), total=total, shrink_pct=SHRINK_PCT))
            elif len(gone) >= SHRINK_MIN and len(gone) * 100 > SHRINK_MOVE_PCT * total:
                it.update(action='defer', guard='shrink', shrink=[len(gone), total],
                          reason=say("applyShrinkGuardMove", a=len(gone), total=total, shrink_move_pct=SHRINK_MOVE_PCT))
        items.append(it)
    # 人格上限：当晚要换进去的人格块（批准过的、学习记录式的快照块不算）合计改动超过 SOUL_CAP 处，
    # 这些人格块的提案和要删的人格块全部推迟
    soul_items = []
    hunks = 0
    for it in items:
        if it['kind'] != 'soul' or it['action'] not in ('apply', 'create') or it.get('approved'):
            continue
        lt, pt = read_text(ctx.ws / it['rel']), read_text(ctx.day_dir(day) / 'proposed' / it['rel'])
        if is_snapshot_block(lt, pt, creating=it['action'] == 'create'):
            it['snapshot_block'] = True                          # 只过缩水保护
            continue
        it['hunks'] = soul_hunks(lt, pt, skip=SOUL_CAP_SKIP.get(it['rel'], ()))
        hunks += it['hunks']
        soul_items.append(it)
    soul_dels = [r for r in read_delete_list(ctx, day) if kind_of(r)[0] == 'soul' and (ctx.ws / r).is_file()
                 and SNAPSHOT_MARK not in read_text(ctx.ws / r)]
    hunks += len(soul_dels)                                      # 删一块人格算一处
    cap_why = None
    if SOUL_CAP is not None and hunks > SOUL_CAP:
        cap_why = (say("applySoulCap", hunks=hunks, soul_cap=SOUL_CAP))
        for it in soul_items:
            it.update(action='defer', guard='soul-cap', reason=cap_why)
    deletes = []
    for rel in read_delete_list(ctx, day):
        kind, why = kind_of(rel, events_only(ctx), people)
        live = ctx.ws / rel
        it = {'rel': rel, 'kind': kind, 'op': 'delete', 'cur': sha(live), 'base': (srcs or {}).get(rel)}
        if kind == 'bad':
            it.update(action='bad', reason=say("applyCannotDelete", why=why))
        elif kind == 'retired':
            it.update(action='retired', reason=why)
        elif kind not in ('memory', 'soul'):
            it.update(action='refuse', reason=say("applyCannotDeleteA", a=say("applyColonWhy", why=why) if why else ''))
        elif rel in proposed:
            it.update(action='refuse', reason=say("applyProposeAndDelete"))
        elif os.path.islink(live):
            it.update(action='bad', reason=say("applySymlink"))
        elif off_ws(ctx, live):
            it.update(action='refuse', reason=OFF_WS)
        elif it['cur'] is None:
            it.update(action='gone', reason=say("applyGone"))
        elif lint_failed is not None and rel in lint_failed:
            it.update(action='defer', reason=say("applyLintBlockDelete"))
        elif kind in rb:
            it.update(action='defer', reason=rb_why(kind))
        elif cap_why and kind == 'soul' and SNAPSHOT_MARK not in read_text(live):
            it.update(action='defer', guard='soul-cap', reason=cap_why)
        elif srcs is None or srcs.get(rel) != it['cur']:
            it.update(action='defer', reason=say("applyChangedNoDelete"))
        else:
            it.update(action='delete')
            deletes.append(it)
        items.append(it)
    if deletes:                       # 删之前：每一行在「应用之后」的别的文件或 archive 里都要找得到
        corpus = corpus_after(ctx, day, items, {d['rel'] for d in deletes})
        for it in deletes:
            lost = lost_lines(read_text(ctx.ws / it['rel']), corpus)
            if lost:
                it.update(action='refuse', reason=say("applyDeleteLoses", a=len(lost)), lost=lost[:5])
    ign = gitignored(ctx, [it['rel'] for it in items if it.get('action') in ('apply', 'create', 'delete')])
    for it in items:
        if it['rel'] in ign and it.get('action') in ('apply', 'create', 'delete'):
            it.update(action='refuse', reason=say("applyGitignored"))
    return items


# ---------- 指纹（整理这一轮有没有动不该动的地方） ----------

def tree_hash(root, skip_dirs=(), keep=None, skip_names=()):
    root = Path(root)
    try:
        if not root.is_dir():
            return 'none'
    except OSError as e:   # not even its kind can be read
        return f'unreadable:{type(e).__name__}'
    h, n = hashlib.sha256(), 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for d in sorted(dirnames):                      # 指向别处的目录：记下指向哪，不跟进去
            p = Path(dirpath) / d
            if os.path.islink(p):
                h.update(f'{p.relative_to(root).as_posix()}\0dirlink:{os.readlink(p)}\n'.encode())
                n += 1
        dirnames[:] = sorted(d for d in dirnames if d not in skip_dirs and not os.path.islink(Path(dirpath) / d))
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            rel = p.relative_to(root).as_posix()
            if fn.endswith('.pyc') or fn in skip_names or (keep and not keep(rel)):
                continue
            digest = ('link:' + os.readlink(p)) if os.path.islink(p) else (sha(p) or 'unreadable')
            h.update(f'{rel}\0{digest}\n'.encode())
            n += 1
    return f'{h.hexdigest()[:16]}/{n}'


def cron_jobs(db):
    """{job_id: [种类, 定义的 hash, 名字]}；运行状态不算，内容（payload）只进 hash。读不到返回字符串。"""
    if db == 'none':
        return 'skip'
    try:
        con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
        rows = con.execute('select job_id, name, enabled, job_json from cron_jobs order by job_id').fetchall()
        con.close()
    except sqlite3.Error as e:
        return f'unreadable:{type(e).__name__}'
    out = {}
    for jid, name, enabled, js in rows:
        kind = '?'
        try:
            j = json.loads(js)
            j.pop('state', None)
            kind = (j.get('schedule') or {}).get('kind', '?')
            js = json.dumps(j, sort_keys=True, ensure_ascii=False)
        except ValueError:
            pass
        out[jid] = [kind, sha_bytes(f'{name}\0{enabled}\0{js}'.encode())[:16], str(name or '')]
    return out


def cron_changes(old, new, notes=None):
    """定期任务（cron / every）新增、改了、删了都算（整晚拦）。一次性任务（at）新建、改了、跑完没了都不拦：
    她半夜答应的提醒（主人 3 点说「提醒我…」）、自由时间的接续都是这么建的；新建的往 notes 里写一句（只写名字，不写内容）。"""
    if not isinstance(old, dict) or not isinstance(new, dict):
        return [] if old == new else [say("applyCronDefs")]
    out = []
    for jid in sorted(set(old) | set(new)):
        o, n = old.get(jid), new.get(jid)
        if o is not None and n is not None and o[:2] == n[:2]:   # 只比种类和定义（旧版指纹没有名字）
            continue
        if (o is None or o[0] == 'at') and (n is None or n[0] == 'at'):
            if o is None and notes is not None:
                notes.append(say("applyCronOneOff", a=n[2] if len(n) > 2 and n[2] else jid[:8]))
            continue
        out.append(say("applyCronJob", jid=jid[:8], a=say("applyCronAdded") if o is None else say("applyCronDeleted") if n is None else say("applyCronChanged")))
    return out


def crontab_hash():
    try:
        p = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=20)
    except Exception as e:  # noqa: BLE001
        return f'unreadable:{type(e).__name__}'
    return sha_bytes(p.stdout.encode())[:16] if p.returncode == 0 else 'none'


def fingerprints(ctx):
    """敏感区指纹：整理那一晚这些都不该变（变了就整晚拒绝应用）。只存 hash，不存内容。"""
    ws, home = ctx.ws, ctx.home
    fp = {}
    for p in sorted(ws.glob('*.md')):
        if p.name not in ('MEMORY.md', 'USER.md', 'SOUL.md', 'SOUL.memory.md', 'DREAMS.md') and not LENS_RE.fullmatch(p.name):
            fp[p.name] = sha(p)
    fp['scripts/'] = tree_hash(ws / 'scripts', skip_dirs=('__pycache__',))
    fp[say("applySkillsNonMd")] = tree_hash(ws / 'skills', keep=lambda rel: not rel.endswith('.md') and '.bak' not in rel)
    fp['.git/hooks'] = tree_hash(ws / '.git/hooks')
    fp['.git/info'] = tree_hash(ws / '.git/info')
    fp['.git/config'] = sha(ws / '.git/config')
    fp['.gitignore'] = sha(ws / '.gitignore')
    fp['.gitattributes'] = sha(ws / '.gitattributes')
    fp['~/.gitconfig'] = sha(home / '.gitconfig')
    fp['~/.config/git'] = tree_hash(home / '.config/git')
    fp['~/Library/LaunchAgents'] = tree_hash(home / 'Library/LaunchAgents', skip_names=LAUNCH_AGENTS_SELF_UPDATING)
    for rc in ('.zshrc', '.zprofile', '.zshenv', '.bash_profile', '.bashrc', '.profile'):
        fp['~/' + rc] = sha(home / rc)
    fp['crontab'] = crontab_hash() if ctx.state_db != 'none' else 'skip'
    fp[say("applyCronDefs")] = cron_jobs(ctx.state_db)
    if ctx.state_db != 'none':   # the old agent platform's own files, while the role still has it
        fp['~/.openclaw/openclaw.json'] = sha(home / '.openclaw/openclaw.json')
        fp['~/.openclaw/extensions'] = tree_hash(home / '.openclaw/extensions', skip_dirs=('.git',))
        fp['~/.openclaw/npm'] = tree_hash(home / '.openclaw/npm', skip_dirs=('.git',))
        fp['workshop-skills'] = tree_hash(home / '.openclaw/agents/main/agent/workshop-skills')
    return fp


def diff_fp(old, new, notes=None):
    out = []
    for k in sorted(set(old) | set(new)):
        if k == say("applyCronDefs"):
            out += cron_changes(old.get(k), new.get(k), notes)
        elif old.get(k) != new.get(k):
            out.append(k)
    return out


def organizer_writes(ctx, day, since_ms):
    """整理任务自己用 write/edit 写过、却不在 sleep/<日期>/ 下的文件（OpenClaw 的写入记录）。
    工作区搬到 sleep/ 以后，记下的 memory/ 写入（还有 MEMORY.md 这些）都是越界的，memory/sleep/ 也一样。"""
    if ctx.state_db == 'none':
        return [], None
    try:
        con = sqlite3.connect(f'file:{ctx.state_db}?mode=ro', uri=True, timeout=5)
        jobs = [r[0] for r in con.execute('select job_id from cron_jobs where name=?', (ORGANIZER_JOB,))]
        rows = con.execute("select value_json from plugin_state_entries "
                           "where plugin_id='core:memory-artifact-provenance'").fetchall()
        con.close()
    except sqlite3.Error as e:
        return None, f'{type(e).__name__}: {e}'
    wsk = sha_bytes(os.path.realpath(str(ctx.ws)).encode())
    bad = []
    for (v,) in rows:
        try:
            r = json.loads(v)
        except ValueError:
            continue
        sk = r.get('sessionKey') or ''
        if r.get('workspaceKey') != wsk or (r.get('observedAt') or 0) < since_ms:
            continue
        if not any(f':cron:{j}' in sk for j in jobs):
            continue
        if not str(r.get('relativePath', '')).startswith(f'sleep/{day}/'):
            bad.append(r.get('relativePath'))
    return sorted(set(bad)), None


def lit(paths):
    """普通路径按字面匹配（文件名里的 [ ] * ? 不当通配符）。"""
    return [x if x.startswith(':(') else f':(literal){x}' for x in paths]


def changed_since_head(ctx, paths):
    """这些路径里，和 HEAD 比有改动（含新文件、删掉的）的文件。"""
    p = git(ctx, 'status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', *lit(paths), check=False)
    out = []
    for e in (p.stdout or '').split('\0'):
        if len(e) > 3:
            out.append(e[3:])
    return out


def ours(ctx, day, rel):
    """这个改动是不是应用（或者之前那一跑的应用）做的：原文件和提案一样，或者是要删的文件已经没了。"""
    D = ctx.day_dir(day)
    prop = D / 'proposed' / rel
    if prop.is_file() and sha(prop) == sha(ctx.ws / rel):
        return True
    return rel in read_delete_list(ctx, day) and not (ctx.ws / rel).exists()


def guard_run(g, rebaseline_ok=True):
    """这一晚的基准：这一晚第一次 begin 的指纹（之后手动 --rebaseline 过就用最后那次）。"""
    runs = g.get('runs') or []
    if not runs:
        return None
    night = runs[-1].get('night')
    same = [r for r in runs if r.get('night') == night]
    reb = [r for r in same if r.get('rebaseline')]
    return (reb[-1] if (reb and rebaseline_ok) else same[0])


def check_guard(ctx, day, items=None, steps=None):
    """和这一晚第一次 begin 时的指纹比，再看整理期间有没有人动人格和人物表。返回 (通过?, 说明行)。"""
    g = read_json(ctx.day_dir(day) / 'guard.json', None)
    if not g or not g.get('runs'):
        return False, [say("applyNoFingerprint")]
    run = guard_run(g)
    cur = fingerprints(ctx)
    at_notes = []
    changed = diff_fp(run['fingerprints'], cur, at_notes)
    notes, ok = [], True
    if changed:
        ok = False
        notes.append(say("applyChangedSince", at=run["at"][11:16], a=say("applyListSep").join(changed)))
    notes += [say("applyCount", n=n) for n in at_notes[:10]]
    for k, v in cur.items():
        if isinstance(v, str) and v.startswith('unreadable'):
            notes.append(say("applyUnreadable", k=k, v=v))
    bad, err = organizer_writes(ctx, day, run.get('at_ms', 0))
    if err:
        notes.append(say("applyNoWriteLog", err=err))
    elif bad:
        ok = False
        notes.append(say("applyWroteOutside", day=day, a=say("applyListSep").join(bad[:10])))
    steps = steps if steps is not None else {}
    base = steps.get('base-sha')
    if (ctx.ws / '.git').exists():
        blk = [p for p in changed_since_head(ctx, GUARD_BLOCK) if p not in GUARD_IGNORE and not ours(ctx, day, p)]
        if blk:
            ok = False
            notes.append(say("applySoulChangedDuring", a=say("applyListSep").join(blk[:10])))
        if base:
            mine = {steps.get(k) for k in ('sha-memory', 'sha-soul', 'sha-draft') if steps.get(k)}
            log = git(ctx, 'log', '--format=%H %s', f'{base}..HEAD', '--', *lit(GUARD_BLOCK), check=False).stdout
            other = [l for l in log.splitlines() if l and l.split(' ', 1)[0] not in mine
                     and not l.split(' ', 1)[-1].startswith(tuple(f'{h} {day}' for h in form.every('sleepCommit')))]
            if other:   # 提交过的（主人 的会话、她自己）不拦：对应的人格提案会按 hash 推迟
                notes.append(say("applyCommitsDuring", a=say("applySemicolon").join(l[:60] for l in other[:5])))
        note = [p for p in changed_since_head(ctx, GUARD_NOTE) if not ours(ctx, day, p)]
        if note:
            notes.append(say("applyFilesChangedDuring", a=say("applyListSep").join(note[:10])))
    for b in (g.get('between_runs') or [])[-3:]:
        if b.get('changed'):
            notes.append(say("applyChangedSinceLast", at=b["at"][5:16], a=say("applyListSep").join(b["changed"])))
    bads = [it for it in (items or []) if it.get('action') == 'bad']
    if bads:
        ok = False
        notes.append(say("applyBadPlaces", a=say("applyListSep").join(say("applyRelWhy", rel=it["rel"], a=it.get("reason", "")) for it in bads[:10])))
    return ok, notes


# ---------- git ----------

class GitError(Exception):
    pass


def git(ctx, *args, check=True):
    # GIT_OPTIONAL_LOCKS=0：只读的 git status 不去顺手刷新、锁住 index（白天别的任务也在用这个仓库）
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_EDITOR='true', GIT_OPTIONAL_LOCKS='0')
    p = None
    for _ in range(4):
        # 不跑任何 git 钩子（指纹里也查 .git/hooks）；中文文件名照原样输出
        p = subprocess.run(['git', '-C', str(ctx.ws), '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false', *args],
                           capture_output=True, text=True, env=env)
        if p.returncode != 0 and 'index.lock' in (p.stderr or ''):
            time.sleep(10)      # 别的任务正在提交，等一下
            continue
        break
    if check and p.returncode != 0:
        # what git says last is why; lines from xcrun (a cache it cannot write) come first and are not the reason
        why = [l for l in (p.stderr or p.stdout).splitlines() if l.strip() and not l.startswith('xcrun:')]
        raise GitError(say("applyGitFailed", a=" ".join(args[:3]), b=chr(10).join(why)[-600:]))
    return p


def existing_paths(ctx, paths):
    """git add 只给存在的或已跟踪的路径（不然 pathspec 报错）。"""
    paths = list(dict.fromkeys(paths))
    if not paths:
        return []
    tracked = set()
    p = git(ctx, 'ls-files', '-z', '--', *lit(paths), check=False)
    for f in (p.stdout or '').split('\0'):
        if f:
            tracked.add(f)
    out = []
    for x in paths:
        if (ctx.ws / x).exists() or x in tracked or any(t.startswith(x.rstrip('/') + '/') for t in tracked):
            out.append(x)
    return out


def tag_of(ctx, name):
    p = git(ctx, 'rev-parse', '-q', '--verify', f'refs/tags/{name}^{{commit}}', check=False)
    return p.stdout.strip() if p.returncode == 0 else None


def cycle_tag(name, cycle):
    """同一天第 2 轮起（上一轮材料不完整 / 手动重做）tag 加后缀：sleep/<日期>/memory.2"""
    return name if (cycle or 1) <= 1 else f'{name}.{cycle}'


def commit(ctx, pathspec, msg, tag=None, recorded=None, record=None, marker=None, since=None):
    """只提交这些路径（别人暂存的东西不带上）。没改动就不提交、不打 tag。
    recorded：上次（中途死掉的那一跑）记下的提交，重跑时直接补 tag；record(sha)：提交后马上记下来；
    marker：写进提交说明的暗记（这一天、哪类、第几轮），提交完还没来得及记就死掉的，重跑时在 since..HEAD 里按它找回来。
    返回 (sha, 说明)。"""
    if tag and tag_of(ctx, tag):
        return tag_of(ctx, tag), say("applyTagExists", tag=tag)
    if recorded and git(ctx, 'cat-file', '-e', f'{recorded}^{{commit}}', check=False).returncode == 0:
        if tag:
            git(ctx, 'tag', tag, recorded)
        return recorded, say("applyCommittedBefore")
    if marker:
        rng = f'{since}..HEAD' if since else 'HEAD'
        found = git(ctx, 'log', '-50', '--format=%H', '--fixed-strings', f'--grep={marker}', rng, check=False).stdout.split()
        if found:
            if record:
                record(found[0])
            if tag:
                git(ctx, 'tag', tag, found[0])
            return found[0], say("applyCommittedMarker")
    plain = existing_paths(ctx, [x for x in pathspec if not x.startswith(':(')])
    magic = [x for x in pathspec if x.startswith(':(')]
    if not plain:
        return None, say("applyNoChanges")
    spec = lit(plain) + magic
    git(ctx, 'add', '-A', '--', *spec)
    # commit the files that have staged changes, not the pathspec: a folder whose contents are all excluded (sleep/ with
    # only its days, state.json and dot files) matches nothing, and git commit would stop on it
    staged = [f for f in git(ctx, 'diff', '--cached', '--no-renames', '--name-only', '-z', '--', *spec, check=False).stdout.split('\0') if f]
    if not staged:
        return None, say("applyNoChanges")
    try:
        git(ctx, 'commit', '-q', '--no-verify', '-m', msg + (f'\n\n{marker}' if marker else ''), '--', *lit(staged))
    except GitError:
        git(ctx, 'reset', '-q', '--', *spec, check=False)   # 别把暂存的东西留给下一个提交的人
        raise
    h = git(ctx, 'rev-parse', 'HEAD').stdout.strip()
    if record:
        record(h)
    if tag:
        git(ctx, 'tag', tag, h)
    return h, ''


def head(ctx):
    p = git(ctx, 'rev-parse', '-q', '--verify', 'HEAD', check=False)
    return p.stdout.strip() if p.returncode == 0 else None


# ---------- 报告 ----------

def put_block(ctx, day, name, text):
    """把脚本写的块放到 report.md 最上面（lint 块在最前，apply 块跟在后面）；重跑时原地替换。"""
    p = ctx.day_dir(day) / 'report.md'
    old = read_text(p)
    start, end = f'<!-- {name}:start -->', f'<!-- {name}:end -->'
    block = f'{start}\n{text.strip()}\n{end}\n'
    if start in old and end in old:
        new = re.sub(re.escape(start) + r'.*?' + re.escape(end) + r'\n?', lambda m: block, old, count=1, flags=re.S)
    elif name != 'lint' and '<!-- lint:end -->' in old:
        i = old.index('<!-- lint:end -->') + len('<!-- lint:end -->')
        new = old[:i] + '\n' + block + old[i:].lstrip('\n')
    else:
        new = block + ('\n' + old if old else '')
    write_atomic(p, new)


LABEL = {'apply': say("applyLabelApply"), 'create': say("applyLabelCreate"), 'same': say("applyLabelSame"), 'defer': say("applyLabelDefer"), 'refuse': say("applyLabelRefuse"), 'bad': say("applyLabelBad"),
         'held': say("applyLabelHeld"), 'preview': say("applyLabelPreview"), 'append': say("applyLabelAppend"), 'delete': say("applyLabelDelete"), 'gone': say("applyLabelGone"),
         'retired': say("applyLabelRetired")}


def lst(items, n=25):
    s = say("applyListSep").join(items[:n])
    return s + (say("applyListMore", a=len(items)) if len(items) > n else '')


def render_report(res):
    live = res['mode'] == 'live'
    items = res.get('items', [])
    by = {}
    for it in items:
        by.setdefault(it['action'], []).append(it)
    L = [say("applyReportHeading", at=res["at"][5:16]), '']
    L.append(say("applyReportMode", mode=res["mode"], a='' if live else say("applyReportDraft"), b='' if res.get('applied') or not live else say("applyReportNothing"), c=say("applyReportPartial") if res.get('partial') else ''))
    L.append(say("applyReportFingerprint", a=say("applyPassed") if res.get('guard_ok') else say("applyFailedMark"), b=''.join(f'\n  - {n}' for n in res.get('guard_notes', []))))
    verb = '' if res.get('applied') else say("applyWould")   # 真换进去了才不加「会」
    for act in ('apply', 'create', 'append', 'delete'):
        xs = by.get(act, [])
        if xs:
            L.append(say("applyReportVerb", verb=verb, label=LABEL[act], a=len(xs), lst=lst([x['rel'] + (say("applyLines", lines=x["lines"]) if act == 'append' else '') for x in xs])))
    for it in items:
        if it.get('held_back'):
            L.append(say("applyReportChangelogDeferred", a=len(it["held_back"])))
    if by.get('same'):
        L.append(say("applyReportSame", a=len(by["same"])))
    if by.get('defer'):
        L.append(say("applyReportDeferred", a=len(by["defer"])))
        L += [say("applyReportItem", rel=x["rel"], a=x.get("reason", "")) for x in by['defer'][:30]]
    if by.get('retired'):
        L.append(say("applyReportRetired", a=len(by["retired"]), lst=lst([x['rel'] + (say("applyDeleteMark") if x.get('op') == 'delete' else '') for x in by['retired']])))
    for act in ('bad', 'refuse'):
        if by.get(act):
            L.append(say("applyReportBad", label=LABEL[act], a=len(by[act])))
            L += [say("applyReportItem", rel=x["rel"], a=x.get("reason", "")) for x in by[act][:30]]
    if by.get('held'):
        L.append(say("applyReportHeldList", a=say("applyListSep").join(x['rel'] for x in by['held']), day=res["day"]))
    for k, label in (('rebuild', say("applyRebuilt")), ('commits', say("applyCommits")), ('done', say("applyMarkedDone")), ('last_applied_at', 'last_applied_at')):
        if res.get(k):
            v = res[k]
            L.append(say("applyReportKey", label=label, a=say("applySemicolon").join(v) if isinstance(v, list) else str(v)))
    for e in res.get('errors', []):
        L.append(f'- ❌ {e}')
    for w in res.get('warnings', []):
        L.append(f'- ⚠️ {w}')
    if res.get('snapshot'):
        L += ['', say("applySnapshotHeading"), '```', res['snapshot'].strip(), '```']
    return '\n'.join(L)


# ---------- MEMORY.md / USER.md 合并清单 ----------

MERGE_START, MERGE_END = '<!-- 脚本对照:start -->', '<!-- 脚本对照:end -->'


def merge_list(live_text, prop_text):
    """逐行对照，按小节列出「加 / 删 / 改」。"""
    a, b = live_text.splitlines(), prop_text.splitlines()

    def heading(lines, i):
        for j in range(min(i, len(lines) - 1), -1, -1):
            if lines[j].startswith('#'):
                return lines[j].lstrip('#').strip()
        return say("applyStart")

    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == 'equal':
            continue
        old = [x for x in a[i1:i2] if x.strip()]
        new = [x for x in b[j1:j2] if x.strip()]
        sec = heading(b, j1) if new else heading(a, i1)
        if op == 'replace' and len(old) == len(new):
            out += [(sec, say("applyOpChange"), f'{o.strip()}\n    → {n.strip()}') for o, n in zip(old, new)]
            continue
        out += [(sec, say("applyOpDelete"), o.strip()) for o in old]
        out += [(sec, say("applyOpAdd"), n.strip()) for n in new]
    return out


def write_memory_merge(ctx, day, srcs=None):
    D = ctx.day_dir(day)
    parts = []
    for rel in HELD:
        prop = D / 'proposed' / rel
        if not prop.exists():
            continue
        live_text = read_text(ctx.ws / rel)
        ops = merge_list(live_text, read_text(prop))
        if not ops:
            continue
        note = ''
        if srcs is not None and rel in srcs and srcs[rel] != sha(ctx.ws / rel):
            note = say("applyMergeChanged")
        parts.append(f'### {rel}\n{note}')
        cur = None
        for sec, op, text in ops:
            if sec != cur:
                parts.append(say("applyMergeSection", sec=sec))
                cur = sec
            parts.append(say("applyMergeOp", op=op, text=text))
        parts.append('')
    p = D / 'memory-merge.md'
    old = read_text(p)
    body = '\n'.join(parts).strip()
    if not body:
        if MERGE_START in old:
            write_atomic(p, re.sub(re.escape(MERGE_START) + r'.*?' + re.escape(MERGE_END) + r'\n?', '', old, flags=re.S))
        return None
    block = (say("applyMergeBlock", merge_start=MERGE_START, now_iso=now_iso()[5:16], body=body, merge_end=MERGE_END))
    if MERGE_START in old:
        new = re.sub(re.escape(MERGE_START) + r'.*?' + re.escape(MERGE_END) + r'\n?', lambda m: block, old, flags=re.S)
    elif old.strip():
        new = old.rstrip() + '\n\n' + block
    else:
        new = (say("applyMergeFile", day=day, block=block))
    write_atomic(p, new)
    return p


# ---------- 命令 ----------

def usage_reading(ctx, a):
    if a.usage_json:
        return json.loads(a.usage_json)
    try:
        p = subprocess.run(['budget', 'snap'], capture_output=True, text=True, timeout=150)   # the senses module's budget command; missing = no reading
        r = json.loads((p.stdout or '').strip().splitlines()[-1])
        return r if isinstance(r, dict) and 'five' in r else None
    except Exception:  # noqa: BLE001
        return None


def decide(r, t):
    """额度 → go / defer / save。"""
    late = t.replace(hour=LATE_RUN[0], minute=LATE_RUN[1], second=0, microsecond=0)
    if not r:
        return 'go', say("applyBudgetUnknown")
    five, week, reset = float(r.get('five') or 0), float(r.get('week') or 0), r.get('five_reset')
    fmt = (lambda ts: dt.datetime.fromtimestamp(ts, TZ).strftime('%H:%M')) if reset else (lambda ts: '?')
    desc = say("applyBudget", five=five, fmt=fmt(reset), week=week)
    if reset and reset <= t.timestamp():
        return 'go', say("applyBudgetReset", desc=desc)
    if t.hour < LATE_RUN[0] and five >= DEFER_PCT and reset and reset <= late.timestamp():
        return 'defer', say("applyBudgetLater", desc=desc)
    if five >= SAVE_PCT or week >= SAVE_WEEK_PCT:
        return 'save', say("applyBudgetSave", desc=desc)
    return 'go', desc


def cmd_gate(ctx, a):
    t = dt.datetime.fromisoformat(a.now).astimezone(TZ) if a.now else now()
    word, why = decide(usage_reading(ctx, a), t)
    print(word)
    print(why)
    return 0


def carryover(ctx, day):
    """以前推迟、还没被下一晚接手的文件：[(那天, 文件, 种类)]。"""
    st = read_json(ctx.state, {}).get('steps', {})
    out = []
    for d in sorted(st):
        if d >= day:
            continue
        s = st[d]
        if s.get('carried') == 'done':
            continue
        wait = set(s.get('guard_deferred') or [])      # 缩水保护 / 人格上限推迟的：等人批，不是要重做
        out += [(d, f, 'wait' if f in wait else 'defer') for f in s.get('deferred_files') or []]
        out += [(d, f, 'wait' if f in wait else 'delete') for f in s.get('refused_deletes') or []]
    return out


def new_cycle(ctx, day, steps):
    """开新一轮（上一跑材料不完整只做了一部分，或者手动 restart）：重新 digest，从头再来。
    旧提案挪进 cycle-<n>/ 留底（不然会拿旧提案当底稿，盖掉之后别人的改动）。"""
    D = ctx.day_dir(day)
    n = int(steps.get('cycle') or 1)
    keep = D / f'cycle-{n}'
    keep.mkdir(exist_ok=True)
    for name in ('proposed', 'sunday-merge', 'delete.txt', 'memory-merge.md', 'sources.json', 'lint.json', 'apply.json',
                 'report.md', 'soul-week.md'):
        if (D / name).exists():
            os.replace(D / name, keep / name)

    def f(st):
        d = st.setdefault('steps', {}).setdefault(day, {})
        old = {k: d[k] for k in KEEP_KEYS if k in d}
        d.clear()
        d.update(old)
        d['cycle'] = n + 1
        d['updated'] = now_iso()
    state_update(ctx, f)
    print(say("applyNewCycle", a=n + 1, day=day, n=n))


def merge_stray_changelog(ctx):
    """她照着旧说明把 changelog 记到了 memory/sleep/soul-changelog.md：新行去重后追加进 sleep/soul-changelog.md，删掉老文件
    （memory/ 下的东西会被索引进记忆搜索）。返回并进去的行；没有老文件返回 None。"""
    stray = ctx.ws / OLD_CHANGELOG
    if not stray.is_file() or stray.is_symlink():
        return None
    live = ctx.ws / CHANGELOG
    add = changelog_additions(live, stray)
    if add:
        old = read_text(live)
        write_atomic(live, old + ('' if not old or old.endswith('\n') else '\n') + '\n'.join(add) + '\n')
    os.remove(stray)
    with contextlib.suppress(OSError):
        stray.parent.rmdir()                      # memory/sleep/ 空了就一起删
    return add


def cmd_begin(ctx, a):
    day = check_day(a.day)
    D = ctx.day_dir(day)
    D.mkdir(parents=True, exist_ok=True)
    steps = get_steps(ctx, day)
    if steps.get('finish') == 'partial':
        print(say("applyLastPartial"), end='')
        new_cycle(ctx, day, steps)
        steps = get_steps(ctx, day)
    gp = D / 'guard.json'
    g = read_json(gp, {'runs': []})
    fp = fingerprints(ctx)
    t = now()
    if g.get('runs'):
        prev = g['runs'][-1]
        changed = diff_fp(prev['fingerprints'], fp)
        g.setdefault('between_runs', []).append({'at': now_iso(), 'changed': changed})
        g['between_runs'] = g['between_runs'][-10:]
        if changed and prev.get('night') == night_id(t) and not a.rebaseline:
            print(say("applyChangedThisNight", a=say("applyListSep").join(changed)))
        elif changed:
            print(say("applyChangedSinceRun", a=say("applyListSep").join(changed)))
    g['runs'] = (g.get('runs') or [])[-9:] + [{'at': now_iso(), 'at_ms': int(time.time() * 1000), 'night': night_id(t),
                                               'pid': os.getpid(), 'rebaseline': bool(a.rebaseline), 'fingerprints': fp}]
    write_json_atomic(gp, g)
    set_step(ctx, day, '0-begin', 'done')
    merged = merge_stray_changelog(ctx)
    if merged is not None:
        print(say("applyOldChangelog", old_changelog=OLD_CHANGELOG, a=len(merged), changelog=CHANGELOG))
    cycle = int(steps.get('cycle') or 1)
    if not is_done(steps, 'commit-day'):
        # 先把她白天没提交的改动提交掉：之后人格 / 人物表再有改动，就是整理期间发生的
        try:
            h, why = commit(ctx, list(DAY_SPEC) + lens_files(ctx), say('applyMsgDay', head=form('dayCommit'), day=day),
                            tag=cycle_tag(f'day/{day}', cycle), recorded=steps.get('sha-day'),
                            record=lambda x: set_step(ctx, day, None, **{'sha-day': x}),
                            marker=f'Sleep-Apply: {day} day {cycle}', since=steps.get('base-sha') or None)
        except GitError as e:
            print(say("applyDayCommitFailed", e=e))
            return 2
        set_step(ctx, day, 'commit-day', 'done', **{'base-sha': head(ctx) or ''})
        print(say("applyDayCommit", cycle_tag=cycle_tag(f"day/{day}", cycle), a=h[:7] if h else "", why=why))
    steps = get_steps(ctx, day)
    done = [k for k, v in steps.items() if v == 'done' and k not in ('0-begin', 'commit-day')]
    print(say("applyFingerprints", a=len(fp), b=say("applyListSep").join(sorted(done)) or say("applyNoneYet")))
    co = carryover(ctx, day)
    if co:
        print(say("applyRedo"))
        for d, f, k in co:
            if k == 'wait':
                print(say("applyRedoBig", d=d, f=f))
            elif k == 'defer':
                print(say("applyRedoDiff", d=d, f=f))
            else:
                print(say("applyRedoDelete", d=d, f=f))
    return 0


def cmd_step(ctx, a):
    day = check_day(a.day)
    extra = {}
    if a.name == '0-digest' and a.status == 'done':
        extra['sources-sha'] = sha(ctx.day_dir(day) / 'sources.json') or 'none'   # 收尾时核：digest 之后没重跑过
    set_step(ctx, day, a.name, a.status, **extra)
    print(f'{day} {a.name} = {a.status}')
    return 0


def cmd_steps(ctx, a):
    day = check_day(a.day)
    steps = get_steps(ctx, day)
    for k in sorted(steps):
        print(f'{k}\t{steps[k]}')
    return 0


def cmd_material(ctx, a):
    """digest 之后：看 input.md 第 2 行和 sleep_digest.py 记的推迟晚数 → full / partial / redigest。"""
    day = check_day(a.day)
    t = dt.datetime.fromisoformat(a.now).astimezone(TZ) if a.now else now()
    D = ctx.day_dir(day)
    inp = D / 'input.md'
    lines = read_text(inp).splitlines()
    status = lines[1].strip() if len(lines) > 1 else ''
    nights = read_json(ctx.state, {}).get('defer_nights', {}).get(day, [])
    earlier = [n for n in nights if n != night_id(t)]
    if not inp.exists():
        word, why = 'redigest', say("applyMaterialNone", day=day)
    elif status in form.every('materialFull'):
        word, why = 'full', say("applyMaterialFull")
    elif not status.startswith(form.every('materialHead')):
        if proposed_files(ctx, day):
            word, why = 'full', (say("applyMaterialOldDone"))
        else:
            word, why = 'redigest', (say("applyMaterialOld", day=day))
    elif len(earlier) >= MAX_INCOMPLETE_NIGHTS:
        word, why = 'full', (say("applyMaterialEnough", a=len(earlier), b=say("applyListSep").join(earlier)))
    else:
        word, why = 'partial', (say("applyMaterialPartial", status=status, a=len(earlier) + 1))
    set_step(ctx, day, None, material=say("applyMaterialStep", t=t, word=word, a=status or say("applyNoLine2"))[:200])
    print(word)
    print(why)
    return 0


def cmd_restart(ctx, a):
    """重新整理已经整理过（或做到一半）的一天：旧提案挪进 cycle-<n>/，进度清零，新一轮的 tag 带 .<n> 后缀。
    要让 pending 重新列出这一天，还得在 sleep_digest.py 那边把它从完成里拿掉。"""
    day = check_day(a.day)
    if not ctx.day_dir(day).is_dir():
        print(say("applyNoDayDir", day=day))
        return 2
    new_cycle(ctx, day, get_steps(ctx, day))
    return 0


def cmd_plan(ctx, a):
    day = check_day(a.day)
    cfg = read_json(ctx.config, {})
    lint_failed = load_lint_failed(ctx, day) if cfg.get('lint_mode') == 'block' else None
    items = make_plan(ctx, day, lint_failed)
    nb = notebook_gate(ctx, day, items) + unchecked_report(unchecked_entries(ctx, day, items))
    ok, notes = check_guard(ctx, day, items, get_steps(ctx, day))
    print(say("applyPlanFingerprint", a=say("applyPassed") if ok else say("applyFailed")))
    for n in notes:
        print('  ' + n)
    for n in nb:
        print('⚠️ ' + n)
    if load_sources(ctx, day) is None:
        print(say("applyPlanNoSources"))
    for it in items:
        print(f'{LABEL.get(it["action"], it["action"]):6s} {it["rel"]}' + (say("applyPlanReason", reason=it["reason"]) if it.get('reason') else ''))
    return 0


def cmd_carry_diff(ctx, a):
    """以前推迟的文件：那一晚开始时的原文件 → 那一晚的提案，有什么不同（照着这个在现在的原文件上重做）。"""
    d = check_day(a.day)
    rel = a.rel
    steps = get_steps(ctx, d)
    base = steps.get('base-sha')
    old = git(ctx, 'show', f'{base}:{rel}', check=False).stdout if base else ''
    D = ctx.day_dir(d)
    cands = [D / 'proposed' / rel] + [c / rel for c in sorted(D.glob('cycle-*/proposed'), reverse=True)]
    prop = next((p for p in cands if p.is_file()), None)
    if not prop:
        print(say("applyCarryNone", d=d, rel=rel))
        return 2
    if not base:
        print(say("applyCarryNoStart"))
        old = read_text(ctx.ws / rel)
    diff = list(difflib.unified_diff(old.splitlines(), read_text(prop).splitlines(), say("applyCarryFrom", d=d, rel=rel), say("applyCarryTo", d=d, rel=rel),
                                     n=2, lineterm=''))
    print('\n'.join(diff[:300]) + (say("applyCarryMore", a=len(diff) - 300) if len(diff) > 300 else '') if diff else say("applyCarrySame"))
    return 0


def run_rebuild(ctx, res):
    env = dict(os.environ, HH_WORKSPACE=str(ctx.ws))   # ledger_snapshot.py 按这个找工作目录
    out = []
    for name, args in REBUILD:
        script = next(x for x in args if x.endswith('.py'))
        if not (SCRIPTS / script).exists():
            out.append(say("applyRebuildMissing", name=name))
            continue
        argv = [PY] + [str(SCRIPTS / x) if x.endswith('.py') else x for x in args]
        try:
            p = subprocess.run(argv, cwd=str(ctx.ws), capture_output=True, text=True, timeout=300, env=env)
        except subprocess.TimeoutExpired:
            res['errors'].append(say("applyRebuildTimeout", name=name))
            out.append(say("applyRebuildTimeout", name=name))
            continue
        if p.returncode != 0:
            res['errors'].append(say("applyRebuildFailedWhy", name=name, strip=(p.stderr or p.stdout).strip()[-300:]))
            out.append(say("applyRebuildFailed", name=name))
        else:
            out.append(say("applyRebuildOk", name=name))
    return out


def snapshot_report(ctx):
    """ledger_snapshot.py --report（只读：各块多长、缩了什么），放进报告。"""
    script = SCRIPTS / 'ledger_snapshot.py'
    if not script.exists():
        return ''
    try:
        p = subprocess.run([PY, '-I', str(script), '--report'], cwd=str(ctx.ws), capture_output=True, text=True, timeout=120,
                           env=dict(os.environ, HH_WORKSPACE=str(ctx.ws)))
        return (p.stdout if p.returncode == 0 else say("applySnapshotReportFailed", strip=(p.stderr or p.stdout).strip()[-200:]))[:3000]
    except Exception as e:  # noqa: BLE001
        return say("applySnapshotReportError", e=e)


def apply_items(ctx, day, items, res):
    """真的换文件。顺序：普通文件 → 人格 → changelog（只记真换进去的人格块）→ 删除（应用之后再核一遍不丢）。
    每个文件换之前再核一次 hash（计划和应用之间也可能有人改）。"""
    D = ctx.day_dir(day)
    srcs = load_sources(ctx, day) or {}
    if any(x['action'] in ('apply', 'create', 'delete', 'append') for x in items):
        set_step(ctx, day, None, applied='yes')    # 先记：中途死掉，重跑时也知道这一轮换过东西
    for it in sorted([x for x in items if x['action'] in ('apply', 'create')], key=lambda x: x['kind'] == 'soul'):
        rel = it['rel']
        live = ctx.ws / rel
        data = (D / 'proposed' / rel).read_bytes()
        cur = sha(live)
        if cur == sha_bytes(data):
            it['action'] = 'same'
            continue
        if cur != (srcs.get(rel) if rel in srcs else None):
            it.update(action='defer', reason=say("applyChangedBeforeApply"))
            continue
        write_atomic(live, data)
    skip = {soul_name(x['rel']) for x in items if x['kind'] == 'soul' and x['action'] in ('defer', 'refuse', 'bad')}
    for it in [x for x in items if x['action'] == 'append']:
        live = ctx.ws / CHANGELOG                  # 提案写在老地方（memory/sleep/）的也追加进 sleep/ 那份
        add = changelog_additions(live, D / 'proposed' / it['rel'])
        keep = [l for l in add if changelog_block(l) not in skip]
        it['held_back'] = [l for l in add if changelog_block(l) in skip]
        if keep:
            old = read_text(live)
            write_atomic(live, old + ('' if not old or old.endswith('\n') else '\n') + '\n'.join(keep) + '\n')
        it['lines'] = len(keep)
    deletes = [x for x in items if x['action'] == 'delete']
    if deletes:
        corpus = corpus_after(ctx, day, [], {x['rel'] for x in deletes})   # 现在原文件已经是应用之后的样子
        for it in deletes:
            live = ctx.ws / it['rel']
            if sha(live) != srcs.get(it['rel']):
                it.update(action='defer', reason=say("applyChangedBeforeDelete"))
                continue
            lost = lost_lines(read_text(live), corpus)
            if lost:
                it.update(action='refuse', reason=say("applyDeleteLoses", a=len(lost)), lost=lost[:5])
                continue
            os.remove(live)


def finish(ctx, day, partial=False):
    cfg = read_json(ctx.config, {})
    mode = cfg.get('mode', 'draft')
    res = {'day': day, 'mode': mode, 'at': now_iso(), 'errors': [], 'warnings': [], 'partial': partial}
    D = ctx.day_dir(day)
    if not D.is_dir():
        res['errors'].append(say("applyNoDir", d=D))
        return res
    steps = get_steps(ctx, day)
    cycle = int(steps.get('cycle') or 1)
    srcs = load_sources(ctx, day)
    lint_failed = None
    if cfg.get('lint_mode') == 'block':
        lj = D / 'lint.json'
        newest = max((p.stat().st_mtime for _, p in proposed_files(ctx, day)), default=0)
        if not lj.exists() or lj.stat().st_mtime < newest:
            res['errors'].append(say("applyLintStale"))
        lint_failed = load_lint_failed(ctx, day) or set()
    items = make_plan(ctx, day, lint_failed)
    res['items'] = items
    res['warnings'] += notebook_gate(ctx, day, items)        # 笔记本的闸门不过：skills/ 整批推迟，原因写进报告
    res['guard_ok'], res['guard_notes'] = check_guard(ctx, day, items, steps)
    waiting = [it['rel'] for it in items if it['action'] == 'defer' and it.get('guard')]
    if waiting:
        res['warnings'].append(say("applyAwaitApproval", lst=lst(waiting, 10), day=day))
    if any(it['rel'] == OLD_CHANGELOG for it in items):
        res['warnings'].append(say("applyOldChangelogFinish", old_changelog=OLD_CHANGELOG, changelog=CHANGELOG))
    if any(it['action'] == 'held' for it in items):
        write_memory_merge(ctx, day, srcs)
    rec = steps.get('sources-sha')
    if rec and rec != 'none' and rec != sha(D / 'sources.json'):
        (res['errors'] if mode == 'live' else res['warnings']).append(
            say("applySourcesChanged"))
    if not res['guard_ok']:
        res['errors'].append(say("applyFingerprintFailed"))
    if not is_done(steps, 'commit-day'):
        res['errors'].append(say("applyNoBegin"))
    if res['errors']:
        return res
    res['warnings'] += unchecked_report(unchecked_entries(ctx, day, items))   # 只报告，不拦（应用前算：要比应用前的 skills/）
    commits = [say("applyStartCommit", cycle_tag=cycle_tag(f"day/{day}", cycle), a=str(steps.get("sha-day") or "")[:7])]
    try:
        if mode != 'live':
            h, why = commit(ctx, list(SLEEP_SPEC), say('applyMsgDraft', head=form('sleepCommit'), day=day, rnd=say('applyMsgDraftRound', cycle=cycle) if cycle > 1 else ''),
                            recorded=steps.get('sha-draft'), record=lambda x: set_step(ctx, day, None, **{'sha-draft': x}),
                            marker=f'Sleep-Apply: {day} draft {cycle}', since=steps.get('base-sha') or None)
            commits.append('draft ' + (h[:7] if h else '') + (say("applyWhy", why=why) if why else ''))
            res['commits'] = commits
            res['snapshot'] = snapshot_report(ctx)
            res['done'] = say("applyNoPartial") if partial else mark_done(ctx, day, res)
            return res
        if srcs is None:
            res['errors'].append(say("applyNoSourcesFinish"))
            res['commits'] = commits
            return res
        apply_items(ctx, day, items, res)
        res['applied'] = True
        set_step(ctx, day, 'apply', 'done')
        res['rebuild'] = run_rebuild(ctx, res)
        if res['errors']:
            res['commits'] = commits
            return res
        set_step(ctx, day, 'rebuild', 'done')
        changed = [it for it in items if it['action'] in ('apply', 'create', 'same', 'delete', 'gone')]
        mem_paths = [it['rel'] for it in changed if it['kind'] == 'memory'] + ['memory/recent.md'] + list(SLEEP_SPEC)
        soul_paths = [it['rel'] for it in changed if it['kind'] == 'soul'] + [CHANGELOG, 'SOUL.md', 'SOUL.memory.md'] + lens_files(ctx)
        # 这次真要提交的（比 HEAD 有改动的）文件数：重跑时动作都是「已经一样」，按动作数会写成 0
        n_mem = len(changed_since_head(ctx, [it['rel'] for it in changed if it['kind'] == 'memory']))
        n_soul = len(changed_since_head(ctx, [it['rel'] for it in changed if it['kind'] == 'soul']))
        rnd = say('applyMsgRound', cycle=cycle) if cycle > 1 else ''
        tm, ts_ = cycle_tag(f'sleep/{day}/memory', cycle), cycle_tag(f'sleep/{day}/soul', cycle)
        base_sha = steps.get('base-sha') or None
        h, why = commit(ctx, mem_paths, say('applyMsgMemory', head=form('sleepCommit'), day=day, rnd=rnd, n=n_mem), tag=tm,
                        recorded=steps.get('sha-memory'), record=lambda x: set_step(ctx, day, None, **{'sha-memory': x}),
                        marker=f'Sleep-Apply: {day} memory {cycle}', since=base_sha)
        commits.append(f'{tm} ' + (h[:7] if h else '') + (say("applyWhy", why=why) if why else ''))
        set_step(ctx, day, 'commit-memory', 'done')
        h, why = commit(ctx, soul_paths, say('applyMsgSoul', head=form('sleepCommit'), day=day, rnd=rnd, n=n_soul), tag=ts_,
                        recorded=steps.get('sha-soul'), record=lambda x: set_step(ctx, day, None, **{'sha-soul': x}),
                        marker=f'Sleep-Apply: {day} soul {cycle}', since=base_sha)
        commits.append(f'{ts_} ' + (h[:7] if h else '') + (say("applyWhy", why=why) if why else ''))
        set_step(ctx, day, 'commit-soul', 'done')
        res['commits'] = commits
    except GitError as e:
        res['errors'].append(say("applyCommitFailed", e=e))
        res['commits'] = commits
        return res
    res['snapshot'] = snapshot_report(ctx)
    if partial:
        res['done'] = say("applyNoIncomplete")
        record_deferred(ctx, day, res)
    else:
        res['done'] = mark_done(ctx, day, res)
    if not res['errors'] and get_steps(ctx, day).get('applied') == 'yes':
        # 这一轮真换进去过东西（哪怕是之前那一跑换的）：主会话下一轮重新冻结快照（leak-guard 读这个时间）
        t = now_iso()
        state_update(ctx, lambda st: st.__setitem__('last_applied_at', t))
        res['last_applied_at'] = t
    return res


def record_deferred(ctx, day, res):
    """真应用过（live）才有「推迟」可言；draft 演练里的推迟不算，免得下一晚把整份提案当成要重做的。"""
    if not res.get('applied'):
        set_step(ctx, day, None, deferred_files=[], refused_deletes=[], guard_deferred=[])
        return
    items = res.get('items', [])
    set_step(ctx, day, None,
             deferred_files=sorted(it['rel'] for it in items if it['action'] == 'defer' and it.get('op') != 'delete'),
             refused_deletes=sorted(it['rel'] for it in items if it.get('op') == 'delete' and it['action'] in ('refuse', 'defer')),
             guard_deferred=sorted(it['rel'] for it in items if it['action'] == 'defer' and it.get('guard')))


def mark_done(ctx, day, res):
    """全部成功才标完成（sleep_digest.py done，A1 的）；顺手记下推迟的文件、把以前推迟的标成已接手。"""
    if res['errors']:
        return say("applyNo")
    p = subprocess.run([PY, str(SCRIPTS / 'sleep_digest.py'), 'done', day], cwd=str(ctx.ws),
                       capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        res['errors'].append(say("applyDoneRefused", returncode=p.returncode, strip=(p.stderr or p.stdout).strip()[-300:]))
        return say("applyNo")
    record_deferred(ctx, day, res)
    co = carryover(ctx, day)
    set_step(ctx, day, 'done', 'done')
    for d in sorted({d for d, _, _ in co}):
        set_step(ctx, d, None, carried='done')
    return say("applyYes")


def cmd_finish(ctx, a):
    day = check_day(a.day)
    with file_lock(ctx.locks / 'sleep-apply.lock', blocking=False) as got:
        if not got:
            print(say("applyBusy"))
            return 3
        try:
            res = finish(ctx, day, partial=a.partial)
        except Exception as e:  # noqa: BLE001  任何意外都要写进报告、退出码 2
            res = {'day': day, 'mode': read_json(ctx.config, {}).get('mode', 'draft'), 'at': now_iso(),
                   'errors': [say("applyUnexpected", name=type(e).__name__, e=e)], 'warnings': []}
        D = ctx.day_dir(day)
        if D.is_dir():
            write_json_atomic(D / 'apply.json', res)
            put_block(ctx, day, 'apply', render_report(res))
        if res['errors']:
            status = say("applyFailedList", errors=res['errors'][0][:80])
        else:
            status = 'partial' if a.partial else 'done'
        set_step(ctx, day, 'finish', status)
    print(render_report(res))
    return 2 if res['errors'] else 0


def cmd_memory_merge(ctx, a):
    day = check_day(a.day)
    p = write_memory_merge(ctx, day, load_sources(ctx, day))
    print(p or say("applyNoMerge"))
    return 0


# ---------- 人工放行和回滚（主人 或 Claude Code 用） ----------

GENERATED = ('SOUL.md', 'SOUL.memory.md', 'memory/recent.md')   # 重建出来的（还有镜头 SOUL.lens-*.md）：回滚不按补丁改，回滚完重新生成


def is_generated(rel):
    return rel in GENERATED or bool(LENS_RE.fullmatch(rel))


def finished(steps):
    return steps.get('done') == 'done'


def free_tag(ctx, name):
    """sleep/<日期>/promote 已经有了就用 .2、.3……"""
    if not tag_of(ctx, name):
        return name
    n = 2
    while tag_of(ctx, f'{name}.{n}'):
        n += 1
    return f'{name}.{n}'


def append_lines(p, lines):
    old = read_text(p)
    write_atomic(p, old + ('' if not old or old.endswith('\n') else '\n') + '\n'.join(lines) + '\n')


def cmd_approve(ctx, a):
    """批准提案：记下提案现在的 sha。之后 finish 对这个版本不做缩水保护、不算人格上限；提案再被改过就不算批准。"""
    day = check_day(a.day)
    D = ctx.day_dir(day)
    bad = []
    for rel in a.rel:
        kind, why = kind_of(rel, events_only(ctx), retired_active(ctx))
        p = D / 'proposed' / rel
        if kind not in ('memory', 'soul'):
            bad.append(say("applyApproveKind", rel=rel, a=why or kind))
        elif not p.is_file() or p.is_symlink():
            bad.append(say("applyApproveNone", rel=rel, day=day))
    if bad:
        print(say("applyApprovedNothing", a='\n  '.join(bad)))
        return 2
    rec = read_json(D / 'approved.json', {}) or {}
    rec['day'] = day
    files = rec.setdefault('files', {})
    for rel in dict.fromkeys(a.rel):
        h = sha(D / 'proposed' / rel)
        files[rel] = {'sha': h, 'at': now_iso(), 'by': os.environ.get('USER') or '?'}
        print(say("applyApproved", rel=rel, h=h[:12]))
    write_json_atomic(D / 'approved.json', rec)
    if finished(get_steps(ctx, day)):
        print(say("applyApproveClosed", day=day))
    else:
        print(say("applyApproveOpen", day=day))
    return 0


def cmd_promote(ctx, a):
    day = check_day(a.day)
    with file_lock(ctx.locks / 'sleep-apply.lock', blocking=False) as got:
        if not got:
            print(say("applyBusy"))
            return 3
        return promote(ctx, day, list(dict.fromkeys(a.rel)))


def promote(ctx, day, rels):
    """已经收尾的那一天，被推迟的提案现在换进去：原文件还得是 digest 时的样子。记忆、人格各一个提交，各打 promote tag。"""
    D = ctx.day_dir(day)
    if not finished(get_steps(ctx, day)):
        print(say("applyPromoteOpen", day=day))
        return 2
    srcs = load_sources(ctx, day)
    if srcs is None:
        print(say("applyPromoteNoSources", day=day))
        return 2
    bad, todo = [], []
    for rel in rels:
        kind, why = kind_of(rel, events_only(ctx), retired_active(ctx))
        p, live = D / 'proposed' / rel, ctx.ws / rel
        if kind not in ('memory', 'soul'):
            bad.append(say("applyPromoteKind", rel=rel, a=why or kind))
        elif not p.is_file() or p.is_symlink() or live.is_symlink():
            bad.append(say("applyPromoteNone", rel=rel, day=day))
        elif off_ws(ctx, live):
            bad.append(say("applyRelReason", rel=rel, why=OFF_WS))
        elif gitignored(ctx, [rel]):
            bad.append(say("applyPromoteIgnored", rel=rel))
        elif sha(live) == sha(p):
            todo.append((rel, kind))                        # 已经换进去了（上次死在提交前）：只补提交
        elif sha(live) != srcs.get(rel):
            bad.append(say("applyPromoteChanged", rel=rel, a=say("applyWasDeleted") if sha(live) is None else say("applyWasChanged")))
        else:
            todo.append((rel, kind))
    if bad:
        print(say("applyPromotedNothing", a='\n  '.join(bad)))
        return 2
    souls = {soul_name(r) for r, k in todo if k == 'soul'}
    cl_add = []                                              # 跟着人格块一起推迟的 changelog 行，现在补上
    for cp in (D / 'proposed' / CHANGELOG, D / 'proposed' / OLD_CHANGELOG):
        if souls and cp.is_file():
            cl_add += [l for l in changelog_additions(ctx.ws / CHANGELOG, cp) if changelog_block(l) in souls and l not in cl_add]
    cl_dirty = bool(changed_since_head(ctx, [CHANGELOG]))  # 她白天记了还没提交的行：不扫进这个提交
    for rel, _ in todo:
        if sha(ctx.ws / rel) != sha(D / 'proposed' / rel):
            write_atomic(ctx.ws / rel, (D / 'proposed' / rel).read_bytes())
    if cl_add:
        append_lines(ctx.ws / CHANGELOG, cl_add)
    res = {'errors': []}
    rebuild = run_rebuild(ctx, res)
    if res['errors']:
        print(say("applyPromoteRebuildFailed", a='\n  '.join(res['errors'])))
        return 2
    commits = []
    try:
        for kind, label in (('memory', say("applyWordMemory")), ('soul', say("applyWordSoul"))):
            paths = [r for r, k in todo if k == kind]
            if not paths:
                continue
            extra = ['memory/recent.md'] if kind == 'memory' else ['SOUL.md', 'SOUL.memory.md'] + lens_files(ctx) + ([] if cl_dirty else [CHANGELOG])
            tag = free_tag(ctx, f'sleep/{day}/promote')
            h, why = commit(ctx, paths + extra, say('applyMsgPromote', head=form('sleepCommit'), day=day, label=label, n=len(paths)),
                            tag=tag, marker=f'Sleep-Apply: {day} promote {kind} [{tag}]')
            commits.append(f'{tag} {h[:7]}' if h else say("applyLabelWhy", label=label, why=why))
    except GitError as e:
        print(say("applyPromoteCommitFailed", e=e))
        return 2
    t = now_iso()
    done = {r for r, _ in todo}

    def upd(st):
        d = st.setdefault('steps', {}).setdefault(day, {})
        for k in ('deferred_files', 'guard_deferred'):      # 不用下一晚再重做了
            if k in d:
                d[k] = [x for x in d[k] if x not in done]
        d.setdefault('promoted', []).extend({'rel': r, 'sha': sha(ctx.ws / r), 'at': t} for r in sorted(done))
        d['updated'] = t
        st['last_applied_at'] = t                            # 主会话下一轮重新冻结快照
    state_update(ctx, upd)
    lines = [say("applyPromoteHeading", t=t[5:16]), '', say("applyPromoteSwapped", a=say("applyListSep").join(sorted(done))),
             say("applyPromoteRebuilt", a=say("applySemicolon").join(rebuild)), say("applyPromoteCommits", a=say("applySemicolon").join(commits) or say("applyNoChanges")), say("applyLastAppliedLine", t=t)]
    if cl_add:
        lines.append(say("applyPromoteChangelog", a=len(cl_add), b=say("applyPromoteUncommitted") if cl_dirty else ''))
    put_block(ctx, day, 'promote-' + t[11:19].replace(':', ''), '\n'.join(lines))
    print('\n'.join(lines))
    return 0


def night_commits(ctx, day, only=None):
    """这一晚打了 tag 的提交（promote / soul / memory，含第 2 轮起的 .<n>），新的在前：[(tag, sha, 种类)]。
    only='soul' / 'memory'：promote 的按它改的文件归类（人格的提交一定改了 soul/）。"""
    refs = git(ctx, 'for-each-ref', '--format=%(refname:short)', f'refs/tags/sleep/{day}/', check=False).stdout.split()
    order = {h: i for i, h in enumerate(git(ctx, 'rev-list', '--topo-order', 'HEAD', check=False).stdout.split())}
    out, skipped = [], []
    for tg in refs:
        m = re.fullmatch(rf'sleep/{re.escape(day)}/(promote|soul|memory)(\.\d+)?', tg)
        if not m:
            continue
        h = tag_of(ctx, tg)
        if h not in order:
            skipped.append(tg)
            continue
        kind = m.group(1)
        if kind == 'promote':
            files = git(ctx, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', h).stdout.split('\0')
            kind = 'promote-soul' if any(f.startswith('soul/') for f in files) else 'promote-memory'
        if only and not kind.endswith(only):
            continue
        out.append((tg, h, kind))
    return sorted(out, key=lambda x: order[x[1]]), skipped


def revert_files(ctx, h):
    """回滚这个提交时按补丁改的文件：sleep/ 工作区（各天的目录、state.json）不回滚，changelog 按行删，生成的文件重建。"""
    files = [f for f in git(ctx, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', h).stdout.split('\0') if f]
    return [f for f in files if not f.startswith('sleep/') and not f.startswith('memory/sleep/') and not is_generated(f)]


def added_changelog_lines(ctx, h):
    d = git(ctx, 'diff', '--no-color', '--no-ext-diff', '-U0', f'{h}^', h, '--', CHANGELOG, check=False).stdout
    return [l[1:].rstrip() for l in d.splitlines() if l.startswith('+') and not l.startswith('+++') and l[1:].strip()]


def cmd_rollback(ctx, a):
    day = check_day(a.day)
    with file_lock(ctx.locks / 'sleep-apply.lock', blocking=False) as got:
        if not got:
            print(say("applyBusy"))
            return 3
        return rollback(ctx, day, 'soul' if a.soul else 'memory' if a.memory else None)


def rollback(ctx, day, only=None):
    """回滚那一晚打了 tag 的提交（新的先）：每个提交一个反向提交（「This reverts commit …」）。
    不用 git revert 整个提交：记忆那个提交里还有 sleep/ 工作区和 state.json（收尾后一定又改过），整个 revert 会把进度一起倒回去。"""
    commits, skipped = night_commits(ctx, day, only)
    for tg in skipped:
        print(say("applyRollbackNotOnBranch", tg=tg))
    todo = []
    for tg, h, kind in commits:
        if git(ctx, 'log', '--format=%H', '--fixed-strings', f'--grep=This reverts commit {h}', 'HEAD', check=False).stdout.strip():
            print(say("applyRollbackDone", tg=tg, h=h[:7]))
            continue
        todo.append((tg, h, kind))
    if not todo:
        print(say("applyRollbackNothing", day=day, a=say("applyRollbackOnly", only=only) if only else ''))
        return 0
    paths = sorted({f for _, h, _ in todo for f in revert_files(ctx, h)})
    dirty = changed_since_head(ctx, paths)
    if dirty:
        print(say("applyRollbackDirty", lst=lst(dirty, 20)))
        return 2
    if git(ctx, 'diff', '--cached', '--quiet', check=False).returncode != 0:
        print(say("applyRollbackStaged"))
        return 2
    cl_dirty = bool(changed_since_head(ctx, [CHANGELOG]))
    gen_before = set(changed_since_head(ctx, list(GENERATED) + lens_files(ctx)))   # 本来就没提交的生成文件：回滚完也不替它提交
    done, notes = [], []
    for tg, h, kind in todo:
        files = revert_files(ctx, h)
        subj = git(ctx, 'log', '-1', '--format=%s', h).stdout.strip()
        if files:
            patch = git(ctx, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--binary', h, f'{h}^', '--', *lit(files)).stdout
            env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0')
            # 只改工作区（不加 --index）：删掉的文件还在暂存区里，下面 commit 的 git add -A 才会记下删除
            p = subprocess.run(['git', '-C', str(ctx.ws), '-c', 'core.hooksPath=/dev/null', 'apply', '-'],
                               input=patch, capture_output=True, text=True, env=env)
            if p.returncode != 0:
                print(say("applyRollbackConflict", tg=tg, h=h[:7], strip=(p.stderr or p.stdout).strip()[:300]))
                print(say("applyRolledBackSoFar", a=say("applySemicolon").join(done) or say("applyNone")))
                return 2
        cl_lines = added_changelog_lines(ctx, h)
        if cl_lines:                                          # changelog 只往后加：把这个提交加的行删掉，她别的行不动
            keep = [l for l in read_text(ctx.ws / CHANGELOG).splitlines() if l.rstrip() not in set(cl_lines)]
            write_atomic(ctx.ws / CHANGELOG, '\n'.join(keep) + ('\n' if keep else ''))
            if cl_dirty:
                notes.append(say("applyRollbackChangelog", tg=tg, a=len(cl_lines)))
        spec = files + ([CHANGELOG] if cl_lines and not cl_dirty else [])
        try:
            rh, why = commit(ctx, spec, say('applyMsgRevert', subj=subj, h=h)) if spec else (None, say("applyNothingToChange"))
        except GitError as e:
            print(say("applyRollbackCommitFailed", tg=tg, e=e))
            print(say("applyRolledBackSoFar", a=say("applySemicolon").join(done) or say("applyNone")))
            return 2
        done.append(say("applyRollbackLine", tg=tg, h=h[:7], subj=subj, a=rh[:7] if rh else why, b=say("applyColonList", lst=lst(files, 8)) if files else ''))
    res = {'errors': []}
    rebuild = run_rebuild(ctx, res)
    gen = [g for g in changed_since_head(ctx, list(GENERATED) + lens_files(ctx)) if g not in gen_before]
    if gen and not res['errors']:
        try:
            gh, _ = commit(ctx, gen, say('applyMsgRegen', head=form('sleepCommit'), day=day, a=say("applyListSep").join(gen)))
            done.append(say("applyRegenerated", a=say("applyListSep").join(gen), b=gh[:7] if gh else say("applyNoChanges")))
            gen = []
        except GitError as e:
            res['errors'].append(say("applyRegenCommitFailed", e=e))
    gen += sorted(gen_before)
    t = now_iso()

    def upd(st):
        d = st.setdefault('steps', {}).setdefault(day, {})
        d.setdefault('rolled_back', []).extend({'tag': tg, 'sha': h, 'kind': k, 'at': t} for tg, h, k in todo)
        d['updated'] = t
        st['last_applied_at'] = t                            # 主会话下一轮重新冻结快照
    state_update(ctx, upd)
    print(say("applyRolledBack2", a='\n  '.join(done)))
    print(say("applyRegeneratedList", a=say("applySemicolon").join(rebuild)))
    for e in res['errors']:
        print(f'❌ {e}')
    for n in notes:
        print(f'⚠️ {n}')
    if gen:
        print(say("applyRegenDirty", a=say("applyListSep").join(gen)))
    print(say("applyLastApplied", t=t))
    return 2 if res['errors'] else 0


# ---------- 每周人格变化 ----------

def week_window(day):
    d = dt.date.fromisoformat(day)
    mon = d - dt.timedelta(days=d.weekday())
    start = dt.datetime.combine(mon, dt.time(DAY_START), TZ)
    return mon, d, start


def classify_commit(ctx, h, subject):
    tags = git(ctx, 'tag', '--points-at', h, check=False).stdout.split()
    if any(t.startswith('sleep/') and '/soul' in t for t in tags) or subject.startswith(form.every('sleepCommit')):
        return say("applyWhoOrganizer")
    if any(t.startswith('day/') for t in tags) or subject.startswith(form.every('dayCommit')):
        return say("applyWhoDaytime")
    return say("applyWhoOther")


def block_hash_at(text):
    lines = text.splitlines()
    out, inside, count = [], False, 0
    for l in lines:
        if l.startswith('#### 好的和坏的'):
            inside, count = True, count + 1
        elif inside and re.match(r'^#{1,4} ', l):
            inside = False
        if inside:
            out.append(l)
    return (sha_bytes('\n'.join(out).encode())[:12] if out else None), count


def cmd_soul_week(ctx, a):
    day = check_day(a.day)
    mon, sun, start = week_window(day)
    if sun.weekday() != 6:
        print(say("applyWeekNotSunday", day=day, mon=mon))
    print(say("applyWeekTitle", mon=mon, sun=sun))
    print(say("applyWeekSec1"))
    rows = [l for l in read_text(ctx.ws / CHANGELOG).splitlines()
            if (m := re.match(r'^- (\d{4}-\d\d-\d\d)', l)) and mon.isoformat() <= m.group(1) <= sun.isoformat()]
    print('\n'.join(rows) or say("applyNone2"))
    print(say("applyWeekSec2"))
    log = git(ctx, 'log', f'--since={start.isoformat()}', '--format=%H%x09%ad%x09%s', '--date=format:%m-%d %H:%M', '--', 'soul/',
              check=False).stdout
    commits = [l.split('\t', 2) for l in log.splitlines() if l.count('\t') >= 2]
    if not commits:
        print(say("applyNone2"))
    for h, when, subj in reversed(commits):
        who = classify_commit(ctx, h, subj)
        stat = git(ctx, 'show', '--stat=200', '--format=', h, '--', 'soul/', check=False).stdout.strip()
        print(say("applyWeekCommit", when=when, h=h[:7], who=who, subj=subj, a='\n'.join('    ' + s for s in stat.splitlines())))
    base = git(ctx, 'rev-list', '-1', f'--before={start.isoformat()}', 'HEAD', check=False).stdout.strip()
    print(say("applyWeekSec3"))
    if base:
        d = git(ctx, 'diff', '--stat=200', base, '--', 'soul/', check=False).stdout.strip()
        print(d or say("applyUnchanged"))
        full = git(ctx, 'diff', '-U1', base, '--', 'soul/', check=False).stdout
        lines = full.splitlines()
        print('\n'.join(lines[:400]) + (say("applyWeekMore", a=len(lines) - 400, base=base[:7]) if len(lines) > 400 else ''))
        old_soul40 = git(ctx, 'show', f'{base}:soul/40-说话方式.md', check=False).stdout
        h0, _ = block_hash_at(old_soul40)
        h1, c1 = block_hash_at(read_text(ctx.ws / 'soul/40-说话方式.md'))
        if h0 is None:
            print(say("applyGoodBadNoBase", c1=c1))
        else:
            print(say("applyGoodBad", a=say("applyGoodBadSame") if h0 == h1 and c1 == 1 else say("applyGoodBadChanged", h0=h0, h1=h1, c1=c1)))
    else:
        print(say("applyNoWeekStart"))
    print(say("applyWeekSec4"))
    D = ctx.day_dir(day)
    any_p = False
    for rel, p in proposed_files(ctx, day):
        if not rel.startswith('soul/'):
            continue
        old = read_text(ctx.ws / rel).splitlines()
        new = read_text(p).splitlines()
        diff = list(difflib.unified_diff(old, new, f'a/{rel}', f'b/{rel}', n=1, lineterm=''))
        if diff:
            any_p = True
            print('\n'.join(diff[:120]))
    if not any_p:
        print(say("applyNone2"))
    if (D / 'sunday-merge').is_dir():
        print(say("applyWeekSunday", day=day))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=say("applyHelp"), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', help=say("applyRootHelp"))
    ap.add_argument('--home', help=say("applyHomeHelp"))
    ap.add_argument('--state-db', help=say("applyStateDbHelp"))
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('gate')
    s.add_argument('--now', help=say("applyNowHelp"))
    s.add_argument('--usage-json', help=say("applyBudgetHelp"))
    s = sub.add_parser('begin')
    s.add_argument('day')
    s.add_argument('--rebaseline', action='store_true', help=say("applyRefingerprintHelp"))
    for name in ('steps', 'plan', 'memory-merge', 'soul-week', 'restart'):
        sub.add_parser(name).add_argument('day')
    s = sub.add_parser('finish')
    s.add_argument('day')
    s.add_argument('--partial', action='store_true', help=say("applyPartialHelp"))
    s = sub.add_parser('material')
    s.add_argument('day')
    s.add_argument('--now', help=say("applyNowHelp"))
    s = sub.add_parser('step')
    s.add_argument('day')
    s.add_argument('name')
    s.add_argument('status', nargs='?', default='done')
    s = sub.add_parser('carry-diff')
    s.add_argument('day')
    s.add_argument('rel')
    for name in ('approve', 'promote'):
        s = sub.add_parser(name)
        s.add_argument('day')
        s.add_argument('rel', nargs='+')
    s = sub.add_parser('rollback')
    s.add_argument('day')
    g = s.add_mutually_exclusive_group()
    g.add_argument('--soul', action='store_true', help=say("applySoulOnlyHelp"))
    g.add_argument('--memory', action='store_true', help=say("applyMemoryOnlyHelp"))
    a = ap.parse_args(argv)
    ctx = Ctx(a.root, a.home, a.state_db)
    fn = {'gate': cmd_gate, 'begin': cmd_begin, 'step': cmd_step, 'steps': cmd_steps, 'plan': cmd_plan, 'material': cmd_material,
          'finish': cmd_finish, 'memory-merge': cmd_memory_merge, 'soul-week': cmd_soul_week, 'restart': cmd_restart,
          'carry-diff': cmd_carry_diff, 'approve': cmd_approve, 'promote': cmd_promote, 'rollback': cmd_rollback}[a.cmd]
    return fn(ctx, a)


if __name__ == '__main__':
    sys.exit(main())
