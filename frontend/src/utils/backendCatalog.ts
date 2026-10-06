export interface BackendRevision { execKey: string; backendId: string }

/** 仅合并在途读取，不长期缓存；保存后隔离旧请求，每次重新打开仍读取权威节点。 */
export function createBackendCatalog<T>(load: (execKey: string) => Promise<T[]>) {
  const pending = new Map<string, Promise<T[]>>();
  const listeners = new Map<string, Set<(event: BackendRevision) => void>>();
  return {
    read(execKey: string): Promise<T[]> {
      const existing = pending.get(execKey);
      if (existing) return existing;
      const request = Promise.resolve().then(() => load(execKey));
      pending.set(execKey, request);
      const release = () => { if (pending.get(execKey) === request) pending.delete(execKey); };
      void request.then(release, release);
      return request;
    },
    subscribe(execKey: string, listener: (event: BackendRevision) => void): () => void {
      const set = listeners.get(execKey) ?? new Set();
      set.add(listener);
      listeners.set(execKey, set);
      return () => { set.delete(listener); if (!set.size) listeners.delete(execKey); };
    },
    publish(execKey: string, backendId: string): void {
      pending.delete(execKey);
      listeners.get(execKey)?.forEach(listener => listener({ execKey, backendId }));
    },
  };
}
