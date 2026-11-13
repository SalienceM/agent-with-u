import base64
import copy
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.backend import ssh_connections as ssh
from src.backend.bridge_ws import BridgeWS, _REQUEST_OWNER_ID, _REQUEST_IDENTITY_SOURCE
from src.backend.workspace_kit_store import WorkspaceKit, KitRun, KitStepRun, resolve_kit_inputs
from src.types import Session


def server_key(seed=b'a'):
    name = b'ssh-ed25519'
    blob = len(name).to_bytes(4, 'big') + name + (32).to_bytes(4, 'big') + seed * 32
    return ssh.public_key('fixture ssh-ed25519 ' + base64.b64encode(blob).decode())


class SshConnectionsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {'AGENT_WITH_U_DATA_ROOT': self.temp.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.profile = {'host': 'linux.example', 'port': 22, 'user': 'deploy', 'label': 'Linux',
                        'authMode': 'agent', 'keyPath': '', **server_key()}

    def bridge(self):
        bridge = BridgeWS()
        bridge._active_sessions['fixture'] = Session(id='fixture', title='fixture', messages=[],
            created_at=time.time(), updated_at=time.time(), working_dir=self.temp.name, backend_id='fake')
        return bridge

    def test_store_is_owner_scoped_immutable_and_idempotent(self):
        store = ssh.ConnectionStore('owner-a')
        saved = store.save(self.profile, 'request-1')
        self.assertEqual(saved, store.save(self.profile, 'request-1'))
        self.assertEqual([saved], ssh.ConnectionStore('owner-a').list())
        self.assertEqual([], ssh.ConnectionStore('owner-b').list())
        with self.assertRaises(FileNotFoundError):
            ssh.ConnectionStore('owner-b').get(saved['id'])
        with self.assertRaisesRegex(ValueError, '其他连接'):
            store.save(dict(self.profile, host='different.example'), 'request-1')
        path = store.root / (saved['id'] + '.json')
        path.write_text(json.dumps(dict(saved, host='different.example')))
        with self.assertRaisesRegex(ValueError, '损坏'):
            store.get(saved['id'])

    def test_reject_injection_and_relative_keys(self):
        for host in ['-oProxyCommand=x', 'foo;cmd', 'foo\nbar', 'user@foo', 'foo:22']:
            with self.assertRaises(ValueError):
                ssh.endpoint(dict(self.profile, host=host))
        for user in ['-oProxyCommand=x', 'a@host', 'a\nb']:
            with self.assertRaises(ValueError):
                ssh.endpoint(dict(self.profile, user=user))
        for key in ['id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc', 'C:\\%h\\key']:
            with self.assertRaises(ValueError):
                ssh.authentication({'authMode': 'key', 'keyPath': key})
        with self.assertRaises(ValueError):
            ssh.ConnectionStore('owner').get('../bad')

    async def test_probe_only_discovers_public_key_and_does_not_save(self):
        with patch.object(ssh, 'executable', return_value='fake-keyscan'), patch.object(ssh, 'run_bounded',
            new=AsyncMock(return_value=(0, 'fixture ssh-ed25519 ' + self.profile['publicKey'], ''))) as call:
            result = await ssh.probe(self.profile)
        self.assertEqual(result['fingerprint'], self.profile['fingerprint'])
        self.assertEqual(call.call_args.args[0][-1], 'linux.example')
        self.assertFalse(ssh.ConnectionStore('local').root.exists())

    async def test_probe_failure_does_not_trust_anything(self):
        with patch.object(ssh, 'executable', return_value='fake'), patch.object(ssh, 'run_bounded',
            new=AsyncMock(return_value=(1, 'bad output', 'network unavailable'))):
            with self.assertRaisesRegex(ValueError, '没有保存'):
                await ssh.probe(self.profile)

    async def test_confirmation_is_bound_to_owner_session_endpoint_and_fingerprint(self):
        bridge = self.bridge()
        with patch('src.backend.kit_ssh_connections.probe', new=AsyncMock(return_value=self.profile)):
            result = json.loads(await bridge._rpc_kitSshProbe('fixture', json.dumps(self.profile)))
        data = dict(self.profile, probeId=result['probeId'], confirmed=True, password='never-store-me')
        for changed in [{'confirmed': False}, {'host': 'other.example'}, {'fingerprint': server_key(b'b')['fingerprint']}]:
            with self.assertRaises(ValueError):
                bridge._rpc_kitSshSave('fixture', json.dumps(dict(data, **changed)), 'save-1')
        saved = json.loads(bridge._rpc_kitSshSave('fixture', json.dumps(data), 'save-1'))['profile']
        self.assertNotIn('password', saved)
        self.assertNotIn('never-store-me', ''.join(p.read_text() for p in Path(self.temp.name).rglob('*.json')))
        self.assertEqual(saved, json.loads(bridge._rpc_kitSshSave('fixture', json.dumps(data), 'save-1'))['profile'])
        bridge._ssh_connection_probes[result['probeId']]['expires'] = 0
        with self.assertRaisesRegex(ValueError, '过期'):
            bridge._rpc_kitSshSave('fixture', json.dumps(data), 'save-2')

    def test_shared_node_and_cross_owner_access_are_denied(self):
        bridge = self.bridge()
        token = _REQUEST_IDENTITY_SOURCE.set('relay')
        try:
            with self.assertRaises(PermissionError):
                bridge._rpc_kitSshConnections('fixture', 'unknown')
        finally:
            _REQUEST_IDENTITY_SOURCE.reset(token)
        token = _REQUEST_OWNER_ID.set('another-owner')
        try:
            with self.assertRaises(PermissionError):
                bridge._rpc_kitSshConnections('fixture', 'unknown')
        finally:
            _REQUEST_OWNER_ID.reset(token)

    async def test_test_connection_has_strict_pins_and_no_password_fallback(self):
        calls = []
        async def run(argv, timeout):
            calls.append(argv)
            option = next(arg for arg in argv if arg.startswith('UserKnownHostsFile='))
            path = Path(option.split('=', 1)[1].strip('"'))
            self.assertEqual(path.read_text(), ssh.known_hosts(self.profile))
            return 0, 'AWU_SSH_OK', ''
        with patch.object(ssh, 'executable', return_value='fake-ssh'), patch.object(ssh, 'run_bounded', run):
            result = await ssh.test_connection(self.profile)
        self.assertEqual(result['status'], 'ok')
        for expected in ['StrictHostKeyChecking=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no',
                         'ForwardAgent=no', 'IdentityFile=none', 'BatchMode=yes']:
            self.assertIn(expected, calls[0])
        self.assertEqual(calls[0][-1], 'printf AWU_SSH_OK')
        with patch.object(ssh, 'executable', return_value='fake-ssh'), patch.object(ssh, 'run_bounded',
            new=AsyncMock(return_value=(255, '', 'Host key verification failed'))):
            result = await ssh.test_connection(self.profile)
        self.assertEqual(result['status'], 'error')
        self.assertIn('指纹不匹配', result['message'])

    @unittest.skipUnless(os.name == 'nt', 'Windows template')
    def test_upgrade_retains_versions_defaults_and_freezes_exact_connection(self):
        bridge = self.bridge()
        legacy = bridge._ssh_template()
        for item in legacy['inputs']:
            if item['key'] == 'remote_repo':
                item['default'] = '/my/repo'
        created = json.loads(bridge._rpc_kitCreate('fixture', json.dumps(legacy)))
        self.assertEqual('ok', created['status'])
        kid = created['kit']['id']
        version = created['kit']['activeVersionId']
        profile = bridge._ssh_store().save(self.profile, 'save-1')
        with self.assertRaisesRegex(ValueError, '停用'):
            bridge._rpc_kitSshUse('fixture', kid, profile['id'], version)
        bridge._rpc_kitUpdate('fixture', kid, '{"enabled":false}')
        state = bridge._kit_get('fixture')
        state.runs.append(KitRun(id='running-fixture', session_id='fixture', kit_id=kid, status='running'))
        with self.assertRaisesRegex(ValueError, '正在运行'):
            bridge._rpc_kitSshUse('fixture', kid, profile['id'], version)
        state.runs.clear()
        state.runs.append(KitRun(id='chain-run', session_id='fixture', kit_id='parent', status='running',
                                steps=[KitStepRun(id='child', source_kit_id=kid)]))
        with self.assertRaisesRegex(ValueError, '组合运行'):
            bridge._rpc_kitSshUse('fixture', kid, profile['id'], version)
        state.runs.clear()
        with self.assertRaisesRegex(ValueError, '版本已变化'):
            bridge._rpc_kitSshUse('fixture', kid, profile['id'], 'stale')
        result = json.loads(bridge._rpc_kitSshUse('fixture', kid, profile['id'], version))
        self.assertEqual('ok', result['status'])
        kit = bridge._kit_find(state, kid)
        self.assertEqual(2, len(kit.versions))
        self.assertEqual(legacy['steps'], kit.versions[0].snapshot['steps'])
        self.assertFalse(any(item['type'] == 'secret' for item in kit.inputs))
        inputs, errors = resolve_kit_inputs(kit, {}, state)
        self.assertEqual([], errors)
        self.assertEqual(inputs['remote_repo'], '/my/repo')
        plan, errors = bridge._kit_build_plan(state, kit, inputs)
        self.assertEqual([], errors)
        frozen = plan[0].config['sshConnection']
        env = bridge._ssh_runtime_env(frozen)
        self.assertEqual('linux.example', env['KIT_INPUT_SSH_HOST'])
        self.assertNotIn('PASSWORD', json.dumps(env))
        changed = copy.deepcopy(frozen)
        changed['profile']['host'] = 'other.example'
        with self.assertRaisesRegex(ValueError, '不一致'):
            bridge._ssh_runtime_env(changed)
        changed['owner'] = 'other'
        with self.assertRaisesRegex(ValueError, '账号已变化'):
            bridge._ssh_runtime_env(changed)
        kit.steps[0]['command'] += '\nWrite-Output custom'
        _, errors = bridge._kit_build_plan(state, kit, inputs)
        self.assertTrue(errors)

    @unittest.skipUnless(os.name == 'nt', 'Windows template')
    async def test_runner_injects_frozen_connection_and_fails_before_spawn_if_changed(self):
        bridge = self.bridge()
        profile = bridge._ssh_store().save(self.profile, 'save-runtime')
        kit = WorkspaceKit.from_dict(bridge._ssh_template(key=True))
        state = bridge._kit_get('fixture')
        state.kits.append(kit)
        inputs, _ = resolve_kit_inputs(kit, {'ssh_connection': profile['id']}, state)
        steps, errors = bridge._kit_build_plan(state, kit, inputs)
        self.assertFalse(errors)
        run = KitRun(id='fake-run', session_id='fixture', kit_id=kit.id, steps=steps)
        state.runs.append(run)
        proc = AsyncMock()
        proc.returncode = 0
        proc.communicate.return_value = (b'AWU_REMOTE_UPDATE_OK', b'')
        with patch('asyncio.create_subprocess_exec', new=AsyncMock(return_value=proc)) as spawn:
            await bridge._run_workspace_kit('fixture', kit.id, run.id)
        self.assertEqual('succeeded', run.status)
        env = spawn.call_args.kwargs['env']
        self.assertEqual('linux.example', env['KIT_INPUT_SSH_HOST'])
        self.assertEqual(ssh.known_hosts(profile), base64.b64decode(env['KIT_SSH_KNOWN_HOSTS']).decode())
        steps, _ = bridge._kit_build_plan(state, kit, inputs)
        steps[0].config['sshConnection']['profile']['host'] = 'changed.example'
        run = KitRun(id='fail-run', session_id='fixture', kit_id=kit.id, steps=steps)
        state.runs.append(run)
        with patch('asyncio.create_subprocess_exec', new=AsyncMock()) as spawn:
            await bridge._run_workspace_kit('fixture', kit.id, run.id)
        spawn.assert_not_called()
        self.assertEqual('error', run.status)
        self.assertEqual('error', steps[0].status)

    def test_key_template_removes_secret_code_and_legacy_stays_available(self):
        bridge = self.bridge()
        legacy = bridge._ssh_template()
        candidate = bridge._ssh_template(key=True)
        command = candidate['steps'][0]['command']
        for forbidden in ['SSH_ASKPASS', 'sudo -S', 'accept-new', 'KIT_INPUT_SSH_PASSWORD', 'sudo_password']:
            self.assertNotIn(forbidden, command)
        self.assertIn('sudo -n', command)
        self.assertIn('KIT_SSH_ARGUMENTS_JSON', command)
        self.assertIn('ssh_password', [item['key'] for item in legacy['inputs']])
        self.assertIn('git merge --ff-only', command)
        generated = bridge._kit_builtin_ssh_linux_update_candidate('SSH 免密更新 AgentWithU', [])
        self.assertEqual(candidate, generated)

    @unittest.skipUnless(os.name == 'nt' and shutil.which('powershell'), 'PowerShell parser')
    def test_powershell_template_parses_without_execution(self):
        command = self.bridge()._ssh_template(key=True)['steps'][0]['command']
        path = Path(self.temp.name) / 'template.ps1'
        path.write_text(command, encoding='utf-8-sig')
        script = "$e=$null; $t=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:AWU_PARSE_FILE,[ref]$t,[ref]$e) | Out-Null; if($e){$e | Out-String | Write-Output; exit 1}"
        result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
            env={**os.environ, 'AWU_PARSE_FILE': str(path)}, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which('ssh'), 'OpenSSH config parser')
    def test_native_ssh_options_parse_without_network(self):
        path = str(Path(self.temp.name) / 'directory with spaces' / 'known_hosts')
        result = subprocess.run(['ssh', '-G', *ssh.ssh_options(self.profile, path), 'deploy@linux.example'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('stricthostkeychecking true', result.stdout)
        self.assertIn('passwordauthentication no', result.stdout)
        self.assertIn(path, result.stdout)

    @unittest.skipUnless(os.name == 'nt' and shutil.which('powershell') and shutil.which('ssh'), 'Windows native argument passing')
    def test_powershell_passes_pinned_path_with_spaces_to_openssh(self):
        path = str(Path(self.temp.name) / 'path with spaces' / 'known_hosts')
        script = "$a=@((ConvertFrom-Json $env:AWU_SSH_OPTIONS)); & ssh -G @a 'deploy@linux.example'; exit $LASTEXITCODE"
        result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
            env={**os.environ, 'AWU_SSH_OPTIONS': json.dumps(ssh.ssh_options(self.profile, path))},
            capture_output=True, text=True, timeout=15)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn(path, result.stdout)
        self.assertIn('stricthostkeychecking true', result.stdout)


if __name__ == '__main__':
    unittest.main()
