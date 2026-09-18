import asyncio
import json
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.backend.bridge_ws import BridgeWS
from src.backend.skill_groups import SkillGroups
from src.backend.skill_manuals import SkillManuals, skill_references
from src.backend.skill_store import SkillStore


class SkillGroupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / 'library'
        for key, value in {'LIBRARY_DIR': self.root, 'INDEX_FILE': self.root / 'index.json',
                           'SECRETS_DIR': Path(temp.name) / 'secrets'}.items():
            p = patch('src.backend.skill_store.' + key, value)
            p.start()
            self.addCleanup(p.stop)
        self.store = SkillStore()
        for name in ('draft', 'apply', 'verify', 'archive'):
            self.install(name)
        self.install('single', 'different/OneSkill')
        self.group = next(g for g in self.store.groups().list() if g['repository'] == 'example/OpenSpec')

    def install(self, name, repository='example/OpenSpec'):
        return self.store.install_standard_files({
            'SKILL.md': f'---\nname: {name}\ndescription: {name} workflow\n---\nInstructions {name}'.encode(),
            'README.md': f'# {name} guide\nEvidence for {name}'.encode(),
        }, source={'kind': 'github', 'repository': repository, 'ref': 'main', 'path': f'skills/{name}'})

    def test_repository_grouping_is_metadata_only_and_single_repo_also_has_parent(self):
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        with patch.object(SkillManuals, '_read', side_effect=AssertionError('must not read manuals')):
            groups = self.store.groups().list()
            self.assertEqual(len(groups), 2)
            self.assertEqual(set(self.group['children']), {'draft', 'apply', 'verify', 'archive'})
            self.assertEqual(next(g for g in groups if g['name'] == 'OneSkill')['children'], ['single'])
            refs = self.store.manuals().list(grouped=True)
            self.assertEqual(len(refs), 2)
            self.assertTrue(all(entry['kind'] == 'parent' for entry in refs))
        self.assertEqual(before, sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')))

    def test_rename_is_persistent_stable_and_conflict_checked(self):
        before = self.store.get_skill('apply')
        renamed = self.store.groups().rename(self.group['id'], '项目规范 工作流', self.group['revision'])
        self.assertEqual(renamed['id'], self.group['id'])
        self.assertEqual(SkillStore().groups().resolve('项目规范 工作流')['id'], self.group['id'])
        self.assertEqual(self.store.get_skill('apply'), before)
        with self.assertRaisesRegex(ValueError, 'SKILL_PARENT_CHANGED'):
            self.store.groups().rename(self.group['id'], 'stale', self.group['revision'])
        with self.assertRaises(ValueError):
            self.store.groups().rename(self.group['id'], 'single', renamed['revision'])
        with self.assertRaises(ValueError):
            self.store.groups().rename(self.group['id'], 'repo.' + '0' * 16, renamed['revision'])
        self.install('extra')
        self.assertEqual(self.store.groups().resolve('项目规范 工作流')['id'], self.group['id'])
        self.assertEqual(len(self.store.groups().resolve(self.group['id'])['children']), 5)

    def test_parent_default_preserves_child_controls_and_new_installs_are_not_auto_enabled(self):
        self.store.set_group_default(self.group['id'], True)
        self.assertEqual(set(self.store.list_default_names()), set(self.group['children']))
        self.store.set_default('apply', False)
        self.install('new-member')
        self.assertNotIn('apply', self.store.list_default_names())
        self.assertNotIn('new-member', self.store.list_default_names())
        previous = self.store.list_default_names()
        with patch.object(self.store, '_save_index', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError): self.store.set_group_default(self.group['id'], False)
        self.assertEqual(self.store.list_default_names(), previous)
        self.store.set_group_default(self.group['id'], False)
        self.assertEqual(self.store.list_default_names(), [])

    def test_parent_guide_and_reference_always_cover_every_child(self):
        manuals = self.store.manuals()
        data = manuals.get(self.group['id'])
        for name in self.group['children']:
            self.assertIn(f'Evidence for {name}', data['originalContent'])
        saved = manuals.save(self.group['id'], '# Parent workflow\nOverview only', '')
        self.assertEqual(saved['originalContent'], data['originalContent'])
        context = manuals.context([self.group['id'], 'apply'])
        self.assertIn('Overview only', context)
        for name in self.group['children']:
            self.assertIn(f'Evidence for {name}', context)
        self.assertEqual(context.count('Evidence for apply'), 1)
        child = manuals.get('apply')
        manuals.save('apply', 'Updated child guide', child['revision'])
        self.assertTrue(manuals.get(self.group['id'])['outdated'])
        self.assertIn('Updated child guide', manuals.context([self.group['id']]))
        self.assertNotIn('Updated child guide', manuals.get(self.group['id'])['originalContent'])

    def test_context_budget_is_fair_and_does_not_drop_last_child(self):
        manuals = self.store.manuals()
        for name in self.group['children']:
            manuals.save(name, f'Unique {name}\n' + ('x' * 60_000), '')
        context = manuals.context([self.group['id']])
        for name in self.group['children']:
            self.assertIn(f'Unique {name}', context)
        self.assertIn('已截断', context)
        self.assertLess(len(context), 38_000)
        self.assertLess(len(manuals.get(self.group['id'])['content']), 128_000)

    def test_invalid_missing_and_ambiguous_references_fail_closed(self):
        self.assertEqual(skill_references(f'@SKILL:{self.group["id"]} [OpenSpec] 怎么用'), [self.group['id']])
        self.store.groups().rename(self.group['id'], '中文 名称', self.group['revision'])
        self.assertEqual(skill_references('@SKILL:"中文 名称" 怎么用'), ['中文 名称'])
        self.assertIn('Evidence for apply', self.store.manuals().context(['中文 名称']))
        for raw in ('@SKILL:../../secret', '@SKILL:repo.123/secret', '@SKILL:'):
            with self.assertRaises(ValueError): skill_references(raw)
        with self.assertRaisesRegex(ValueError, 'SKILL_PARENT_MISSING'):
            self.store.manuals().get('repo.' + '0' * 16)
        self.install('two', 'another/OpenSpec')
        # Explicit aliases can be ambiguous for repositories with common default names.
        self.install('three', 'third/OpenSpec')
        with self.assertRaisesRegex(ValueError, 'AMBIGUOUS'):
            self.store.groups().resolve('OpenSpec')

    async def test_rpc_routes_metadata_mutations_off_loop_and_never_deploys(self):
        bridge = BridgeWS.__new__(BridgeWS)
        bridge._skill_store = self.store
        bridge._ensure_kit_scheduler = lambda: None
        bridge._authorize_rpc = lambda *_args: None
        loop_thread = threading.get_ident()
        original = SkillGroups.rename

        def rename(groups, *args):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            return original(groups, *args)

        with patch.object(SkillGroups, 'rename', rename), patch.object(self.store, '_deploy', side_effect=AssertionError('no deployment')):
            result = json.loads(await bridge._dispatch('renameSkillGroup', [self.group['id'], 'Renamed', self.group['revision']]))
            self.assertEqual(result['status'], 'ok')
            result = json.loads(await bridge._dispatch('setSkillGroupDefault', [self.group['id'], True]))
            self.assertEqual(result['status'], 'ok')
            entries = json.loads(await bridge._dispatch('listSkills', ['']))
            self.assertEqual(next(e for e in entries if e['name'] == 'apply')['parent']['name'], 'Renamed')

    def test_parent_metadata_and_guide_survive_reinstall_and_are_backed_up(self):
        self.store.groups().rename(self.group['id'], 'Saved name', self.group['revision'])
        self.store.manuals().save(self.group['id'], 'Saved overview', '')
        self.install('apply')
        restored = SkillStore()
        self.assertEqual(restored.groups().resolve(self.group['id'])['name'], 'Saved name')
        self.assertEqual(restored.manuals().get(self.group['id'])['content'], 'Saved overview')
        archive = self.root.parent / 'backup.tar.gz'
        self.assertTrue(restored.export_library(str(archive)))
        with tarfile.open(archive) as backup:
            self.assertIn('.groups.json', backup.getnames())
            self.assertIn(f'.manuals/{self.group["id"]}.json', backup.getnames())


if __name__ == '__main__':
    unittest.main()
