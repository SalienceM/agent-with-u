export function mergeSessionRouting(current: any, incoming: any): any {
  const merged = { ...current, ...incoming };
  if (incoming?.loopControlMode !== 'manual' && incoming?.loopControlMode !== 'loop') {
    merged.loopControlMode = current?.loopControlMode;
  }
  return merged;
}

export class SessionRoutingCache {
  private entries = new Map<string, any>();
  private revisions = new Map<string, number>();
  private listeners = new Map<string, Set<(value: any) => void>>();
  subscribe(id: string, listener: (value: any) => void): () => void {
    const listeners = this.listeners.get(id) || new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  private notify(id: string): void {
    this.listeners.get(id)?.forEach(listener => listener(this.get(id)));
  }
  get(id: string): any { return this.entries.get(id) || null; }
  revision(id: string): number { return this.revisions.get(id) || 0; }
  update(id: string, incoming: any): any {
    const merged = mergeSessionRouting(this.get(id), { ...incoming, id });
    this.entries.set(id, merged);
    this.revisions.set(id, this.revision(id) + 1);
    this.notify(id);
    return merged;
  }
  loaded(id: string, incoming: any, revision: number): any {
    if (this.revision(id) !== revision) return this.update(id, mergeSessionRouting(incoming, this.get(id)));
    return this.update(id, incoming);
  }
  delete(id: string): void { this.entries.delete(id); this.revisions.delete(id); this.notify(id); }
  clear(): void {
    this.entries.clear(); this.revisions.clear();
    this.listeners.forEach((_, id) => this.notify(id));
  }
}

export function isSessionMetaReady(session: any, id: string): boolean {
  return !!id && session?.id === id && ['normal', 'loop'].includes(session.sessionType)
    && (session.sessionType !== 'loop' || ['manual', 'loop'].includes(session.loopControlMode));
}
