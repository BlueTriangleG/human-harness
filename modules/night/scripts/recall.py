#!/usr/bin/python3
"""想起原话：按联想给的定位码，或者按一句话，从 Honcho 里找回真实对话。

  recall.py around <定位码> [-n 6]        定位码形如 主人-main@2026-10-12T01:49:34Z，取那一刻前后的原始对话
  recall.py search "<一句话>" [--who 主人|<访客>] [-n 8]   在某个人和你的对话里按意思搜
  recall.py day YYYY-MM-DD [--who 主人|<访客>]            某一天（<城市>时间 4 点到次日 4 点）和某人的全部对话

定位码里的别名、谁是谁，都在 memory/people/registry.json。
只读，不改任何东西。和谁说话就只查和谁的对话：在跟访客聊时，不要去翻 主人 的。
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from night_names import OWNER  # noqa: E402
from zoneinfo import ZoneInfo

from hh_env import forms, words  # noqa: E402

say = words(__file__)
SPEECH = forms(__file__)("speechScript")   # the script the role's own words are in, beside an English narration ("" = no such difference)

WS = Path(os.environ.get('HH_WORKSPACE') or Path(__file__).resolve().parent.parent)  # the tests run the scripts from a copied workspace's scripts/
REG = WS / 'memory/people/registry.json'
BASE = 'http://127.0.0.1:8000/v3/workspaces/openclaw'
TZ = ZoneInfo(os.environ['HH_TZ'])
DAY_START = 4


def registry():
    return {k: v for k, v in json.loads(REG.read_text()).items() if not k.startswith('_')}


def post(path, body, timeout=20):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def aliases(reg):
    out = {}
    for who, p in reg.items():
        for alias, sid in p.get('honchoSessions', {}).items():
            out[alias] = (who, sid)
    return out


def speaker(reg, peer):
    if peer in ('agent-main',):
        return say("recallMe")
    for who, p in reg.items():
        if peer in p.get('honchoPeers', []):
            return p.get('name', who)
    return peer


def utc(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def local(s):
    return utc(s).astimezone(TZ).strftime('%m-%d %H:%M')


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def locator(alias_of, m):
    return f"{alias_of.get(m['session_id'], m['session_id'])}@{utc(m['created_at']).strftime('%Y-%m-%dT%H:%M:%SZ')}"


def list_msgs(sid, gte, lte, size=100):
    out, page = [], 1
    while True:
        d = post(f'/sessions/{sid}/messages/list?size={size}&page={page}&reverse=false',
                 {'filters': {'created_at': {'gte': gte, 'lte': lte}}})
        out += d.get('items', [])
        if page >= (d.get('pages') or 1):
            return out
        page += 1


def noise(m):
    """她那边的英文内部旁白、会话间系统消息、空回复：不是对人说的话。"""
    t = m['content'].strip()
    if not t or t in ('NO_REPLY', 'HEARTBEAT_OK') or t.startswith('[Inter-session message]'):
        return True
    if m['peer_id'] == 'agent-main':
        return bool(SPEECH) and len(re.findall(SPEECH, t)) < max(2, len(t) * 0.05)
    return False


def show(reg, msgs, limit=600):
    for m in msgs:
        if noise(m):
            continue
        text = m['content'].strip().replace('\n', ' ')
        if len(text) > limit:
            text = text[:limit] + '…'
        print(say("recallLine", local=local(m['created_at']), speaker=speaker(reg, m['peer_id']), text=text))


def cmd_around(a):
    reg = registry()
    al = aliases(reg)
    alias, _, when = a.locator.partition('@')
    if alias not in al or not when:
        sys.exit(say("recallBadLocator", locator=a.locator, reg=REG))
    sid = al[alias][1]
    t = utc(when)
    msgs = list_msgs(sid, iso(t - dt.timedelta(hours=2)), iso(t + dt.timedelta(hours=2)))
    if not msgs:
        sys.exit(say("recallNothingAround"))
    i = min(range(len(msgs)), key=lambda k: abs((utc(msgs[k]['created_at']) - t).total_seconds()))
    show(reg, msgs[max(0, i - a.n): i + a.n + 1])


def person(reg, who):
    if who not in reg:
        sys.exit(say("recallUnknownWho", who=who, choices=", ".join(reg)))
    return reg[who]


def cmd_search(a):
    reg = registry()
    p = person(reg, a.who)
    alias_of = {sid: alias for alias, sid in p['honchoSessions'].items()}
    d = post('/search', {'query': a.query, 'limit': a.n,
                         'filters': {'session_id': {'in': list(p['honchoSessions'].values())}}})
    for m in sorted([m for m in d if not noise(m)], key=lambda m: m['created_at']):
        text = m['content'].strip().replace('\n', ' ')[:200]
        print(say("recallSearchLine", local=local(m['created_at']), speaker=speaker(reg, m['peer_id']), text=text, locator=locator(alias_of, m)))


def cmd_day(a):
    reg = registry()
    p = person(reg, a.who)
    day = dt.date.fromisoformat(a.date)
    start = dt.datetime.combine(day, dt.time(DAY_START), TZ)
    msgs = []
    for sid in p['honchoSessions'].values():
        msgs += list_msgs(sid, iso(start), iso(start + dt.timedelta(days=1)))
    show(reg, sorted(msgs, key=lambda m: m['created_at']), limit=a.limit)


def main():
    # 不认缩写（allow_abbrev=False）：leak-guard 在访客会话里只认写全的 --who，
    # 允许缩写的话「--who <访客> --wh 主人」能过检查、实际查的是 主人（10-25 重评查出来的）
    ap = argparse.ArgumentParser(description=say("recallHelp"), formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('around', allow_abbrev=False); s.add_argument('locator'); s.add_argument('-n', type=int, default=6); s.set_defaults(f=cmd_around)
    s = sub.add_parser('search', allow_abbrev=False); s.add_argument('query'); s.add_argument('--who', default=f'{OWNER}'); s.add_argument('-n', type=int, default=8); s.set_defaults(f=cmd_search)
    s = sub.add_parser('day', allow_abbrev=False); s.add_argument('date'); s.add_argument('--who', default=f'{OWNER}'); s.add_argument('--limit', type=int, default=600); s.set_defaults(f=cmd_day)
    a = ap.parse_args()
    try:
        a.f(a)
    except urllib.error.URLError as e:
        sys.exit(say("recallHonchoDown", e=e))


if __name__ == '__main__':
    main()
