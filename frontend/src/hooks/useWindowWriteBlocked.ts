import { useEffect, useState } from 'react';
import { windowTransport } from '../utils/workbenchWindows';

export function useWindowWriteBlocked(executor: string, session?: string): boolean {
  const [, update] = useState(0);
  useEffect(() => windowTransport.subscribe(() => update(n => n + 1)), []);
  const row = session ? windowTransport.get(executor, session) : undefined;
  return !!row && (windowTransport.held(executor, session!) || row.unknown || row.state.frozen || row.state.windowId !== windowTransport.identity?.windowId);
}
