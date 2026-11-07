import unittest
from datetime import datetime, timezone

from src.backend.session_schedule_rules import ScheduleError, due_range, next_due, normalize_config, preview


def instant(value):
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


def config(rule=None, **kwargs):
    return {'title': 'test', 'prompt': 'check', 'timezone': 'Asia/Shanghai', 'enabled': True,
            'rule': rule or {'kind': 'interval', 'anchor': instant('2026-01-01'), 'seconds': 60}, **kwargs}


class ScheduleRulesTests(unittest.TestCase):
    def test_roundtrip_and_invalid(self):
        now = instant('2026-01-01')
        for rule in ({'kind': 'once', 'at': now + 60}, {'kind': 'daily', 'time': '09:30'},
                     {'kind': 'weekly', 'time': '09:30', 'weekdays': [1, 4]}, config()['rule']):
            normalized = normalize_config(config(rule), now)
            self.assertEqual(normalized, normalize_config(normalized, now))
        for value in (config(prompt=''), config({'kind': 'interval', 'seconds': 59, 'anchor': now}),
                      config({'kind': 'once', 'at': now}), config(timezone='No/Timezone'),
                      config({'kind': 'weekly', 'time': '12:00', 'weekdays': []})):
            with self.assertRaises(ScheduleError):
                normalize_config(value, now)

    def test_dst_gap_and_fold(self):
        now = instant('2026-01-01')
        for value in ('2026-03-08T02:30', '2026-11-01T01:30'):
            with self.assertRaises(ScheduleError):
                normalize_config(config({'kind': 'once', 'at': value}, timezone='America/New_York'), now)
        chosen = normalize_config(config({'kind': 'once', 'at': '2026-11-01T01:30', 'offsetMinutes': -300}, timezone='America/New_York'), now)
        self.assertEqual(chosen['rule']['at'], instant('2026-11-01T06:30'))
        daily = normalize_config(config({'kind': 'daily', 'time': '02:30'}, timezone='America/New_York'), now)
        self.assertEqual(next_due(daily, instant('2026-03-08T00:00')), instant('2026-03-09T06:30'))
        daily['rule']['time'] = '01:30'
        first = next_due(daily, instant('2026-11-01T00:00'))
        self.assertEqual(first, instant('2026-11-01T05:30'))
        self.assertEqual(next_due(daily, first), instant('2026-11-02T06:30'))

    def test_interval_anchor_and_long_gap(self):
        cfg = normalize_config(config(), instant('2025-01-01'))
        first = cfg['rule']['anchor']
        self.assertEqual(next_due(cfg, first + 89), first + 120)
        self.assertEqual(due_range(cfg, first, first + 86400 * 365), (525601, first + 86400 * 365))
        self.assertEqual(next_due(cfg, first - 100), first)

    def test_preview_timezone_and_weekly(self):
        cfg = normalize_config(config({'kind': 'weekly', 'time': '09:00', 'weekdays': [0]}), instant('2026-01-01'))
        result = preview(cfg, instant('2026-01-01'))
        self.assertEqual(result['nextDueAt'], instant('2026-01-05T01:00'))
        self.assertTrue(result['localTime'].endswith('+08:00'))


if __name__ == '__main__':
    unittest.main()
