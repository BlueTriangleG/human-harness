#!/usr/bin/env python3
"""The project board: a row per project (its next step, its last decision, its helpers and what they are doing), then the
helpers that belong to no project.
A project is a directory under <workspace>/projects with a PROPOSAL.md or a PLAN.md (PROPOSAL.md is read when there are
both). Which directories: the module config's boardDirs, globs under projects/ (default "*"); one that starts with ! leaves
that directory out. Its page is read by the names the role writes it with, boardSections: the to-do and decision sections,
and the status line ("<status> <word>") whose word in `ended` marks the project ended.
A helper belongs to a project when it works under the project's directory or its name appears in the project's page.
Usage: python3 scripts/project_board.py          print it
       python3 scripts/project_board.py --write  write it to projects/BOARD-auto.md (a hand-written BOARD.md is left alone)
"""
import glob, os, re, sys

from hh_env import hh, words
import cc

say = words(__file__)
PROJECTS = f'{hh.workspace}/projects'
SECTIONS = {'todo': 'To do', 'decisions': 'Decisions', 'status': 'Status:', 'ended': ['done', 'dropped', 'stopped'], **hh.config.get('boardSections', {})}


def section(text, title):
    m = re.search(rf'^## {re.escape(title)}[^\n]*\n(.*?)(?=^## |\Z)', text, re.S | re.M)
    return m[1] if m else ''


def items(block):
    return [l.strip() for l in block.splitlines() if re.match(r'\s*(-|\d+\.)\s', l)]


def project(path):
    t = open(path, encoding='utf-8').read()
    title = t.splitlines()[0].lstrip('# ').strip()
    todo_block, dec_block = section(t, SECTIONS['todo']), section(t, SECTIONS['decisions'])
    if not todo_block and os.path.basename(path) == 'PLAN.md':
        # a project with only a PLAN.md: its steps are numbered lines with [ ] / [x], its decisions lines like "- MM-DD HH:MM …"
        todo_block = '\n'.join(l for l in t.splitlines() if re.match(r'\s*\d+\.\s*\[', l))
        dec_block = '\n'.join(l for l in t.splitlines() if re.match(r'-\s*\d\d-\d\d', l))
    todo = [x for x in items(todo_block) if '✓' not in x[:6] and not re.match(r'(-|\d+\.)\s*(\[[xX]\]|~~)', x)]
    dec = items(dec_block)
    short = lambda s, n=70: (s[:n] + '…') if len(s) > n else s
    m = re.search(rf'^{re.escape(SECTIONS["status"])}\s*({"|".join(map(re.escape, SECTIONS["ended"]))})[^\n]*', t, re.M)
    return dict(dir=os.path.dirname(path), title=title, text=t, ended=m[0] if m else '',
                next=short(re.sub(r'^(-|\d+\.)\s*', '', todo[0])) if todo else say('boardNoTodo'),
                last=short(re.sub(r'^-\s*', '', dec[-1])) if dec else say('boardNoDecision'))


def main():
    globs = hh.config.get('boardDirs', ['*'])
    dirs = sorted({os.path.dirname(p) for g in globs if not g.startswith('!') for pat in ('PROPOSAL.md', 'PLAN.md') for p in glob.glob(f'{PROJECTS}/{g}/{pat}')}
                  - {f'{PROJECTS}/{g[1:]}' for g in globs if g.startswith('!')})
    projs = [project(f'{d}/PROPOSAL.md' if os.path.exists(f'{d}/PROPOSAL.md') else f'{d}/PLAN.md') for d in dirs]
    hs = cc.sessions()
    theirs = lambda p: [h for h in hs if h['dir'].startswith(p['dir']) or re.search(rf'\b{re.escape(h["name"])}\b', p['text'])]
    used = set()
    lines = [say('boardTitle'), '', say('boardHead'), '|---|---|---|---|']
    ended = [p for p in projs if p['ended']]
    for p in (p for p in projs if not p['ended']):
        mine = theirs(p)
        used |= {h['name'] for h in mine}
        helpers = say('boardSep').join(say('boardHelper', name=h['name'], state=h['label'], ago=h['ago']) for h in mine) or '—'
        lines.append(say('boardRow', title=p['title'], rel=os.path.relpath(p['dir'], PROJECTS), next=p['next'], last=p['last'], helpers=helpers))
    for p in ended:
        used |= {h['name'] for h in theirs(p)}
    loose = [h for h in hs if h['name'] not in used]
    busy = [say('boardBusyLine', name=h['name'], state=h['label'], ago=h['ago'], dir=h['dir']) for h in loose if h['state'] not in ('idle', 'stopped')]
    idle = [h['name'] for h in loose if h['state'] == 'idle']
    if ended:
        lines += ['', say('boardEnded')] + [say('boardEndedLine', rel=os.path.relpath(p['dir'], PROJECTS), status=p['ended']) for p in ended]
    lines += ['', say('boardBusy')] + (busy or [say('boardBusyNone')]) + ['', say('boardIdle', n=len(idle)), say('boardSep').join(idle) or say('boardIdleNone')]
    out = '\n'.join(lines) + '\n'
    if '--write' in sys.argv:
        open(f'{PROJECTS}/BOARD-auto.md', 'w', encoding='utf-8').write(out)
        print(say('boardWrote'))
    else:
        print(out)


if __name__ == '__main__':
    main()
