"""材料第 9 节：今天的报错和卡住的地方（HH 日志、修理记录、核对）。"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / 'scripts'   # the scripts (these tests used to sit beside them)
import hh_test_env  # noqa: E402,F401  (the module environment for a made-up role; the scripts on sys.path)
sys.path.insert(0, str(HERE))
import sleep_digest as S  # noqa: E402

DAY = dt.date(2026, 11, 1)   # 她的一天：11-01 04:00 到 11-02 04:00（河边镇，UTC+11）


def row(t, level, msg, **kw):
    return json.dumps({'t': t, 'level': level, 'mod': 'hhd', 'msg': msg, **kw}, ensure_ascii=False)


class TestRepairSection(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / 'hh.jsonl'
        self.rep = self.tmp / 'log.jsonl'

    def test_groups_warnings_of_the_day(self):
        self.log.write_text('\n'.join([
            row('2026-11-01T01:00:00.000Z', 'warn', 'turn failed', region='main', error='boom one'),
            row('2026-11-01T02:00:00.000Z', 'warn', 'turn failed', region='side-1', error='boom two'),
            row('2026-10-30T02:00:00.000Z', 'warn', 'turn failed', error='another day'),
            row('2026-11-01T03:00:00.000Z', 'info', 'turn end', ok=True),
            row('2026-11-01T04:00:00.000Z', 'info', 'hhd up', pid=1),
        ]) + '\n')
        out = S.repair_section(DAY, self.log, self.rep, None)
        self.assertIn('turn failed', out)
        self.assertIn('2 次', out)
        self.assertIn('boom one', out)
        self.assertNotIn('another day', out)
        self.assertNotIn('turn end', out)
        self.assertIn('hhd 起了 1 次', out)

    def test_repair_events_and_audit_appear(self):
        self.log.write_text('')
        self.rep.write_text(json.dumps({'t': '2026-11-01T05:00:00.000Z', 'kind': 'rollback', 'by': 'watchdog', 'text': '退回了部署 a → b：重启后 3 分钟没起来'}, ensure_ascii=False) + '\n')
        audit = json.dumps({'deployed': 'abc', 'live': [{'path': 'src/brain.ts', 'how': 'changed'}], 'sensitive': [], 'note': ''})
        out = S.repair_section(DAY, self.log, self.rep, audit)
        self.assertIn('退回了部署', out)
        self.assertIn('本地改了 1 个文件（和 HEAD abc 比）：src/brain.ts（changed）', out)
        self.assertNotIn('都算毛病', out, 'her own edits are not listed as faults')

    def test_app_faults_are_faults(self):
        self.log.write_text(''); self.rep.write_text('')
        audit = json.dumps({'deployed': 'abc', 'live': [], 'sensitive': [], 'note': '', 'app': ['signer'], 'appNote': '阿青的 app（ai.hh.role.t）不对：签名不是阿青自己的证书'}, ensure_ascii=False)
        out = S.repair_section(DAY, self.log, self.rep, audit)
        self.assertIn('都算毛病', out)
        self.assertIn('- 阿青的 app（ai.hh.role.t）不对：签名不是阿青自己的证书', out)

    def test_empty(self):
        self.assertEqual(S.repair_section(DAY, self.tmp / 'nope.jsonl', self.tmp / 'nope2.jsonl', None), '（今天没有报错和修理记录）')


if __name__ == '__main__':
    unittest.main()
