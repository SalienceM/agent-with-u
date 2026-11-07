import { useEffect, useRef } from 'react';

/** 合并同一资源的在途只读请求；推送修订变化后最多补读最新一次，隐藏时不补读。 */
export function useCollaborationRead<T>(key: string, revision: number, enabled: boolean,
  read: () => Promise<T>, accept: (value: T) => void, error: (reason: unknown) => void) {
  const latest = useRef({ key, revision, enabled, read, accept, error }); latest.current = { key, revision, enabled, read, accept, error };
  const alive = useRef(true), running = useRef<Set<string>>(new Set()), cache = useRef(new Map<string, { revision: number; value: T }>());
  const run = () => {
    const current = latest.current;
    if (!alive.current || !current.enabled || !current.key || running.current.has(current.key)) return;
    const old = cache.current.get(current.key);
    if (old?.revision === current.revision) { current.accept(old.value); return; }
    running.current.add(current.key);
    void current.read().then(value => {
      cache.current.set(current.key, { revision: current.revision, value });
      if (cache.current.size > 40) cache.current.delete(cache.current.keys().next().value!);
      if (alive.current && latest.current.enabled && latest.current.key === current.key && latest.current.revision === current.revision) latest.current.accept(value);
    }).catch(reason => {
      if (alive.current && latest.current.enabled && latest.current.key === current.key && latest.current.revision === current.revision) latest.current.error(reason);
    }).finally(() => {
      running.current.delete(current.key);
      if (alive.current && latest.current.enabled && latest.current.key === current.key && latest.current.revision !== current.revision) run();
    });
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(run, [key, revision, enabled]);
}
