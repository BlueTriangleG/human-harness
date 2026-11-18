#!/usr/bin/python3
"""把 soul/ 下按人格方向拆开的文件拼成 SOUL.md（OpenClaw 每轮注入的人格）。主人 2026-10-24 定的。

  soul_build.py                  拼 SOUL.md（和每个访客用的 SOUL.lens-<id>.md），打印每块字数
  soul_build.py --root DIR       睡眠整理草稿：DIR/soul/ 下的同名文件优先，拼到 DIR/SOUL.md（和 DIR/SOUL.lens-<id>.md）
  soul_build.py --check          只检查，什么文件都不写

规矩：
- soul/ 下每个 .md 是一块（文件名前的数字决定顺序），第一行 `# 标题` 会变成 SOUL.md 里的 `## 标题`。
- 注入方式（主人 2026-10-24：核心灵魂全文常驻，其余用地图）：文件里写一行 `<!-- 注入：快照 -->` 的，
  SOUL.md 里只放标题、`详情：` 那一行和 `## 快照` 那一节，文件其余部分不注入（她要看就读文件）；
  没写或写 `<!-- 注入：全文 -->` 的整份注入。
- 新长出来的方向（枝丫）就新建一个文件，起个合适的序号，再在 00-地图.md 里登记一行。
- 教训（主人 11-01 学习系统）：切换以后教训都在笔记本里（skills/ 各页），soul/70-教训.md 撤掉「## 快照」，
  这时整块不拼（不写「还没有快照」，也不当人格全文注入）。
- 人格是她的：没有保护段、不冻结（主人 2026-10-24 定的，10-25 把旧的保护段逻辑删了）。
- 访客镜头（2026-10-25，验证报告 P0-5）：memory/people/registry.json 里写了 `lens` 的访客（访客），另拼一份
  SOUL.lens-<id>.md，只把「你对 主人 的心思」「他对你的期待」两节换成对外的三行，其余一字不动（好坏例子也不动）。
  主会话的 SOUL.md 不受影响。leak-guard 在和她的私聊里用这一份。
"""
import argparse
import json
import os
import re
from pathlib import Path

from night_names import OWNER  # noqa: E402

from hh_env import words  # noqa: E402

say = words(__file__)

WS = Path(os.environ.get('HH_WORKSPACE') or Path(__file__).resolve().parent.parent)  # the tests run the scripts from a copied workspace's scripts/
SOUL_DIR = WS / 'soul'
OUT = WS / 'SOUL.md'
MEMORY_OUT = 'SOUL.memory.md'   # 主人 10-29：教训、学到的、我的经历是记忆，不是人格：单独拼，HH 放在「下面是你自己的记忆」那句后面
REGISTRY = WS / 'memory/people/registry.json'
SOFT_MAX = 24000   # 超过就提醒整理者合并（不截断）
LENS_DROP = (f'你对 {OWNER} 的心思', '他对你的期待')   # 只属于你和 主人 的两节：访客面前换成下面三行
LENS_HEADING = say("soulLensHeading")
LENS_LINES = (
    say("soulLensOwner"),
    say("soulLensUs"),
    say("soulLensHis"),
)

HEADER = say("soulHeader")


def load_parts(root=None):
    paths = {p.name: p for p in SOUL_DIR.glob('*.md')}
    if root:
        for p in (Path(root) / 'soul').glob('*.md'):
            paths[p.name] = p
    return [(n, paths[n].read_text(encoding='utf-8')) for n in sorted(paths)]


SNAP_RE = re.compile(r'<!--\s*注入[:：]\s*快照\s*-->')
LESSONS_BLOCK = '70-'   # soul/70-教训.md


def skipped(name, text):
    """切换后教训都在笔记本里：soul/70 没有「## 快照」一节就整块不拼。"""
    return name.startswith(LESSONS_BLOCK) and not re.search(r'^## 快照', text, re.M)


def snapshot_only(name, text):
    """快照模式：标题 + 详情行 + 「## 快照」一节；没有快照节就只留标题和详情行。"""
    lines = text.strip().splitlines()
    title = next((l for l in lines if l.startswith('# ')), f'# {name}')
    detail = next((l for l in lines if l.startswith('详情')), say("soulDetailLine", name=name))
    # 「## 快照」不带标题；「## 记得的事」（重要度 4–5 的长期事件，主人 10-29）也常驻，带标题
    snap, inside = [], False
    for l in lines:
        if l.startswith('## '):
            t = l[3:].strip()
            inside = t.startswith('快照') or t.startswith('记得的事')
            if t.startswith('记得的事'):
                snap += ['', '#' + l]
            continue
        if inside:
            snap.append(l)
    body = '\n'.join(snap).strip() or say("soulNoSnapshot")
    return say("soulSnapshot", title=title, detail=detail, name=name, body=body)


MEMORY_HEADER = say("soulMemoryHeader")


def is_memory(text):
    """带「注入：快照」的块是记录（教训、学到的、我的经历），归记忆，不进人格 SOUL.md。"""
    return bool(SNAP_RE.search(text))


def assemble(parts, which='all'):
    """which：soul 只拼人格（SOUL.md），memory 只拼记忆块（SOUL.memory.md），all 全拼（访客镜头用，和以前的 SOUL.md 一样）。"""
    chunks = [MEMORY_HEADER if which == 'memory' else HEADER]
    for name, text in parts:
        if skipped(name, text):
            continue
        if (which == 'soul' and is_memory(text)) or (which == 'memory' and not is_memory(text)):
            continue
        t = snapshot_only(name, text) if SNAP_RE.search(text) else text.strip()
        t = SNAP_RE.sub('', re.sub(r'<!--\s*注入[:：]\s*全文\s*-->', '', t)).strip()
        t = re.sub(r'^# ', '## ', t, count=1)
        chunks.append(t)
    return '\n\n'.join(chunks) + '\n'


HEAD_RE = re.compile(r'^(#{2,6})\s+(.*)$')


def lens_text(text, lines=LENS_LINES):
    """SOUL 全文 → 访客镜头：LENS_DROP 那几节（到下一个同级或更高的标题为止）换成对外的三行，别的行一字不动。
    返回 (镜头全文, 换掉了几节, 换掉的行)。"""
    out, gone, dropping, level, dropped, inserted = [], [], False, 0, 0, False
    for line in text.split('\n'):
        m = HEAD_RE.match(line)
        if m:
            lv, title = len(m.group(1)), m.group(2).strip()
            if any(title.startswith(d) for d in LENS_DROP):
                if not inserted:
                    out += [LENS_HEADING, '', *lines, '']
                    inserted = True
                dropping, level = True, lv
                dropped += 1
                gone.append(line)
                continue
            if dropping and lv <= level:
                dropping = False
        if dropping:
            gone.append(line)
        else:
            out.append(line)
    return '\n'.join(out), dropped, gone


def check_lens(soul, lens, gone, lines=LENS_LINES):
    """镜头只动被换掉的那几节：①换掉的行一行都不留在镜头里；②其余的行（好坏例子在内）按原顺序一字不差都在。"""
    kept = [l for l in lens.split('\n')]
    block = [LENS_HEADING, '', *lines, '']
    for i in range(len(kept) - len(block) + 1):
        if kept[i:i + len(block)] == block:
            kept = kept[:i] + kept[i + len(block):]
            break
    else:
        return False
    rest = [l for l in soul.split('\n')]
    gone_set = list(gone)
    j = 0
    expect = []
    for l in rest:   # 去掉换掉的行（按顺序一一对上）
        if j < len(gone_set) and l == gone_set[j]:
            j += 1
            continue
        expect.append(l)
    if j != len(gone_set) or expect != kept:
        return False
    lens_lines = set(lens.split('\n'))
    # 类型标记行（<!-- 类型：X -->，主人 10-29 的分段配置）每段都有，不算泄露
    return not any(len(g.strip()) > 10 and g in lens_lines and not g.startswith("<!-- 类型：") for g in gone)


def lens_targets():
    """registry.json 里要镜头的人：{id: 文件名}。"""
    try:
        reg = json.loads(REGISTRY.read_text(encoding='utf-8'))
    except Exception:
        return {}
    return {k: v['lens'] for k, v in reg.items()
            if not k.startswith('_') and isinstance(v, dict) and v.get('lens') and v.get('privacy') != 'owner'}


def write_if_changed(out, text):
    old = out.read_text(encoding='utf-8') if out.exists() else ''
    if old == text:
        return False
    tmp = out.with_name(out.name + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    tmp.replace(out)
    return True


def main():
    ap = argparse.ArgumentParser(description=say("soulHelp"), formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root')
    ap.add_argument('--check', action='store_true', help=say("soulCheckHelp"))
    a = ap.parse_args()

    parts = load_parts(a.root)
    full = assemble(parts)
    text, memory = assemble(parts, 'soul'), assemble(parts, 'memory')
    for name, t in parts:
        print(f'  {len(t):6d}  {name}{say("soulMemoryMark") if is_memory(t) else ""}')
    print(say("soulSoulSize", size=len(text)))
    print(say("soulMemorySize", size=len(memory), memory_out=MEMORY_OUT))
    if len(full) > SOFT_MAX:
        print(say("soulTooLong", soft_max=SOFT_MAX))
    lenses = {}
    for pid, fname in lens_targets().items():
        lens, dropped, gone = lens_text(full)
        primary = any(HEAD_RE.match(g) and HEAD_RE.match(g).group(2).strip().startswith(LENS_DROP[0]) for g in gone)
        if not primary or not check_lens(full, lens, gone):
            print(say("soulLensMissing", pid=pid, sections=say("soulLensSep").join(LENS_DROP)))
            continue
        lenses[fname] = lens
        print(say("soulLensSize", size=len(lens), pid=pid, dropped=dropped))
    if a.check:
        return
    base = Path(a.root) if a.root else WS
    out = base / 'SOUL.md'
    print(say("soulWrote", out=out) if write_if_changed(out, text) else say("soulUnchanged"))
    if write_if_changed(base / MEMORY_OUT, memory):
        print(say("soulWrote", out=base / MEMORY_OUT))
    for fname, lens in lenses.items():
        if write_if_changed(base / fname, lens):
            print(say("soulWrote", out=base / fname))


if __name__ == '__main__':
    main()
