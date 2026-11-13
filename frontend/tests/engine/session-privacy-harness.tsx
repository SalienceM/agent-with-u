import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { api, getCurrentUserProfile } from '../../src/api';
import { showPrivateSessions } from '../../src/utils/sessionVisibility';
import { loadWorkbenchSnapshot, saveWorkbenchSnapshot } from '../../src/utils/workbench';
export function mountPrivacyFixture(options: { unknown?: boolean; seed?: boolean } = {}) {
  const stored = localStorage.getItem('qa-private-rows');
  const rows = stored ? JSON.parse(stored) : [
    { id: 'a', title: '公开 A', execKey: 'local', execLabel: '本机' },
    { id: 'b', title: '公开 B', execKey: 'node-b', execLabel: '同名节点' },
    { id: 'c', title: '公开 C', execKey: 'node-c', execLabel: '同名节点' },
    { id: 'd', title: '未打开 D', execKey: 'local' },
    { id: 'secret', title: '私密标题 X', execKey: 'node-b', execLabel: '同名节点', isPrivate: true, pinned: true },
    { id: 'child', title: '公开子项', execKey: 'node-b', execLabel: '同名节点', parentSessionId: 'secret', relationKind: 'task' },
  ];
  rows.forEach((row: any) => Object.assign(row, { sessionType: 'normal', privacyKnown: true, backendId: 'qa', workingDir: row.id === 'secret' ? '/secret/path' : '', updatedAt: 1 }));
  const callbacks = new Set<(data: any) => void>(), streams = new Set<(data: any) => void>();
  const f = { rows, callbacks, streams, mounts: [] as string[], unmounts: [] as string[], mutations: [] as string[], notifications: [] as string[], unknown: !!options.unknown,
    publish() { localStorage.setItem('qa-private-rows', JSON.stringify(rows)); callbacks.forEach(cb => cb({ type: 'privacy_changed', summaries: rows })); },
    snapshot() { return loadWorkbenchSnapshot(getCurrentUserProfile()); }, show: showPrivateSessions,
  };
  (window as any).privacyFixture = f;
  api.onConnectionStatus = callback => { callback(true); return () => {}; };
  api.getBackends = async () => [{ id: 'qa', type: 'openai-compatible', label: 'QA' }];
  api.getAppConfig = async () => ({ desktopTaskNotifications: true }) as any; api.setAppConfig = async () => ({}) as any;
  api.listSessions = async () => f.unknown ? [] : [...rows];
  api.peekSessionMeta = id => f.unknown ? null : rows.find((r: any) => r.id === id) || null;
  api.loadSessionMeta = async id => { if (f.unknown) throw Error('QA offline'); return api.peekSessionMeta(id); };
  api.resolveWorkspaceSession = async (_node, id) => { if (f.unknown) throw Error('QA offline'); return api.peekSessionMeta(id); };
  api.onSessionMetaChanged = () => () => {};
  api.onSessionUpdated = callback => { callbacks.add(callback); return () => { callbacks.delete(callback); }; };
  api.onStreamDelta = callback => { streams.add(callback); return () => { streams.delete(callback); }; };
  api.setSessionPrivacy = async (id, value) => { rows.find((r: any) => r.id === id).isPrivate = value; f.publish(); };
  api.setSessionFavorite = async (id, value) => { rows.find((r: any) => r.id === id).pinned = value; f.publish(); };
  api.seqtaskGet = async () => ({ status: 'ok', seqTasks: [] }) as any;
  api.loopGetState = async () => null;
  api.onSessionConnectionStatus = (_id, callback) => { callback(true); return () => {}; };
  api.userInteractionList = async () => ({ items: [], capability: { questions: true } }) as any;
  api.listSessionSkillCommands = async () => ({ status: 'ok', commands: [] }) as any;
  api.listSessionRefs = async () => rows;
  api.followupSuggestionSettings = async () => ({ version: 1, enabled: false }) as any;
  api.listPrompts = async () => []; api.listSkills = async () => [];
  if (options.seed) saveWorkbenchSnapshot(getCurrentUserProfile(), { version: 1, workbench: { tabs: ['chat','session:a','session:secret'], active: 'session:secret' }, panes: ['secret',null,null,null], focused: 0, layout: '1x1' });
  createRoot(document.getElementById('root')!).render(<App />);
}
