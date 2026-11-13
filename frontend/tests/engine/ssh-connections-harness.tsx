import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KitSshConnection } from '../../src/components/KitSshConnection';
import { api } from '../../src/api';
import type { WorkspaceKit } from '../../src/types/workspaceKits';

export function mountSshFixture() {
  const profile = { id: 'saved-connection', label: '家里的 Linux', host: 'linux.example', port: 22, user: 'deploy',
    fingerprint: 'SHA256:1234567890abcdefghijklmnopqrstuvwxyz012345678', algorithm: 'ssh-ed25519',
    authMode: 'agent' as const, keyPath: '', revision: 'revision' };
  const f = { profiles: [] as typeof profile[], mode: 'legacy', writes: [] as any[], uses: [] as any[], probes: [] as any[],
    testCalls: [] as string[], testError: false, delayProbe: false, loseReply: false,
    finish: () => {}, changeSession: (_s: string) => {}, changeKit: (_k: Partial<WorkspaceKit>) => {} };
  api.kitSshConnections = async () => ({ status: 'ok', mode: f.mode, profiles: f.profiles });
  api.kitSshProbe = async (_sid, data) => {
    f.probes.push(data);
    if (f.delayProbe) await new Promise<void>(resolve => { f.finish = resolve; });
    return { ...profile, ...data, status: 'ok', probeId: 'probe-1' };
  };
  api.kitSshSave = async (_sid, data, request) => {
    f.writes.push({ data, request });
    f.profiles = [{ ...profile, ...data }];
    if (f.loseReply) throw new Error('保存结果未确认，请重新打开连接列表核对');
    return { status: 'ok', profile: f.profiles[0] };
  };
  api.kitSshTest = async (_sid, id) => {
    f.testCalls.push(id);
    return { status: f.testError ? 'error' : 'ok', message: f.testError ? '服务器指纹不匹配，已停止连接' : '服务器指纹匹配，密钥登录成功' };
  };
  api.kitSshUse = async (_sid, id, selected, version) => {
    f.uses.push({ id, selected, version });
    f.mode = 'key';
    f.changeKit({ activeVersionId: 'v2', inputs: [{ key: 'ssh_connection', default: selected }] });
    return { status: 'ok' };
  };
  function Fixture() {
    const [session, setSession] = useState('fixture');
    const [value, setValue] = useState('');
    const [kit, setKit] = useState({ id: 'kit-fixture', enabled: true, activeVersionId: 'v1', inputs: [] } as unknown as WorkspaceKit);
    f.changeSession = setSession;
    f.changeKit = patch => { setKit(k => ({ ...k, ...patch })); if (patch.inputs) setValue(String(patch.inputs[0].default)); };
    return <main style={{ maxWidth: 800, margin: 'auto', padding: 16 }}>
      <h3>SSH 一键更新 AgentWithU Docker</h3>
      <button onClick={() => setKit({ ...kit, enabled: !kit.enabled })}>{kit.enabled ? '停用' : '启用'}</button>
      <section style={{ border: '1px solid #444', borderRadius: 8, padding: 14, marginTop: 14 }}>
        <h4>标准输入</h4>
        <KitSshConnection sessionId={session} kit={kit} running={false} value={value} onChange={setValue} />
      </section>
    </main>;
  }
  (window as any).sshFixture = f;
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
