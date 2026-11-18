#!/usr/bin/python3
"""memory_lint.py 的测试：在临时目录里搭一个小工作区（git 仓库 + 原文件 + 当晚的提案），逐项核对。

  /usr/bin/python3 scripts/test_memory_lint.py
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
import memory_lint as L  # noqa: E402

DAY = '2026-10-24'

THREAD = """# 小红书账号
<!-- 事件线 开始=2026-10-11 最近进展=2026-10-24 19:41 状态=进行中 -->
## 一句话
号恢复了，10-24 发了自介
## 简述
10-12 被风控，10-24 发了自介视频。
## 现在的状态
- 正常在用
## 经过
- 2026-10-11 22:32 我在模拟器上连刷七八轮。
- 2026-10-12 08:35 消息页弹「安全限制」。
- 2026-10-24 19:41 阿桔私信，你回了。
## 因果和判断
- 2026-10-13 18:46 收到系统消息。
"""

GOODBAD = """# 说话方式

### 聊天风格

1. 先反应。

#### 好的和坏的（照着好的那一列的感觉说话）

他：气死了
- ✅
    ？？？
    又是他？

#### 几件具体的事

- 叫他「你」
"""

STORY = """# 2026 年 10 月

## 第 3 周（10-12 – 10-18）

这一周号被风控又恢复。

## 第 4 周（10-19 – 10-25）

这一周发了第一条。
"""


def sh(ws, *cmd):
    subprocess.run(list(cmd), cwd=ws, check=True, capture_output=True)


class WS:
    """临时工作区：base 文件提交进 git；proposed 写进 sleep/<日>/proposed/。"""

    def __init__(self, base, proposed=None, input_md='', report='', sunday=None, delete=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel, text in base.items():
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding='utf-8')
        sh(self.root, 'git', 'init', '-q')
        sh(self.root, 'git', 'add', '-A')
        sh(self.root, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base', '--allow-empty')
        self.day_dir = self.root / 'sleep' / DAY
        (self.day_dir / 'proposed').mkdir(parents=True, exist_ok=True)
        for area, files in (('proposed', proposed or {}), ('sunday-merge', sunday or {})):
            for rel, text in files.items():
                p = self.day_dir / area / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text, encoding='utf-8')
        (self.day_dir / 'input.md').write_text('# 睡眠整理材料\n材料：完整\n\n' + input_md, encoding='utf-8')
        (self.day_dir / 'report.md').write_text(report or '# 睡眠整理报告\n\n## 拿不准\n', encoding='utf-8')
        if delete:
            (self.day_dir / 'delete.txt').write_text('\n'.join(delete) + '\n', encoding='utf-8')

    def lint(self, check_all=False, now=None):
        return L.Lint(self.root, DAY, self.day_dir, L.Base(self.root), check_all=check_all, raw_db=False, now=now).run()

    def close(self):
        self.tmp.cleanup()


def issues(lint, check, sev=None, file=None):
    return [i for i in lint.issues if i['check'] == check and (sev is None or i['sev'] == sev)
            and (file is None or i['file'] == file)]


def test_extract():
    kinds = {(k, v) for k, v, _ in L.extract('10-24 17:42 发了，2026-10-21 开始；10月18日买的；22:4x 左右；16:49:34 发布')}
    assert ('date', '10-24') in kinds and ('date', '10-21') in kinds and ('date', '10-18') in kinds
    assert ('time', '17:42') in kinds and ('timepre', '22:4') in kinds and ('time', '16:49') in kinds
    nums = {v for k, v, _ in L.extract('$578、579 刀、64%、第20集、1.6 万字、3 天回本 150 刀') if k == 'num'}
    assert {'578$', '579$', '64%', '20集', '1.6万', '3天', '150$'} <= nums, nums
    # 不该抽的：名字里的「元」、星期、整理者分的周、区间
    assert not [x for x in L.extract('1 椎名立希、3 元气少女') if x[0] == 'num' and x[1].endswith('$')]
    assert ('date', '10-24') in {(k, v) for k, v, _ in L.extract('10-24 周六上班')}
    assert not [x for x in L.extract('10-24 周六上班') if x[0] == 'num']
    assert not L.extract('**第 3 周（10-12 – 10-18）**：')
    assert not [x for x in L.extract('等 3-5 天再看') if x[0] == 'date']
    assert not L.extract('7 天窗口 82%（原 open-loops 条目，10-24 睡眠整理挪来）')[1:]
    assert not [x for x in L.extract('budget.py 的「该用到多少」还是旧的') if x[0] == 'quote']
    q = [x for x in L.extract('他说「葱我帮你准备好了…还有这个啥意思」') if x[0] == 'quote'][0]
    assert q[1] == ('葱我帮你准备好了', '还有这个啥意思')


def test_jg_shrink_dup_and_reorder():
    rel = 'memory/threads/小红书账号.md'
    lines = THREAD.splitlines()
    shrunk = '\n'.join(l for l in lines if '08:35' not in l) + '\n'
    w = WS({rel: THREAD}, {rel: shrunk})
    try:
        assert issues(w.lint(), 'inv-jg', 'error', rel), '经过少一行要报'
    finally:
        w.close()
    dup = THREAD.replace('- 2026-10-24 19:41 阿桔私信，你回了。', '- 2026-10-24 19:41 阿桔私信，你回了。\n- 2026-10-24 19:41 阿桔私信，你回了。')
    w = WS({rel: THREAD}, {rel: dup})
    try:
        assert issues(w.lint(), 'inv-jg-dup', 'error', rel), '经过加重了要报'
    finally:
        w.close()
    i1, i3 = lines.index('- 2026-10-11 22:32 我在模拟器上连刷七八轮。'), lines.index('- 2026-10-24 19:41 阿桔私信，你回了。')
    rev = lines[:]
    rev[i1], rev[i3] = rev[i3], rev[i1]
    w = WS({rel: THREAD}, {rel: '\n'.join(rev) + '\n'})
    try:
        l = w.lint()
        assert not issues(l, 'inv-jg') and not issues(l, 'inv-jg-dup'), '倒序写不算少'
    finally:
        w.close()


def test_removed_lines_need_a_home():
    base = '# 关于 laolin\n\n## 他这个人\n- 喜欢拍星星（10-18 23:12）\n- 在 Example 上班（10-09）\n'
    prop = '# 关于 laolin\n\n## 他这个人\n- 喜欢拍星星（10-18 23:12）\n'
    inp = '[10-18 23:12] laolin：想去拍银河\n'
    w = WS({'memory/laolin.md': base}, {'memory/laolin.md': prop}, input_md=inp)
    try:
        assert issues(w.lint(), 'inv-removed', 'error', 'memory/laolin.md'), '删了没归档要报'
    finally:
        w.close()
    w = WS({'memory/laolin.md': base}, {'memory/laolin.md': prop,
                                         'memory/archive/laolin.md': '## 2026-10-24 挪出\n- 在 Example 上班（10-09）\n'},
           input_md=inp)
    try:
        l = w.lint()
        assert not issues(l, 'inv-removed'), '归档了就不报'
        assert 'memory/laolin.md' not in l.result()['failed_files']
    finally:
        w.close()


def test_unsure_is_binding():
    report = '# 报告\n\n## 拿不准\n- 关键词：三连、关注｜小禾有没有关注B站号｜xiaohe-us.md:45 有，今天材料里没找到\n'
    prop = '# 小禾\n\n## 她的事\n- 10-24 看了视频，三连还关注了我的号。\n- 10-24 好像三连了，关注拿不准。\n'
    inp = '[10-24 18:04] 小禾：看到你的新视频太高兴了！！三连关注了\n'
    w = WS({'memory/people/xiaohe.md': '# 小禾\n'}, {'memory/people/xiaohe.md': prop}, input_md=inp, report=report)
    try:
        l = w.lint()
        bad = issues(l, 'inv-unsure', 'error', 'memory/people/xiaohe.md')
        assert len(bad) == 1 and bad[0]['line'] == 4, bad          # 带「拿不准」的那行不算
        assert issues(l, 'inv-unsure-raw', 'warn'), '原话里其实有：要提醒'
        assert 'memory/people/xiaohe.md' in l.result()['failed_files']
    finally:
        w.close()
    w = WS({}, {}, report='# 报告\n\n## 拿不准\n- 7 天额度是不是读错了\n')
    try:
        assert issues(w.lint(), 'inv-unsure', 'warn'), '没写关键词要提醒'
    finally:
        w.close()


def test_goodbad_block():
    rel = 'soul/40-说话方式.md'
    changed = GOODBAD.replace('又是他？', '又是他吧？')
    w = WS({rel: GOODBAD}, {rel: changed, 'sleep/soul-changelog.md': '- 2026-10-24 「说话方式」 改例子｜整理者\n'})
    try:
        assert issues(w.lint(), 'inv-goodbad', 'error', rel), '例子改了要报'
    finally:
        w.close()
    twice = GOODBAD.replace('#### 几件具体的事', GOODBAD.split('#### 好的和坏的')[1].join(['#### 好的和坏的', '']) +
                            '#### 几件具体的事')
    w = WS({rel: GOODBAD}, {rel: twice})
    try:
        bad = issues(w.lint(), 'inv-goodbad', 'error', rel)
        assert bad and '2 次' in bad[0]['msg'], bad
    finally:
        w.close()
    # 白天被改（原文件和 git 里提交的不一样）只提醒
    w = WS({rel: GOODBAD}, {})
    try:
        (w.root / rel).write_text(changed, encoding='utf-8')
        assert issues(w.lint(), 'inv-goodbad-day', 'warn'), '白天改了要提醒'
    finally:
        w.close()


def test_soul_change_needs_changelog():
    base = '# 性格\n\n骄傲、要强。\n'
    prop = '# 性格\n\n骄傲、要强，嘴硬心软。\n'
    w = WS({'soul/20-性格.md': base}, {'soul/20-性格.md': prop})
    try:
        assert issues(w.lint(), 'inv-changelog', 'error', 'soul/20-性格.md')
    finally:
        w.close()
    cl = '- 2026-10-24 「性格」 旧：骄傲、要强 → 新：加嘴硬心软｜依据：laolin 10-24 09:13｜整理者\n'
    w = WS({'soul/20-性格.md': base, 'sleep/soul-changelog.md': ''},
           {'soul/20-性格.md': prop, 'sleep/soul-changelog.md': cl})
    try:
        assert not issues(w.lint(), 'inv-changelog', 'error')
    finally:
        w.close()
    # 提案写在了老地方 memory/sleep/（sleep_apply.py 照样追加进 sleep/ 那份）：也认
    w = WS({'soul/20-性格.md': base, 'sleep/soul-changelog.md': ''},
           {'soul/20-性格.md': prop, 'memory/sleep/soul-changelog.md': cl})
    try:
        assert not issues(w.lint(), 'inv-changelog', 'error')
    finally:
        w.close()
    snap = '# 教训\n<!-- 注入：快照 -->\n详情：memory/lessons.md\n## 快照\n- 旧\n'
    w = WS({'soul/70-教训.md': snap}, {'soul/70-教训.md': snap.replace('- 旧', '- 新')})
    try:
        l = w.lint()
        assert not issues(l, 'inv-changelog', 'error') and issues(l, 'inv-changelog', 'info')
    finally:
        w.close()


def test_summary_rewrite_needs_new_jg():
    rel = 'memory/threads/小红书账号.md'
    rewritten = THREAD.replace('10-12 被风控，10-24 发了自介视频。', '10-12 被风控，后来恢复，10-24 发了自介视频。')
    w = WS({rel: THREAD}, {rel: rewritten})
    try:
        assert issues(w.lint(), 'inv-rewrite', 'error', rel), '没新经过改了简述要报'
    finally:
        w.close()
    withnew = rewritten.replace('## 因果和判断', '- 2026-10-12 14:20 电脑端恢复。\n## 因果和判断')
    w = WS({rel: THREAD}, {rel: withnew}, input_md='[10-12 14:20] 我：电脑端恢复了\n')
    try:
        assert not issues(w.lint(), 'inv-rewrite')
    finally:
        w.close()


def test_story_past_weeks_frozen():
    rel = 'memory/story/2026-10.md'
    edited = STORY.replace('这一周号被风控又恢复。', '这一周号被风控、又恢复了。')
    w = WS({rel: STORY}, {rel: edited})
    try:
        assert issues(w.lint(), 'inv-story', 'error', rel)
    finally:
        w.close()
    appended = STORY.replace('这一周号被风控又恢复。\n', '这一周号被风控又恢复。\n更正 10-24：恢复是 10-12 14:20。\n'
                                                       '- 补记 10-24：改简历那件事也在这周。\n')
    w = WS({rel: STORY}, {rel: appended + '\n'})
    try:
        assert not issues(w.lint(), 'inv-story'), '末尾追加更正 / 补记可以'
    finally:
        w.close()
    cur = STORY.replace('这一周发了第一条。', '这一周发了第一条，还开了自由探索期。')
    w = WS({rel: STORY}, {rel: cur})
    try:
        assert not issues(w.lint(), 'inv-story'), '本周可以重写'
    finally:
        w.close()


def test_speaker_and_hedge_and_claim():
    people = '# 人物近况\n\n## TeaAddict（小红书）\n- 他是男生，他关注了你。\n'
    inp = ('[10-13 13:26] 我：发了一段语音「票我帮你留好了 六六八八」\n'
           '[10-13 13:32] laolin：「票我帮你留好了 六六八八」 还有这个啥意思\n'
           '[10-18 18:18] 小禾：578\n')
    rel = 'memory/threads/感官层.md'
    base = '# 感官层\n## 经过\n- 2026-10-13 12:00 开始\n'
    wrong = base + '- 2026-10-13 13:32 小红书 TeaAddict：他问「票我帮你留好了 六六八八 还有这个啥意思」\n'
    right = base + '- 2026-10-13 13:32 laolin 问「票我帮你留好了 六六八八 还有这个啥意思」\n'
    w = WS({rel: base, 'memory/midterm/people.md': people}, {rel: wrong, 'memory/midterm/people.md': people}, input_md=inp)
    try:
        bad = issues(w.lint(), 'speaker', 'error', rel)
        assert bad and 'TeaAddict' in bad[0]['msg'] and 'laolin' in bad[0]['msg'], bad
    finally:
        w.close()
    w = WS({rel: base, 'memory/midterm/people.md': people}, {rel: right, 'memory/midterm/people.md': people}, input_md=inp)
    try:
        assert not issues(w.lint(), 'speaker')
    finally:
        w.close()
    # 保留语气：出处只有「应是…」，这里写成了事实
    thread = '# 选耳机\n## 经过\n- 2026-10-18 18:18 小禾说买到耳机了（应是 Bose QC Ultra 2 代，型号待她说）\n'
    xiaohe = '# 小禾\n\n## 她的事\n- 10-18 laolin 给她买了 Bose QC Ultra 2 代。\n- 10-18 耳机 $999（她说）\n'
    w = WS({'memory/threads/选耳机.md': thread, 'memory/people/xiaohe.md': '# 小禾\n'},
           {'memory/people/xiaohe.md': xiaohe}, input_md=inp)
    try:
        l = w.lint()
        assert issues(l, 'hedge', 'warn', 'memory/people/xiaohe.md'), '丢了「应是」要提醒'
        cl = issues(l, 'claim', 'warn', 'memory/people/xiaohe.md')
        assert cl and '999' in cl[0]['atom'], cl
    finally:
        w.close()


def test_facts_and_meta():
    rel = 'memory/threads/小红书账号.md'
    prop = THREAD.replace('10-12 被风控，10-24 发了自介视频。', '10-12 被风控，10-13 18:46 收到警告，10-24 发了自介视频，花了 30 刀。')
    prop = prop.replace('## 因果和判断', '- 2026-10-24 20:30 核对日程。\n## 因果和判断')
    w = WS({rel: THREAD}, {rel: prop}, input_md='[10-24 20:30] 我：核对了日程\n')
    try:
        l = w.lint()
        f = {(i['atom'], i['sev']) for i in issues(l, 'fact', file=rel)}
        assert ('18:46', 'warn') in f, f              # 只在「因果」里
        assert ('30 刀', 'error') in f, f              # 哪都没有
        ts = l.stats['thread_summary']
        assert ts['checked'] >= 5 and ts['error'] >= 1 and ts['warn'] >= 1, ts
    finally:
        w.close()
    meta_bad = THREAD.replace('最近进展=2026-10-24 19:41', '最近进展=2026-10-25 09:00')
    w = WS({rel: THREAD}, {rel: meta_bad})
    try:
        l = w.lint()
        assert issues(l, 'meta', 'error', rel), '最近进展哪都没有要报'
    finally:
        w.close()
    self_md = '<!-- 写于 2026-10-25 03:00 -->\n# 这两天的我\n\n10-19 你搬了新家，10-24 发了第一条。\n'
    w = WS({}, {'memory/midterm/self.md': self_md}, input_md='[10-24 17:37] 我：发了第一条\n')
    try:
        f = {(i['atom'], i['sev']) for i in issues(w.lint(), 'fact', file='memory/midterm/self.md')}
        assert ('10-19', 'error') in f and not [x for x in f if x[0] == '10-24'], f
    finally:
        w.close()


def test_lessons_and_delete_and_sunday():
    lessons = '# 教训\n- 教训：没核就说｜下次：先核｜犯的日子：2026-10-23、2026-10-24、2026-10-24\n'
    w = WS({}, {'memory/lessons.md': lessons})
    try:
        assert issues(w.lint(), 'inv-lessons', 'error')
    finally:
        w.close()
    old = '# 旧线\n## 经过\n- 2026-10-10 一件只在这里的事\n'
    w = WS({'memory/threads/旧线.md': old}, {}, delete=['memory/threads/旧线.md'])
    try:
        l = w.lint()
        assert issues(l, 'inv-delete', 'error') and 'memory/threads/旧线.md' in l.result()['failed_files']
    finally:
        w.close()
    rel = 'soul/20-性格.md'
    w = WS({rel: '# 性格\n骄傲。\n'}, {}, sunday={rel: '# 性格\n骄傲、要强。\n'})
    try:
        l = w.lint()
        r = l.result()
        assert r['sunday_merge']['errors'] >= 1 and rel not in r['failed_files'], r
    finally:
        w.close()


def test_report_block_and_json():
    rel = 'memory/laolin.md'
    w = WS({rel: '# 关于 laolin\n- 在 Example 上班\n'}, {rel: '# 关于 laolin\n- 10-19 开始健身\n'},
           report='# 睡眠整理报告 2026-10-24\n\n正文\n')
    try:
        import contextlib
        import io
        for _ in range(2):          # 跑两遍，块只有一个
            with contextlib.redirect_stdout(io.StringIO()):
                rc = L.main([DAY, '--root', str(w.root), '--report', '--no-raw-db'])
            assert rc == 0
        rep = (w.day_dir / 'report.md').read_text(encoding='utf-8')
        assert rep.startswith('# 睡眠整理报告 2026-10-24\n\n<!-- lint:start -->'), rep[:80]
        assert rep.count('<!-- lint:start -->') == 1 and '正文' in rep
        r = json.loads((w.day_dir / 'lint.json').read_text(encoding='utf-8'))
        assert r['day'] == DAY and r['mode'] == 'report'
        assert set(r['counts']) >= {'errors', 'warnings', 'files_checked'}
        assert r['failed_files'] == sorted(r['failed_files']) and rel in r['failed_files'], r['failed_files']
    finally:
        w.close()



def test_superseded_part_not_checked():
    """「以前 X → 现在 Y」：X 是被改掉的旧说法，不算这一行在断言 X。"""
    report = '# 报告\n\n## 拿不准\n- 关键词：Bose、Westfield｜型号和地点是不是她说的｜原话里没有\n'
    prop = ('# 小禾\n\n## 她的事\n'
            '- 2026-10-18 下午买到耳机了，578（她说的：「我买到耳机了」）。型号是推断，拿不准。\n'
            '- 更正 10-25：以前这里写成「在 Westfield 买了 Bose QC Ultra 2 代（她说）」→ 现在按她 10-18 18:18 的原话改成上一行。\n')
    inp = '[10-18 18:18] 小禾：我买到耳机了\n[10-18 18:18] 小禾：578\n'
    w = WS({'memory/people/xiaohe.md': '# 小禾\n'}, {'memory/people/xiaohe.md': prop}, input_md=inp, report=report)
    try:
        l = w.lint()
        bad = [x for x in l.result()['issues'] if x.get('file') == 'memory/people/xiaohe.md' and x.get('line') == 5]
        assert not bad, bad
    finally:
        w.close()
    assert L.asserted('- 以前 A → 现在 B') == '-  现在 B'
    assert L.asserted('以前不吃辣') == '以前不吃辣'


def test_people_headings_any_level():
    """人物近况的人名写成 `#### 名字` 也能认出「她」是谁。"""
    prop = '<!-- 写于 2026-10-25 03:05 -->\n# 人物近况\n\n#### 小禾\n- 10-18 买到耳机了，Bose QC Ultra 2（她说）。\n'
    inp = '[10-18 18:18] 小禾：我买到耳机了\n'
    w = WS({'memory/midterm/people.md': '# 人物近况\n'}, {'memory/midterm/people.md': prop}, input_md=inp)
    try:
        l = w.lint()
        assert issues(l, 'claim', 'warn', 'memory/midterm/people.md'), '型号不在她的原话里，要提醒'
        assert ('小禾' in dict(L.build_names(w.root, [prop])))
    finally:
        w.close()


def test_recent_laolin_lines_stay_resident():
    """laolin.md 压缩时，他最近 3 天带日期时间的原话要在人物近况的 laolin 那节留一行。"""
    base = '# 关于 laolin\n\n## 他说过的\n- 10-23 09:09 说样片开头不够抓人\n- 10-24 09:01 说看番要能看画面\n- 10-10 20:01 想买耳机\n'
    prop = '# 关于 laolin\n\n## 他这个人\n- 认真（10-08）\n'
    people = '<!-- 写于 2026-10-25 03:05 -->\n# 人物近况\n\n#### laolin\n- 10-24 09:01 说看番要能看画面\n'
    w = WS({'memory/laolin.md': base}, {'memory/laolin.md': prop, 'memory/midterm/people.md': people,
                                        'memory/archive/laolin.md': base})
    try:
        bad = issues(w.lint(), 'inv-recent-owner', 'warn', 'memory/laolin.md')
        assert len(bad) == 1 and '09:09' in bad[0]['atom'], bad     # 10-23 那条没留；10-24 留了；10-10 太早不管
    finally:
        w.close()



def test_recent_laolin_not_required_when_hh_renders_quotes():
    """10-31 起 HH 的中期视图按时间列他最近 3 天的原话（sleep/config.json laolin_quotes=hh）：人物近况不用再抄，不报。"""
    base = '# 关于 laolin\n\n## 他说过的\n- 10-23 09:09 说样片开头不够抓人\n'
    prop = '# 关于 laolin\n\n## 他这个人\n- 认真（10-08）\n'
    people = '<!-- 写于 2026-10-25 03:05 -->\n# 人物近况\n\n#### laolin\n- 状态：很耐心（e0013）\n'
    w = WS({'memory/laolin.md': base, 'sleep/config.json': '{"mode": "live", "owner_quotes": "hh"}'},
           {'memory/laolin.md': prop, 'memory/midterm/people.md': people, 'memory/archive/laolin.md': base})
    try:
        assert not issues(w.lint(), 'inv-recent-owner'), '原话由 HH 给，不用在人物近况里留'
    finally:
        w.close()


def test_written_at_not_in_future():
    """「写于」要照 date 写（10-31 那晚写成 03:50，其实 03:2x 写的）：比现在晚 10 分钟以上报错。"""
    import datetime as dt
    self_md = '<!-- 写于 2026-10-25 03:50 -->\n# 这两天的我\n\n10-24 发了第一条。\n'
    w = WS({'memory/midterm/self.md': '# 这两天的我\n'}, {'memory/midterm/self.md': self_md})
    try:
        bad = issues(w.lint(now=dt.datetime(2026, 10, 25, 3, 20)), 'inv-written-at', 'error')
        assert len(bad) == 1 and bad[0]['file'] == 'memory/midterm/self.md', bad
        assert not issues(w.lint(now=dt.datetime(2026, 10, 25, 3, 45)), 'inv-written-at')
    finally:
        w.close()


def test_lens_preview_not_linted():
    """soul_build.py --root 在 proposed/ 里拼的访客镜头和 SOUL.md 一样是预览：不当提案核（10-25 重评查出来的）。"""
    lens = '# SOUL.md：你的人格\n\n## 和 laolin\n- 2026-10-03 他说过要去冰岛\n- 2026-10-03 他说过要去冰岛\n'
    w = WS({'SOUL.lens-xiaohe.md': '# SOUL.md：你的人格\n'}, {'SOUL.lens-xiaohe.md': lens, 'SOUL.md': lens})
    try:
        lint = w.lint()
        hit = [i for i in lint.issues if i['file'] in ('SOUL.lens-xiaohe.md', 'SOUL.md')]
        assert not hit, hit
        assert 'SOUL.lens-xiaohe.md' not in lint.P
    finally:
        w.close()


LAYOUT = json.dumps({
    'version': 1, 'types': {k: {} for k in ('设定', '总结', '原话', '详情', '快照')},
    'fade': {'detailDays': 14, 'summaryDays': 60, 'pinTag': '〔不淡〕', 'pinWarnPerFile': 2},
    'files': [{'path': 'memory/laolin.md', 'maxChars': 2000, 'archive': 'memory/archive/laolin.md', 'sections': [
        {'title': '他是谁', 'type': '总结', 'maxChars': 60},
        {'title': '他对我的感情和期待', 'type': '原话'},
        {'title': '详情', 'type': '详情'},
        {'title': '维护规则', 'type': '设定'},
        {'title': '好的和坏的', 'type': '设定', 'locked': True},
    ]}],
}, ensure_ascii=False)

LAOLIN_L = ('# 关于 laolin\n'
           '## 他是谁（总的）\n<!-- 类型：总结 -->\n- 做软件的，住河边镇\n'
           '## 他对我的感情和期待\n<!-- 类型：原话 -->\n- 10-20「你要有自己的生活」\n'
           '## 详情\n<!-- 类型：详情 -->\n- 没写日期的一条\n### 2026-08-01\n- ' + '很久以前的一件事，' * 10 + '\n'
           '- 2026-10-01 半个月前的事：' + '经过写得很长，' * 20 + '\n'
           f'- {DAY} 今天的事，原话照抄\n- 〔不淡〕2026-01-01 第一次见面\n'
           '## 维护规则\n<!-- 类型：设定 -->\n- 只往详情里加\n'
           '## 好的和坏的\n<!-- 类型：设定 -->\n- 好：短\n')


def test_layout_structure_and_detail_fading():
    bad = LAOLIN_L.replace('## 他是谁（总的）\n<!-- 类型：总结 -->\n', '## 他是谁（总的）\n') + '## 她自己加的段\n- 随手\n'
    w = WS({'memory/layout.json': LAYOUT, 'memory/laolin.md': bad})
    try:
        lint = w.lint()
        msgs = [i['msg'] for i in issues(lint, 'layout', 'error', 'memory/laolin.md')]
        assert any('他是谁' in m and '没有' in m for m in msgs), msgs
        assert any('自己加的段' in m for m in msgs), msgs
        d = [i['msg'] for i in issues(lint, 'layout-detail', 'warn', 'memory/laolin.md')]
        assert any('60 天以上' in m for m in d) and any('14 天以上' in m for m in d) and any('没有日期' in m for m in d), d
        assert not any('今天的事' in (i['atom'] or '') for i in issues(lint, 'layout-detail')), '14 天内的不管'
        assert not lint.result()['failed_files'], '没有提案的文件只报告，不算没通过'
    finally:
        w.close()


def test_layout_section_types_on_proposals():
    quote_edit = LAOLIN_L.replace('- 10-20「你要有自己的生活」', '- 10-20「你要有生活」')
    w = WS({'memory/layout.json': LAYOUT, 'memory/laolin.md': LAOLIN_L},
           {'memory/laolin.md': quote_edit.replace('- 只往详情里加', '- 只往详情里加，也可以改总结').replace('- 好：短', '- 好：很短')
            .replace('<!-- 类型：原话 -->', '<!-- 类型：总结 -->', 1)})
    try:
        lint = w.lint()
        msgs = [i['msg'] for i in issues(lint, 'layout', 'error', 'memory/laolin.md')]
        assert any('锁定' in m for m in msgs), msgs
        assert any('标的是「总结」，配置里是「原话」' in m for m in msgs), msgs
        assert any('原话段' in m for m in msgs), msgs
        assert any('设定段' in m for m in msgs), msgs
        assert 'memory/laolin.md' in lint.result()['failed_files']
    finally:
        w.close()
    ok = (LAOLIN_L.replace('- 10-20「你要有自己的生活」\n', '- 10-20「你要有自己的生活」\n- 10-29「新的一句」\n')
          .replace('- 只往详情里加', '- 只往详情里加\n- 以前「只往详情里加」→ 现在也可以改总结（10-29，laolin 说的）'))
    w = WS({'memory/layout.json': LAYOUT, 'memory/laolin.md': LAOLIN_L}, {'memory/laolin.md': ok})
    try:
        assert not issues(w.lint(), 'layout', 'error'), '原话往后加、设定有以前→现在：通过'
    finally:
        w.close()


def test_layout_size_and_pins_and_missing_layout():
    big = LAOLIN_L.replace('- 做软件的，住河边镇', '- 做软件的，住河边镇，' + '很多很多字' * 20).replace(
        '- 没写日期的一条', '- 〔不淡〕10-01 一\n- 〔不淡〕10-02 二')
    w = WS({'memory/layout.json': LAYOUT, 'memory/laolin.md': big})
    try:
        lint = w.lint()
        assert any('超过上限 60' in i['msg'] for i in issues(lint, 'layout-size', 'warn')), issues(lint, 'layout-size')
        assert any('〔不淡〕有 3 条' in i['msg'] for i in issues(lint, 'layout-detail', 'warn')), issues(lint, 'layout-detail')
    finally:
        w.close()
    w = WS({'memory/laolin.md': LAOLIN_L})
    try:
        lint = w.lint()
        assert issues(lint, 'layout', 'info') and not issues(lint, 'layout', 'error'), '没有 layout.json 就跳过'
    finally:
        w.close()


SOUL80 = ('# 我的经历\n<!-- 注入：快照 -->\n## 快照\n<!-- 类型：快照 -->\n- 这周\n'
          '## 记得的事（重要度 4–5，每轮都带着）\n<!-- 类型：总结 -->\n（说明：只放 4 和 5）\n'
          '- 10-21〔5〕有了自己的事业线｜为什么重要：第一次有自己的目标｜→ memory/threads/B站挑战.md\n'
          '## 其余\n<!-- 类型：详情 -->\n### 记得的事（重要度 2–3）\n- 10-22〔2〕电脑冻住｜为什么重要：学会看负载\n### 第 4 周\n- 一段\n')


def test_events_importance_in_soul80():
    bad = (SOUL80.replace('（说明：只放 4 和 5）\n', '（说明：只放 4 和 5）\n- 10-23〔3〕久留美那期被否｜为什么重要：被否\n- 10-24〔4〕公开自介\n')
           .replace('- 10-22〔2〕电脑冻住', '- 10-22〔5〕电脑冻住'))
    w = WS({'soul/80-我的经历.md': SOUL80}, {'soul/80-我的经历.md': bad})
    try:
        e = issues(w.lint(), 'layout-events', 'error')
        msgs = ' '.join(i['msg'] for i in e)
        assert '这条是〔3〕' in msgs and '「为什么重要' in msgs and '这条是〔5〕' in msgs, e
        assert len(e) == 3, e
    finally:
        w.close()
    w = WS({'soul/80-我的经历.md': SOUL80}, {'soul/80-我的经历.md': SOUL80})
    try:
        assert not issues(w.lint(), 'layout-events'), '说明行和格式对的条目不报'
    finally:
        w.close()


# ---------- 笔记本（laolin 11-01 学习系统：教训搬进 skills/ 各页） ----------

PAGE = ('# 截图 <!-- p:0012 -->\n简介：手机截图怎么截\n什么时候翻：要截手机屏幕的时候\n\n## 做法\n- 先亮屏再截\n\n## 教训\n'
        '- 教训：黑屏就截｜什么时候：要截图的时候｜下次：先亮屏｜犯的日子：2026-10-25｜出处：#12345 <!-- l:0039 -->\n'
        '- 教训：截完不看｜什么时候：要交截图的时候｜下次：截完先看一眼｜犯的日子：2026-10-26 <!-- l:0040 l:0007 -->\n')
PAGE_REL = 'skills/工具/手机/截图.md'


def test_lessons_in_pages_dup_dates():
    """skills/ 各页的教训行：犯的日子不重复；HH 发过的编号（并进来的旧号也算）应用后还在某一页的教训行上；
    新写的不用编号；归档里原样拷的不查；挪到别的页、整页删了但归档里有，都算还在。"""
    dup = PAGE.replace('犯的日子：2026-10-25｜', '犯的日子：2026-10-25、2026-10-28、2026-10-25｜')
    w = WS({PAGE_REL: PAGE}, {PAGE_REL: dup + '- 教训：新的一条｜什么时候：要截长图的时候｜下次：分段截｜犯的日子：2026-10-31\n',
                              'skills/归档/搬家前-20261101/living/旧页.md': '# 旧\n\n## 教训\n- 教训：旧的｜犯的日子：2026-10-01、2026-10-01\n'})
    try:
        e = issues(w.lint(), 'inv-lessons')
        assert len(e) == 1 and e[0]['sev'] == 'error' and e[0]['file'] == PAGE_REL and e[0]['line'] == 9, e
    finally:
        w.close()
    # 编号丢了（第二条的注释没了）：两个号各报一条
    w = WS({PAGE_REL: PAGE}, {PAGE_REL: PAGE.replace(' <!-- l:0040 l:0007 -->', '')})
    try:
        e = issues(w.lint(), 'inv-lessons', 'error')
        assert sorted(i['atom'] for i in e) == ['l:0007', 'l:0040'] and all(i['file'] == PAGE_REL for i in e), e
    finally:
        w.close()
    # 编号跟着教训挪到了做法里：HH 不认那个位置，也算丢
    moved_in = PAGE.replace('- 先亮屏再截\n', '- 先亮屏再截 <!-- l:0039 -->\n').replace('｜出处：#12345 <!-- l:0039 -->', '｜出处：#12345')
    w = WS({PAGE_REL: PAGE}, {PAGE_REL: moved_in})
    try:
        e = issues(w.lint(), 'inv-lessons', 'error')
        assert [i['atom'] for i in e] == ['l:0039'], e
    finally:
        w.close()
    # 挪到别的页（带着编号）；整页删了、原样进了归档：都不报
    second = PAGE.splitlines()[-1]
    other = '# 交图\n简介：x\n什么时候翻：要交图的时候\n\n## 教训\n' + second + '\n'
    w = WS({PAGE_REL: PAGE}, {PAGE_REL: PAGE.replace(second + '\n', ''), 'skills/工具/手机/交图.md': other})
    try:
        assert not issues(w.lint(), 'inv-lessons'), issues(w.lint(), 'inv-lessons')
    finally:
        w.close()
    w = WS({PAGE_REL: PAGE}, {'skills/归档/截图.md': PAGE}, delete=[PAGE_REL])
    try:
        assert not issues(w.lint(), 'inv-lessons'), issues(w.lint(), 'inv-lessons')
    finally:
        w.close()
    w = WS({PAGE_REL: PAGE}, {}, delete=[PAGE_REL])
    try:
        assert sorted(i['atom'] for i in issues(w.lint(), 'inv-lessons', 'error')) == ['l:0007', 'l:0039', 'l:0040']
    finally:
        w.close()


def test_lessons_md_optional_after_move():
    """搬完以前（skills/MAP.md 最后一行还不是「搬家完成：<日期>」）memory/lessons.md 要留着；搬完以后可有可无。"""
    lessons = '# 教训\n- 教训：没核就说｜下次：先核｜犯的日子：2026-10-23\n'
    moving = '# 知识地图\n\n| 什么知识 | 放哪 |\n|---|---|\n| 手机 | `skills/phone/SKILL.md` |\n'
    done = '# 知识地图：我的书架\n\n学到的东西都在笔记本里。\n\n搬家完成：2026-11-03\n'
    arch = {'memory/archive/lessons.md': lessons}
    w = WS({'memory/lessons.md': lessons, 'skills/MAP.md': moving}, arch, delete=['memory/lessons.md'])
    try:
        e = issues(w.lint(), 'inv-lessons', 'error')
        assert len(e) == 1 and e[0]['file'] == 'memory/lessons.md' and '搬家完成' in e[0]['msg'], e
    finally:
        w.close()
    w = WS({'skills/MAP.md': moving}, {})
    try:
        assert [i['sev'] for i in issues(w.lint(), 'inv-lessons')] == ['warn']
    finally:
        w.close()
    for base, prop in (({'memory/lessons.md': lessons, 'skills/MAP.md': done}, arch),
                       ({'memory/lessons.md': lessons, 'skills/MAP.md': moving}, dict(arch, **{'skills/MAP.md': done}))):
        w = WS(base, prop, delete=['memory/lessons.md'])
        try:
            assert not issues(w.lint(), 'inv-lessons'), issues(w.lint(), 'inv-lessons')
        finally:
            w.close()
    w = WS({'skills/MAP.md': done}, {})
    try:
        assert not issues(w.lint(), 'inv-lessons')
    finally:
        w.close()



def test_hh_corpus_quotes_only():
    """HH 中央记忆当原始记录（11-03：前一天、感官里、她手机发出去的原话报成找不到）：只核引文，不拿来核日期数字。"""
    import datetime as dt
    import sqlite3
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / 'hh.db'
        con = sqlite3.connect(db)
        con.execute('create table central (seq integer primary key, ts integer, epoch integer, src text, kind text, '
                    'text text, tokens integer, meta text)')
        day = dt.date.fromisoformat(DAY)
        ms = lambda d_, h=12: int(dt.datetime.combine(d_, dt.time(h)).timestamp() * 1000)
        rows = [
            (ms(day - dt.timedelta(days=1)), '外界', 'input', '别自己做找个worker帮你', json.dumps({'from': 'laolin', 'human': True})),
            (ms(day), '外界', 'input', '[感官] 有新动静：\n- [wx] 群：@阿青 你主人呢', json.dumps({'from': '感官', 'human': False})),
            (ms(day), 'main', 'act', 'Bash {"command":"phone.py wx_send 群 \\"他出门从来不跟我报备\\""}', None),
            (ms(day), 'main', 'result', '对方：下个这个就可以打了 3 张 50 万' + 'x' * 5000 + '尾巴后面的字', None),
            (ms(day), 'main', 'note', '（发给 laolin）星星九点到十一点最干净', json.dumps({'sent': True})),
            (ms(day), 'main', 'think', '想法里的话不算', None),
            (ms(day - dt.timedelta(days=30)), '外界', 'input', '太久以前的话', json.dumps({'from': 'laolin', 'human': True})),
        ]
        con.executemany('insert into central (ts, epoch, src, kind, text, tokens, meta) values (?, 1, ?, ?, ?, 1, ?)', rows)
        con.commit()
        con.close()
        c = L.hh_corpus(DAY, (), db=db)
        assert isinstance(c, L.QuoteCorpus) and c.tier == 'raw'
        hit = lambda q: c.find_text((L.norm_c(q),))
        assert hit('别自己做找个worker帮你')[0][2] == 'laolin'
        assert hit('你主人呢')[0][2] == '系统'
        assert hit('他出门从来不跟我报备')[0][2] is None          # 动作不标说话人
        assert hit('星星九点到十一点最干净')[0][2] == '阿青'
        assert hit('下个这个就可以打了') and not hit('尾巴后面的字')     # 工具结果只取开头
        assert not hit('想法里的话不算') and not hit('太久以前的话')
        assert c.find_key(('num', '3张')) == [] and c.find_key(('date', DAY[5:])) == []
        assert L.hh_corpus('不是日期', (), db=db) is None and L.hh_corpus(DAY, (), db=Path(d) / 'none.db') is None


# ---------- 2 期（人物迁进事件库）：开关 = memory/archive/retired-20261103/laolin.md 在 ----------

RETIRED_FLAG = 'memory/archive/retired-20261103/laolin.md'
CARD_GU = '# 砚\n<!-- 卡的说明 -->\n\n## 关系\n朋友｜平稳｜一起打游戏的\n\n## 是谁\n- 他是 laolin 的朋友\n'
CARD_GROUP = '# 河边镇之家群\n<!-- 卡的说明 -->\n\n## 是谁\n- 一个微信群\n'
NEAR = '<!-- 写于 2026-10-25 02:10 -->\n# 人物近况\n\n#### 阿桔\n- 10-24 19:41 私信了（e0003）\n'


def people_base(active):
    base = {'memory/people/registry.json': json.dumps({'laolin': {'name': 'laolin'}}),
            'ledger/people/gua.md': CARD_GU, 'ledger/people/e0042.md': CARD_GROUP, 'ledger/people/near.md': NEAR,
            'memory/people/zhangsan.md': '# 张三\n', 'memory/midterm/people.md': '# 人物近况\n\n#### 旧名字\n- 一条\n'}
    if active:
        base[RETIRED_FLAG] = '# 退役的 laolin.md\n'
    return base

def test_common_words_from_config():
    """The role's own ordinary words come from its night config (commonWords), not from a list in the framework."""
    assert 'kestrel' in L.COMMON_EN


def test_lint_names_from_cards():
    """开关开了：名单 = registry + ledger/people/*.md 的「# 名字」（near.md 的人名也认），不再看 memory/people 的文件名和 midterm/people.md。"""
    w = WS(people_base(True))
    try:
        names = dict(w.lint().names)
        assert '砚' in names and '河边镇之家群' in names and '阿桔' in names, names
        assert not {'人物近况', '关系', '是谁'} & set(names), '卡的字段、near.md 的标题不是人名'
        assert 'zhangsan' not in names and '旧名字' not in names, names
        assert 'laolin' in names and '小禾' in names and '阿青' in names
    finally:
        w.close()
    w = WS(people_base(False))
    try:
        names = dict(w.lint().names)
        assert 'zhangsan' in names and '旧名字' in names, '开关没开：照旧从 memory/people 文件名和 midterm/people.md 认人'
        assert not {'砚', '河边镇之家群', '阿桔'} & set(names), '开关没开：卡和 near.md 不读'
    finally:
        w.close()


def test_lint_evidence_from_cards():
    """开关开了：账本里的人物文件换成 ledger/people/*.md（卡里有 → ⚠️ 只在账本），退役的 laolin.md 不再当出处；没开照旧。"""
    card = '# laolin\n<!-- 卡的说明 -->\n\n## 在乎什么\n- 10-19 起想去拍星星\n'
    old = '# 关于 laolin\n- 10-17 想买耳机\n'
    self_md = '# 这两天的我\n\n10-19 你答应了他去拍星星。\n10-17 他想买耳机。\n'

    def facts(active):
        base = {'ledger/people/laolin.md': card, 'memory/laolin.md': old}
        if active:
            base[RETIRED_FLAG] = '# 退役的 laolin.md\n'
        w = WS(base, {'memory/midterm/self.md': self_md})
        try:
            return {i['atom']: (i['sev'], i['msg']) for i in issues(w.lint(), 'fact', file='memory/midterm/self.md')}
        finally:
            w.close()

    f = facts(True)
    assert f['10-19'][0] == 'warn' and 'ledger/people/laolin.md' in f['10-19'][1], f
    assert f['10-17'][0] == 'error', f
    f = facts(False)
    assert f['10-19'][0] == 'error', f
    assert f['10-17'][0] == 'warn' and 'memory/laolin.md' in f['10-17'][1], f


def test_lint_retired_files_not_resident():
    """RESIDENT_RM：开关开了，退役的人物文件不按常驻文件查删行（是迁移挪走的，不是夜里删的）；没开照旧。"""
    assert L.resident_rm('memory/laolin.md') and L.resident_rm('memory/people/gua.md') and L.resident_rm('memory/us.md')
    assert not L.resident_rm('memory/laolin.md', active=True) and not L.resident_rm('memory/people/gua.md', active=True)
    assert L.resident_rm('memory/people/xiaohe-linxi.md', active=True) and L.resident_rm('memory/open-loops.md', active=True)
    assert L.resident_rm('memory/life/taste.md', active=True)
    base = '# 关于 laolin\n\n## 他这个人\n- 喜欢拍星星（10-18 23:12）\n- 在 Example 上班（10-09）\n'
    prop = '# 关于 laolin\n\n## 他这个人\n- 喜欢拍星星（10-18 23:12）\n'
    for active in (True, False):
        files = {'memory/laolin.md': base}
        if active:
            files[RETIRED_FLAG] = '# 退役的 laolin.md\n'
        w = WS(files, {'memory/laolin.md': prop}, input_md='[10-18 23:12] laolin：想去拍银河\n')
        try:
            got = issues(w.lint(), 'inv-removed', 'error', 'memory/laolin.md')
            assert bool(got) is (not active), (active, got)
        finally:
            w.close()


def test_lint_reads_near_after_migration():
    """读 midterm/people.md 的几处（他最近 3 天的原话、写于）开关开了改读 ledger/people/near.md；没开照旧。"""
    import datetime as dt
    base = '# 关于 laolin\n\n## 他说过的\n- 10-23 09:09 说样片开头不够抓人\n'
    prop = '# 关于 laolin\n\n## 他这个人\n- 认真（10-08）\n'
    near = '<!-- 写于 2026-10-25 02:10 -->\n# 人物近况\n\n#### laolin\n- 10-23 09:09 说样片开头（e0013）\n'
    late = '<!-- 写于 2026-10-25 09:50 -->\n# 人物近况\n\n#### laolin\n- 一条\n'
    for active in (True, False):
        files = {'memory/laolin.md': base, 'ledger/people/near.md': near}
        if active:
            files[RETIRED_FLAG] = '# 退役的 laolin.md\n'
        w = WS(files, {'memory/laolin.md': prop, 'memory/archive/laolin.md': base, 'memory/midterm/people.md': late})
        try:
            l = w.lint(now=dt.datetime(2026, 10, 25, 3, 20))
            rg, wa = issues(l, 'inv-recent-owner'), issues(l, 'inv-written-at')
            if active:
                assert not rg, ('近况读 near.md：laolin 那节留着 09:09', rg)
                assert not wa, ('人物近况是 hhd 现算的：不再核夜里写的 people.md 的写于', wa)
            else:
                assert len(rg) == 1, ('开关没开：照旧读提案里的 midterm/people.md（没有 09:09）', rg)
                assert len(wa) == 1 and wa[0]['file'] == 'memory/midterm/people.md', wa
        finally:
            w.close()


def test_self_voice_checks():
    """这两天的我（11-10 连续感）：原句≥2 且找得到、正文无 BV1 / e0nnn（段末括号行除外）、没有「①」。都只是 warn。"""
    daily = 'memory/' + DAY + '.md'
    note = '- 01:41 今晚连着学了三样怎么讲清楚，结果最后一句话还是老毛病，有点好笑\n- 02:10 英国人那期置顶补齐了，钱从哪来那段回在自己置顶下面\n'
    good = ('<!-- 写于 2026-10-25 03:00 -->\n# 这两天的我\n\n01:41 我写过「今晚连着学了三样怎么讲清楚，结果最后一句话还是老毛病，有点好笑」，'
            '02:10 又写「英国人那期置顶补齐了，钱从哪来那段回在自己置顶下面」。明天一睁眼最想接着弄的是评论区。\n（e0140、BV1JfW86mErg）\n')
    def run(txt):
        w = WS({'memory/midterm/self.md': '# 这两天的我\n', daily: note}, {'memory/midterm/self.md': txt})
        try:
            lint = w.lint()
            return {c: bool(issues(lint, c, 'warn')) for c in ('self-voice-quotes', 'self-voice-ids', 'self-voice-list')} | \
                {'errors': bool([i for i in lint.issues if i['check'].startswith('self-voice') and i['sev'] == 'error'])}
        finally:
            w.close()
    assert run(good) == {'self-voice-quotes': False, 'self-voice-ids': False, 'self-voice-list': False, 'errors': False}, run(good)
    r = run(good.replace('「英国人那期置顶补齐了，钱从哪来那段回在自己置顶下面」', '「我编的一句根本没写过的话」'))
    assert r['self-voice-quotes'] and not r['errors'], r
    assert run(good.replace('明天一睁眼', '这期 BV1JfW86mErg 明天一睁眼'))['self-voice-ids']
    assert run(good.replace('评论区。', '评论区（e0140）。'))['self-voice-ids']
    assert run(good.replace('明天一睁眼最想接着弄的是评论区', '醒来先做：①评论区 ②复盘'))['self-voice-list']


if __name__ == '__main__':
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            n += 1
            print('ok', name)
    print(f'{n} 项全过')
