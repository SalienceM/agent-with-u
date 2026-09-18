import copy
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.backend.skill_command_manifest import FILENAME, RESERVED, parse_manifest, compile_arguments
from src.backend.skill_command_presets import BUILTIN_PROFILES
from src.backend.skill_commands import command_catalog, resolve_skill_call, registered_definitions, SkillCommandError
from src.backend.skill_store import SkillStore, standard_skills_from_zip_bytes, skill_files_digest
from src.types import Session, ModelBackendConfig, BackendType


def profile(owners=None):
    return {'schemaVersion': 1, 'id': 'review-suite', 'skillIds': owners or ['reviewer'], 'commands': [
        {'name': '/review-plan', 'description': 'Review this project', 'kind': 'skill', 'skillId': 'reviewer'},
        {'name': '/review-status', 'description': 'Read CLI status', 'kind': 'project',
         'cli': {'executable': 'reviewcli', 'windowsExecutable': 'reviewcli.cmd', 'localBin': 'node_modules/.bin'},
         'argv': ['status', '{id}', '--json'], 'parameters': [{'name': 'id', 'type': 'id', 'required': True}],
         'checks': {'requiredPaths': ['review/config.yaml']}}
    ]}


class CommandConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / 'library'
        for key, value in [('LIBRARY_DIR', self.library), ('INDEX_FILE', self.library / 'index.json')]:
            context = patch('src.backend.skill_store.' + key, value)
            context.start(); self.addCleanup(context.stop)
        self.store = SkillStore()
        self.config = ModelBackendConfig(id='backend', label='fixture', type=BackendType.CODEX_OFFICIAL)
        self.workspace = self.root / 'workspace'; self.workspace.mkdir()
        self.session = Session(id='session', title='fixture', created_at=1, updated_at=1, messages=[],
                               working_dir=str(self.workspace), backend_id='backend', abilities={'skills': ['reviewer']})

    def files(self, name, definition=None):
        files = {'SKILL.md': f'---\nname: {name}\ndescription: test\n---\nRead project then report.'.encode()}
        if definition is not None:
            files[FILENAME] = json.dumps(definition).encode()
        return files

    def install(self, name='reviewer', definition=None):
        return self.store.install_standard_files(self.files(name, definition), source={'kind': 'github', 'repository': 'example/review'})

    def catalog(self):
        return command_catalog(self.session, self.config, self.store)

    def resolve(self, text, invocation=None):
        return resolve_skill_call(self.session, self.config, self.store, text, invocation)

    def test_generic_install_discover_run_uninstall_and_no_implicit_execution(self):
        with patch('src.backend.skill_commands.shutil.which', side_effect=AssertionError('no CLI probe')):
            self.assertEqual(self.catalog()['commands'], [])
            self.install(definition=profile())
            catalog = self.catalog()
            self.assertEqual({c['name'] for c in catalog['commands']}, {'/skill reviewer', '/review-plan', '/review-status'})
            item = next(c for c in catalog['commands'] if c['name'] == '/review-plan')
            metadata, prompt = self.resolve('/review-plan check cache', {'name': item['skillName'], 'digest': item['digest'], 'arguments': 'check cache'})
            self.assertEqual(metadata['workingDir'], str(self.workspace))
            self.assertIn('Read project then report.', prompt)
            self.assertNotIn('Read project then report.', json.dumps(catalog))
            # Simulate uninstall without touching global secrets/manual directories.
            (self.library / 'reviewer' / 'SKILL.md').unlink()
            self.assertEqual(self.catalog()['commands'], [])
            with self.assertRaisesRegex(SkillCommandError, 'UNKNOWN_SKILL_COMMAND'):
                self.resolve('/review-plan check cache', {'name': item['skillName'], 'digest': item['digest'], 'arguments': 'check cache'})

    def test_binding_required_only_for_workflow_not_project_bootstrap(self):
        self.install(definition=profile())
        self.session.abilities = {}
        self.assertEqual([c['name'] for c in self.catalog()['commands']], ['/review-status'])
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_NOT_ENABLED'):
            self.resolve('/review-plan')

    def test_stale_config_and_instruction_digests_rejected(self):
        self.install(definition=profile())
        item = next(c for c in self.catalog()['commands'] if c['name'] == '/review-plan')
        invocation = {'name': item['skillName'], 'digest': item['digest'], 'arguments': ''}
        data = self.store.command_configs().get('reviewer')
        updated = profile(); updated['commands'][0]['description'] = 'Updated'
        self.store.command_configs().save('reviewer', json.dumps(updated), data['revision'])
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_CHANGED'):
            self.resolve('/review-plan', invocation)
        fresh = next(c for c in self.catalog()['commands'] if c['name'] == '/review-plan')
        (self.library / 'reviewer/SKILL.md').write_text('changed instructions')
        with self.assertRaisesRegex(SkillCommandError, 'SKILL_CHANGED'):
            self.resolve('/review-plan', {'name': fresh['skillName'], 'digest': fresh['digest'], 'arguments': ''})

    def test_parent_copies_deduplicate_and_conflicting_copies_fail_closed(self):
        shared = profile(['reviewer', 'tester'])
        self.install('reviewer', shared); self.install('tester', shared)
        self.assertEqual(len(registered_definitions(self.store)[0]), 2)
        changed = copy.deepcopy(shared); changed['commands'][0]['description'] = 'conflicting version'
        (self.library / 'tester' / FILENAME).write_text(json.dumps(changed))
        definitions, issues = registered_definitions(self.store)
        self.assertEqual(definitions, {}); self.assertTrue(issues)
        (self.library / 'tester' / FILENAME).write_text('{invalid')
        self.assertEqual(registered_definitions(self.store)[0], {})

    def test_alias_collisions_reserved_names_and_invalid_config_are_visible(self):
        self.install(definition=profile())
        other = profile(['tester']); other['id'] = 'different'; other['commands'][0]['skillId'] = 'tester'
        self.install('tester', other)
        self.assertTrue(self.catalog()['issues'])
        self.assertEqual(registered_definitions(self.store)[0], {})
        for reserved in RESERVED:
            bad = profile(); bad['commands'][0]['name'] = reserved
            with self.subTest(reserved=reserved), self.assertRaises(ValueError):
                parse_manifest(json.dumps(bad))
        (self.library / 'tester' / FILENAME).write_text('broken')
        self.assertTrue(self.catalog()['issues'])

    def test_unrelated_package_cannot_silently_replace_compatibility_profile_id(self):
        self.install('openspec-apply-change')
        impostor = profile(); impostor['id'] = 'openspec'
        self.install(definition=impostor)
        definitions, issues = registered_definitions(self.store)
        self.assertEqual(definitions, {})
        self.assertTrue(issues)

    def test_schema_rejects_execution_hooks_bad_fields_paths_and_interpolation(self):
        for mutate in [lambda p: p.update(schemaVersion=2), lambda p: p.update(postInstall='run-this'),
                       lambda p: p['commands'][1]['cli'].update(executable='sh -c'),
                       lambda p: p['commands'][1]['checks'].update(requiredPaths=['../outside']),
                       lambda p: p['commands'][1].update(argv=['--id={id}']),
                       lambda p: p['commands'][0].update(kind=[]),
                       lambda p: p['commands'][1]['parameters'][0].update(type=[]),
                       lambda p: p['commands'][0].update(skillId='foreign')]:
            bad = profile(); mutate(bad)
            with self.assertRaises(ValueError): parse_manifest(json.dumps(bad))
        with self.assertRaises(ValueError): parse_manifest('{"id":"a","id":"b"}')
        with self.assertRaises(ValueError): parse_manifest(' ' * 128001)
        for preset in BUILTIN_PROFILES:
            parse_manifest(json.dumps(preset))

    def test_typed_cli_args_and_preflight_use_session_root_without_running_cli(self):
        self.install(definition=profile())
        with patch('src.backend.skill_commands.shutil.which', return_value=None):
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_CLI_MISSING'):
                self.resolve('/review-status cache')
        with patch('src.backend.skill_commands.shutil.which', return_value='mock-review'):
            with self.assertRaisesRegex(SkillCommandError, 'COMMAND_PROJECT_REQUIRED'):
                self.resolve('/review-status cache')
            (self.workspace / 'review').mkdir()
            (self.workspace / 'review/config.yaml').write_text('schema: demo')
            metadata, instructions = self.resolve('/review-status cache')
            self.assertEqual(metadata['argv'], ['status', 'cache', '--json'])
            self.assertIn('不拼接原始输入', instructions)
            for args in ['', '../outside', 'x;echo', '$(whoami)', 'x --force']:
                with self.assertRaisesRegex(SkillCommandError, 'COMMAND_ARGUMENTS'):
                    self.resolve('/review-status ' + args)

    def test_parent_editor_roundtrip_conflict_guard_and_no_implicit_deployment(self):
        self.install(); self.install('tester')
        group = self.store.groups().list()[0]
        data = self.store.command_configs().get(group['id'])
        with patch.object(self.store, '_deploy', side_effect=AssertionError('no deployment')):
            saved = self.store.command_configs().save(group['id'], json.dumps(profile(['reviewer', 'tester'])), data['revision'])
        self.assertEqual(saved['origin'], 'package')
        self.assertEqual((self.library / 'reviewer' / FILENAME).read_bytes(), (self.library / 'tester' / FILENAME).read_bytes())
        self.assertTrue(self.store._index['reviewer']['source']['dirty'])
        with self.assertRaisesRegex(ValueError, '已变化'):
            self.store.command_configs().save(group['id'], saved['content'], data['revision'])
        self.store.groups().rename(group['id'], 'Custom name', group['revision'])
        self.assertEqual(registered_definitions(self.store)[0]['/review-plan']['profileId'], 'review-suite')

    def test_bundled_compatibility_can_be_exported_and_overridden_with_empty_list(self):
        self.install('openspec-apply-change')
        data = self.store.command_configs().get('openspec-apply-change')
        self.assertEqual(data['origin'], 'compatibility')
        parsed = parse_manifest(data['content']); self.assertEqual(parsed['id'], 'openspec')
        self.assertIn('/opsx-init', registered_definitions(self.store)[0])
        parsed['commands'] = []
        self.store.command_configs().save('openspec-apply-change', json.dumps(parsed), data['revision'])
        self.assertEqual(registered_definitions(self.store)[0], {})

    def test_configured_skill_identity_rename_never_discards_shared_configuration(self):
        self.install(definition=profile())
        with self.assertRaisesRegex(ValueError, '稳定 ID'):
            self.store.rename_skill('reviewer', 'renamed', '# renamed')
        self.assertTrue((self.library / 'reviewer' / FILENAME).is_file())
        self.assertIn('/review-plan', registered_definitions(self.store)[0])

    def test_repository_zip_inherits_root_config_and_digest_matches_installed_files(self):
        shared = profile(['reviewer', 'tester'])
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zf:
            zf.writestr('repo-main/' + FILENAME, json.dumps(shared))
            for name in shared['skillIds']:
                zf.writestr(f'repo-main/skills/{name}/SKILL.md', self.files(name)['SKILL.md'])
        entries = standard_skills_from_zip_bytes(archive.getvalue())
        self.assertEqual(len(entries), 2)
        for entry in entries:
            self.assertIn(FILENAME, entry['files'])
            self.assertEqual(entry['digest'], skill_files_digest(entry['files']))
            self.store.install_standard_files(entry['files'])
        self.assertEqual(len(registered_definitions(self.store)[0]), 2)

    def test_invalid_import_does_not_mutate_existing_skill_and_awu_roundtrip(self):
        self.install(definition=profile())
        before = (self.library / 'reviewer/SKILL.md').read_bytes()
        bad = self.files('reviewer', profile()); bad[FILENAME] = b'{invalid'
        with self.assertRaises(ValueError): self.store.install_standard_files(bad)
        self.assertEqual(before, (self.library / 'reviewer/SKILL.md').read_bytes())
        path = self.root / 'skill.awu'
        with zipfile.ZipFile(path, 'w') as zf:
            zf.writestr('manifest.json', json.dumps({'id': 'reviewer', 'name': 'Reviewer', 'version': '1'}))
            for name, data in self.files('reviewer', profile()).items(): zf.writestr(name, data)
        self.store.install_package(str(path))
        self.assertIn('/review-plan', registered_definitions(self.store)[0])

    def test_browsing_registry_reads_no_instruction_bodies_or_writes(self):
        self.install(definition=profile()); self.session.abilities = {}
        with patch.object(Path, 'write_text', side_effect=AssertionError('read only')), \
             patch.object(self.store, 'get_skill', side_effect=AssertionError('no bodies')):
            self.assertEqual(len(self.catalog()['commands']), 1)

    def test_missing_library_is_read_only_empty_catalog(self):
        self.session.abilities = {}
        self.library.rmdir()
        with patch.object(Path, 'mkdir', side_effect=AssertionError('listing must not create directories')):
            self.assertEqual(self.catalog()['commands'], [])

    def test_ancestor_config_only_applies_to_declared_skills(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as zf:
            zf.writestr('repo/' + FILENAME, json.dumps(profile()))
            for name in ['reviewer', 'unrelated']:
                zf.writestr(f'repo/skills/{name}/SKILL.md', self.files(name)['SKILL.md'])
        entries = {item['name']: item for item in standard_skills_from_zip_bytes(archive.getvalue())}
        self.assertIn(FILENAME, entries['reviewer']['files'])
        self.assertNotIn(FILENAME, entries['unrelated']['files'])
        scoped = standard_skills_from_zip_bytes(archive.getvalue(), 'skills/reviewer')
        self.assertEqual(len(scoped), 1)
        self.assertIn(FILENAME, scoped[0]['files'])

    def test_config_symlink_cannot_read_or_write_outside_package(self):
        self.install()
        target = self.root / 'outside.json'; target.write_text('{}')
        link = self.library / 'reviewer' / FILENAME
        try: link.symlink_to(target)
        except OSError: self.skipTest('symlinks unavailable')
        self.assertTrue(self.catalog()['issues'])
        with self.assertRaises(ValueError): self.store.command_configs().get('reviewer')


if __name__ == '__main__':
    unittest.main()
