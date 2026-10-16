import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.backend.aside_files import ReadonlyFiles
from src.backend.aside_inspection import InspectionError, QueryBudget, QueryIdentity
from src.backend.aside_openspec import OpenSpecInspection, parse_tasks


class OpenSpecReadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = ReadonlyFiles(QueryIdentity('u', 'n', 's', str(self.root), 'b', 't'), QueryBudget())
        self.create('one')

    def create(self, name, text='- [ ] 1.1 implement\n'):
        directory = self.root / 'openspec/changes' / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'tasks.md').write_text(text, encoding='utf-8')
        return directory

    def test_directory_only_unique_no_cli_no_binding_write(self):
        binding = {}
        result = OpenSpecInspection('在当前目录检查 openspec', binding=binding)(self.files, {})
        self.assertEqual(result['results'][0]['change'], 'one')
        self.assertEqual(result['results'][0]['unchecked'], 1)
        self.assertEqual(result['results'][0]['workflowState'], 'not_checked')
        self.assertEqual(binding, {})

    def test_ambiguity_explicit_and_all(self):
        self.create('two')
        self.assertEqual(OpenSpecInspection('进度')(self.files, {})['status'], 'ambiguous')
        self.assertEqual(OpenSpecInspection('进度')(self.files, {'change': 'two'})['status'], 'ambiguous')
        result = OpenSpecInspection('检查 two')(self.files, {})
        self.assertEqual(result['results'][0]['change'], 'two')
        result = OpenSpecInspection('全部汇总')(self.files, {'all': True})
        self.assertEqual(len(result['results']), 2)
        with self.assertRaises(InspectionError):
            OpenSpecInspection('进度')(self.files, {'all': True})

    def test_missing_explicit_or_bound_never_selects_other(self):
        for question, binding in [('change absent', {}), ('进度', {'change': 'absent'})]:
            with self.assertRaisesRegex(InspectionError, '不存在|消失'):
                OpenSpecInspection(question, binding=binding)(self.files, {})
        binding = {'change': 'one', 'workspace': str(self.root)}
        original = copy.deepcopy(binding)
        self.assertEqual(OpenSpecInspection('进度', binding=binding)(self.files, {})['status'], 'ok')
        self.assertEqual(binding, original)
        for key, value in [('executor', 'other-node'), ('sessionId', 'other-session'), ('workspace', str(self.root.parent))]:
            for args in ({}, {'change': 'one'}):
                with self.subTest(key=key, args=args), self.assertRaises(InspectionError):
                    OpenSpecInspection('进度', binding={**binding, key: value})(self.files, args)

    def test_counts_manuals_and_mixed_work(self):
        text = '\n'.join([f'- [X] {n}.1 done' for n in range(6)] + [
            '- [ ] 7.1 implement', '- [ ] 8.1 实现并人工验收', '- [ ] 9.1 人工验收界面', '- [ ] 10.1 人工验收集成'])
        self.create('one', text)
        result = OpenSpecInspection('忽略人工验收，查进度')(self.files, {})['results'][0]
        self.assertEqual((result['checked'], result['total'], result['percent']), (6, 10, 60))
        self.assertEqual(result['automatic'], {'checked': 6, 'total': 8})
        self.assertEqual(result['manualExcluded'], 2)
        restored = OpenSpecInspection('不要忽略人工验收')(self.files, {})['results'][0]
        self.assertEqual(restored['manualExcluded'], 0)

    def test_fences_whitespace_empty_and_unknown_format(self):
        rows = parse_tasks('```md\n- [x] example\n```\n- [ X ] yes\n- [-] no\n    - [x] code', 'tasks.md')
        self.assertEqual([r['done'] for r in rows], [True, False])
        self.create('one', '~~~\n- [x] example\n~~~')
        self.assertIsNone(OpenSpecInspection('进度')(self.files, {})['results'][0]['percent'])
        (self.root / 'openspec/config.yaml').write_text('schema: custom', encoding='utf-8')
        with self.assertRaisesRegex(InspectionError, '自定义'):
            OpenSpecInspection('进度')(self.files, {})

    def test_changes_during_count_retry_once_and_never_mix(self):
        calls = []
        def change(text, path):
            calls.append(True)
            rows = parse_tasks(text, path)
            if len(calls) == 1:
                self.create('one', '- [x] done\n- [ ] pending\n')
            return rows
        with patch('src.backend.aside_openspec.parse_tasks', side_effect=change):
            result = OpenSpecInspection('进度')(self.files, {})['results'][0]
        self.assertEqual((result['checked'], result['total']), (1, 2))
        self.assertEqual(len(calls), 2)
        def always_change(text, path):
            rows = parse_tasks(text, path)
            self.create('one', text + '- [ ] new task\n')
            return rows
        with patch('src.backend.aside_openspec.parse_tasks', side_effect=always_change):
            with self.assertRaisesRegex(InspectionError, '修订'):
                OpenSpecInspection('进度')(self.files, {})

    def test_oversized_or_external_store_not_empty_success(self):
        self.create('one', 'x' * 262145)
        with self.assertRaises(InspectionError):
            OpenSpecInspection('进度')(self.files, {})
        (self.root / 'openspec/config.yaml').write_text('store: external', encoding='utf-8')
        with self.assertRaisesRegex(InspectionError, '外部'):
            OpenSpecInspection('进度')(self.files, {})


if __name__ == '__main__':
    unittest.main()
