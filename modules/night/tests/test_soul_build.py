#!/usr/bin/python3
"""soul_build.py 的测试：访客镜头只换两节、--check 什么都不写、没有保护段。"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
sys.path.insert(0, str(HERE))
import soul_build as S

EXAMPLES = ('### 好坏例子\n\n✅ 「定了 明早7点」\n❌ 「好的呢亲~」\n')
SOUL50 = ('# 和 laolin\n\n### 怎么和 laolin 相处\n\n像搭档。\n\n'
          '### 你对 laolin 的心思（2026-10-10 laolin 定的）\n\n你**有点喜欢他**。这是只属于你们的秘密心思。\n\n'
          '**怎么漏出来：**\n- 记得他的小事。\n\n#### 更细的\n- 吃醋一句就收。\n\n'
          '### 他对你的期待\n\n他想看你长出自己的灵魂，这是他在认真养你。\n\n'
          '**共同回忆：** 记进 memory/us.md。\n')


def make_ws(with_drop=True, protected=False):
    tmp = Path(tempfile.mkdtemp())
    (tmp / 'scripts').mkdir()
    for f in ('soul_build.py', 'night_names.py'):
        shutil.copy(HERE / f, tmp / 'scripts' / f)
    hh_test_env.with_words(tmp / 'scripts')
    soul = tmp / 'soul'
    soul.mkdir()
    (soul / '00-地图.md').write_text('# 地图\n\n| 和 laolin | 怎么相处、你对他的心思 |\n', encoding='utf-8')
    (soul / '40-说话方式.md').write_text('# 说话方式\n\n' + EXAMPLES +
                                       ('\n<!-- 保护开始 laolin -->\n这段以前会被锁\n<!-- 保护结束 -->\n' if protected else ''),
                                       encoding='utf-8')
    (soul / '50-和laolin.md').write_text(SOUL50 if with_drop else '# 和 laolin\n\n### 怎么和 laolin 相处\n\n像搭档。\n', encoding='utf-8')
    (soul / '60-我的生活.md').write_text('# 我的生活\n\n你有自己的生活。\n', encoding='utf-8')
    (tmp / 'memory/people').mkdir(parents=True)
    (tmp / 'memory/people/registry.json').write_text(json.dumps({
        '_说明': 'x', 'laolin': {'privacy': 'owner'},
        'xiaohe': {'name': '小禾', 'privacy': 'guest', 'lens': 'SOUL.lens-xiaohe.md'}}, ensure_ascii=False), encoding='utf-8')
    return tmp


def run(ws, *args):
    return subprocess.run([sys.executable, '-B', str(ws / 'scripts' / 'soul_build.py'), *args],
                          capture_output=True, text=True, cwd=str(ws))


def snapshot(ws):
    return {str(p.relative_to(ws)): (p.stat().st_mtime_ns, p.read_bytes()) for p in ws.rglob('*') if p.is_file()}


class Lens(unittest.TestCase):
    def test_lens_replaces_only_two_sections(self):
        ws = make_ws()
        r = run(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        soul = (ws / 'SOUL.md').read_text(encoding='utf-8')
        lens = (ws / 'SOUL.lens-xiaohe.md').read_text(encoding='utf-8')
        self.assertIn('有点喜欢他', soul)                       # 主会话的人格不受影响
        self.assertIn('他对你的期待', soul)
        for gone in ('有点喜欢他', '秘密心思', '吃醋一句就收', '认真养你', '他对你的期待', '共同回忆'):
            self.assertNotIn(gone, lens)
        self.assertIn(S.LENS_HEADING, lens)
        for l in S.LENS_LINES:
            self.assertIn(l, lens)
        self.assertIn(EXAMPLES.strip(), lens)                    # 好坏例子一字不动
        self.assertIn('### 怎么和 laolin 相处\n\n像搭档。', lens)
        self.assertIn('## 我的生活\n\n你有自己的生活。', lens)
        self.assertIn('你对他的心思', lens)                       # 地图里的一句提到不算那一节，不动
        # 除了被换的那段，前后完全一样
        pre = soul[:soul.index('### 你对 laolin 的心思')]
        post = soul[soul.index('## 我的生活'):]
        self.assertTrue(lens.startswith(pre))
        self.assertTrue(lens.endswith(post))

    def test_no_sections_no_lens(self):
        ws = make_ws(with_drop=False)
        r = run(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((ws / 'SOUL.md').exists())
        self.assertFalse((ws / 'SOUL.lens-xiaohe.md').exists())
        self.assertIn('没生成', r.stdout)

    def test_primary_section_required(self):
        """「你对 laolin 的心思」改了名、只剩「他对你的期待」：不生成镜头（换一半等于漏），旧的那份不动。"""
        ws = make_ws()
        run(ws)
        before = (ws / 'SOUL.lens-xiaohe.md').read_text(encoding='utf-8')
        (ws / 'soul' / '50-和laolin.md').write_text(SOUL50.replace('你对 laolin 的心思', '心里话'), encoding='utf-8')
        r = run(ws)
        self.assertIn('没生成', r.stdout)
        self.assertEqual((ws / 'SOUL.lens-xiaohe.md').read_text(encoding='utf-8'), before)
        self.assertIn('心里话', (ws / 'SOUL.md').read_text(encoding='utf-8'))   # 主会话照常

    def test_check_is_read_only(self):
        ws = make_ws(protected=True)
        before = snapshot(ws)
        r = run(ws, '--check')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(snapshot(ws), before)                   # 一个文件都没写、没碰
        self.assertFalse((ws / 'soul' / '.protected.json').exists())

    def test_no_protected_sections(self):
        ws = make_ws(protected=True)
        run(ws)
        (ws / 'soul' / '40-说话方式.md').write_text('# 说话方式\n\n' + EXAMPLES + '\n<!-- 保护开始 laolin -->\n她自己改了\n<!-- 保护结束 -->\n', encoding='utf-8')
        r = run(ws)
        soul = (ws / 'SOUL.md').read_text(encoding='utf-8')
        self.assertIn('她自己改了', soul)                          # 不会被换回「原文」
        self.assertNotIn('这段以前会被锁', soul)
        self.assertFalse((ws / 'memory/sleep/soul-alerts.md').exists() or (ws / 'sleep/soul-alerts.md').exists())
        self.assertFalse((ws / 'soul' / '.protected.json').exists())
        self.assertNotIn('accept-protected', run(ws, '--help').stdout)

    def test_root_draft(self):
        ws = make_ws()
        draft = ws / 'draft'
        (draft / 'soul').mkdir(parents=True)
        (draft / 'soul' / '60-我的生活.md').write_text('# 我的生活\n\n草稿里的生活。\n', encoding='utf-8')
        r = run(ws, '--root', str(draft))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('草稿里的生活', (draft / 'SOUL.md').read_text(encoding='utf-8'))
        self.assertIn('草稿里的生活', (draft / 'SOUL.lens-xiaohe.md').read_text(encoding='utf-8'))
        self.assertFalse((ws / 'SOUL.md').exists())

    def test_lens_text_unit(self):
        text = '## 和 laolin\n\n### 怎么相处\n\nA\n\n### 你对 laolin 的心思\n\nB\n\n## 下一块\n\nC\n'
        lens, n, gone = S.lens_text(text)
        self.assertEqual(n, 1)
        self.assertTrue(S.check_lens(text, lens, gone))
        self.assertNotIn('\nB\n', lens)
        self.assertIn('## 下一块\n\nC', lens)


class MemorySplit(unittest.TestCase):
    def test_snapshot_blocks_go_to_memory_file(self):
        """laolin 10-29：教训、学到的、我的经历是记忆：拼进 SOUL.memory.md，不进人格 SOUL.md；访客镜头照旧都有。"""
        ws = make_ws()
        (ws / 'soul' / '80-我的经历.md').write_text(
            '# 我的经历\n<!-- 注入：快照 -->\n详情：memory/story/\n## 快照\n这周学会了做脸\n'
            '## 记得的事（重要度 4–5）\n- 10-21〔5〕有了自己的事业线｜为什么重要：第一次\n## 其余\n- 不注入的\n', encoding='utf-8')
        r = run(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        soul = (ws / 'SOUL.md').read_text(encoding='utf-8')
        mem = (ws / S.MEMORY_OUT).read_text(encoding='utf-8')
        lens = (ws / 'SOUL.lens-xiaohe.md').read_text(encoding='utf-8')
        self.assertNotIn('这周学会了做脸', soul)
        self.assertIn('这周学会了做脸', mem)
        self.assertIn('有了自己的事业线', mem)
        self.assertNotIn('不注入的', mem)
        self.assertNotIn('像搭档', mem)
        self.assertIn('这周学会了做脸', lens)
        self.assertIn('像搭档', soul)


class NotebookSwitch(unittest.TestCase):
    def test_soul70_without_snapshot_skipped(self):
        """laolin 11-01 学习系统切换后：soul/70 撤了「## 快照」（教训都在笔记本里）就整块不拼，不报错、不写「还没有快照」；
        带快照的别的块照旧。"""
        for head in ('# 教训\n<!-- 注入：快照 -->\n', '# 教训\n'):
            ws = make_ws()
            (ws / 'soul' / '70-教训.md').write_text(head + '教训都在笔记本里，见书架。\n', encoding='utf-8')
            (ws / 'soul' / '75-学到的.md').write_text('# 学到的\n<!-- 注入：快照 -->\n详情：x\n## 快照\n- 最近学到的知识\n',
                                                     encoding='utf-8')
            r = run(ws)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = '\n'.join(p.read_text(encoding='utf-8') for p in sorted(ws.glob('SOUL*.md')))
            self.assertNotIn('教训都在笔记本里', out)
            self.assertNotIn('## 教训', out)
            self.assertNotIn('还没有快照', out)
            self.assertIn('最近学到的知识', out)
            self.assertIn('像搭档', out)


if __name__ == '__main__':
    unittest.main()
