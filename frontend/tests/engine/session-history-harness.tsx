import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '../../src/components/ChatInput';
import { ArchivedSessionNotice } from '../../src/components/ArchivedSessionNotice';
import { useSessionRenewal } from '../../src/hooks/useSessionRenewal';
import { useChat } from '../../src/hooks/useChat';
import { api } from '../../src/api';
import { showPrivateSessions } from '../../src/utils/sessionVisibility';

export function mountHistoryFixture() {
  const backends = [{ id: 'dsh', type: 'deepseek-harness' }];
  const rows: any[] = [{ id: 'old', title: '原会话：需要保留的线索', createdAt: 1794528000, messageCount: 12, execKey: 'local' },
    { id: 'private', title: '私密旧会话', createdAt: 1794510000, messageCount: 8, execKey: 'local', isPrivate: true }];
  const f = { rows, writes: [] as any[], reads: [] as any[], opens: [] as string[], logReads: 0, mode: 'success', status: 'succeeded',
    focus: (_value: boolean) => {}, select: (_id: string) => {}, changed: () => {}, finish: () => {}, command: async (_text: string) => {}, show: showPrivateSessions };
  api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] }) as any;
  api.listSessions = async () => rows;
  api.listPrompts = async () => [];
  api.listSkills = async () => [];
  api.followupSuggestionSettings = async () => ({ version: 1, enabled: false }) as any;
  api.onSessionUpdated = () => () => {};
  api.peekSessionMeta = id => rows.find(row => row.id === id) || null;
  const receipt = () => ({ status: 'succeeded', session: rows.find(row => row.id === 'new') });
  api.sessionRenew = async (session, request, executor) => {
    f.writes.push({ session, request, executor });
    if (f.mode === 'offline') throw Object.assign(new Error('节点离线，未提交'), { notSubmitted: true });
    if (!rows.some(row => row.id === 'new')) rows.unshift({ id: 'new', title: '同目录新会话', createdAt: 1794531600, messageCount: 0, execKey: 'local' });
    Object.assign(rows.find(row => row.id === session), { isArchived: true, archiveRevision: 1 });
    if (f.mode === 'unknown') throw new Error('connection lost');
    if (f.mode === 'delay') await new Promise<void>(resolve => { f.finish = resolve; });
    return receipt();
  };
  api.sessionRenewStatus = async (session, request) => {
    f.reads.push({ session, request });
    if (f.status === 'offline') throw Object.assign(new Error('offline read'), { notSubmitted: true });
    return f.status === 'succeeded' ? receipt() : { status: f.status };
  };
  api.sessionHistory = async () => ({ status: 'ok', items: [...rows], nextOffset: null });
  api.sessionArchiveStatus = async id => ({ status: 'ok', session: rows.find(row => row.id === id) });
  api.sessionArchiveRestore = async (id, revision) => {
    const row = rows.find(row => row.id === id);
    if (row.archiveRevision !== revision) return { status: 'conflict', session: row };
    row.isArchived = false; row.archiveRevision++; f.changed();
    return { status: 'ok', session: row };
  };
  api.sessionNativeLogLocation = async () => {
    f.logReads++;
    return { status: 'ok', exists: true, nativeId: 'awu-' + 'a'.repeat(32),
      sessionsPath: 'C:\\fixture\\deepseek-harness\\' + 'a'.repeat(64) + '\\home\\sessions',
      bindingPath: 'C:\\fixture\\session.json', archivedBindingsPath: 'C:\\fixture\\bindings', backendLogPath: 'C:\\fixture\\backend.log' };
  };
  function Fixture() {
    const [selected, setSelected] = useState('old'), [active, setActive] = useState(true);
    const [, refresh] = useState(0); f.changed = () => refresh(value => value + 1);
    f.focus = setActive; f.select = setSelected;
    const renew = useSessionRenewal('fixture-user', selected, 'local', active, next => { f.opens.push(next.id); setSelected(next.id); });
    const chat = useChat(selected, 'dsh', backends, false, undefined, () => renew.start(), undefined, false);
    f.command = async text => { await chat.sendMessage(text); };
    const session = rows.find(row => row.id === selected);
    // 与 ChatPane 相同：React portal 点击会冒泡回原 pane，不能覆盖历史条目的导航。
    return <main onClick={() => setSelected(selected)} style={{ maxWidth: 900, margin: 'auto', padding: 8 }}>
      <h3 data-testid="selected" data-active={active}>{selected}</h3>
      {session?.isArchived ? <ArchivedSessionNotice key={selected} session={session} renewal={renew} onOpenSession={id => { f.opens.push(id); setSelected(id); }} /> : <ChatInput key={selected} sessionId={selected} execKey="local" historyKey={`fixture:${selected}`} workingDir="C:\\fixture"
        backends={backends} activeBackendId="dsh" isStreaming={false}
        onSend={() => {}} onAbort={() => {}} onCompact={() => void renew.start()}
        renewing={renew.busy} renewalUnknown={renew.unknown} renewalMessage={renew.message}
        onRetryRenewal={renew.retryable ? () => void renew.start(true) : undefined}
        onOpenSession={id => { f.opens.push(id); setSelected(id); }} />}
    </main>;
  }
  (window as any).historyFixture = f;
  createRoot(document.getElementById('root')!).render(<Fixture />);
}
