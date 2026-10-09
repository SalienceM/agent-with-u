import { windowTransport } from './workbenchWindows';
import { uuid } from './uuid';
export const SESSION_DRAG_TYPE = 'application/x-awu-session-window';
export interface SessionDrag { session: string; executor: string; client: string; window: string; nonce: string }
let gesture: { value: SessionDrag; started: number } | undefined;
export function beginSessionDrag(session: string, executor: string): SessionDrag | null {
  const identity = windowTransport.identity, row = windowTransport.get(executor, session);
  if (!identity || !row || row.unknown || row.state.frozen || windowTransport.held(executor, session) || row.state.windowId !== identity.windowId) return null;
  const value = { session, executor, client: identity.clientId, window: identity.windowId, nonce: uuid() };
  gesture = { value, started: Date.now() }; return value;
}
export function readSessionDrag(raw: string): SessionDrag | null {
  if (raw.length > 2048) return null;
  try {
    const row = JSON.parse(raw);
    if (!row || Object.keys(row).sort().join(',') !== 'client,executor,nonce,session,window'
      || ![row.session, row.client, row.window, row.nonce].every(v => typeof v === 'string' && /^[\w-]{1,128}$/.test(v))
      || typeof row.executor !== 'string' || !row.executor || row.executor.length > 512) return null;
    return row;
  } catch { return null; }
}
export function consumeSessionDrag(session: string, nonce: string): boolean {
  if (!gesture || Date.now() - gesture.started > 30000 || gesture.value.session !== session || gesture.value.nonce !== nonce) return false;
  gesture = undefined; return true;
}
