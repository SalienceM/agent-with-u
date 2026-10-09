import { handoffParticipants } from './workbenchHandoffState';
type Participant = { export: () => unknown | Promise<unknown>; import: (value: any) => void | Promise<void> };
const registrations = new Map<string, { parts: Map<string, Participant>; off: () => void }>();
export const resourceHandoff = {
  register(scope: string, kind: 'terminals' | 'languages', participant: Participant): () => void {
    let entry = registrations.get(scope);
    if (!entry) {
      const parts = new Map<string, Participant>();
      const off = handoffParticipants.register(scope, 'resources', {
        export: async () => { const values: Record<string, unknown> = {}; for (const [key, part] of parts) values[key] = await part.export(); return values; },
        import: async value => {
          if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['terminals', 'languages'].includes(k))) throw new Error('工程资源交接无效');
          for (const [key, data] of Object.entries(value)) {
            const part = parts.get(key); if (!part) throw new Error('工程资源视图未就绪，保留源窗口');
            await part.import(data);
          }
        },
      });
      entry = { parts, off }; registrations.set(scope, entry);
    }
    if (entry.parts.has(kind)) throw new Error('重复工程资源拥有者');
    entry.parts.set(kind, participant);
    return () => { if (entry!.parts.get(kind) === participant) entry!.parts.delete(kind); if (!entry!.parts.size) { entry!.off(); registrations.delete(scope); } };
  },
};
