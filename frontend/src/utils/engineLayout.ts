export interface EngineLayout {
  version: 1;
  filesWidth: number;
  conversationWidth: number;
  terminalHeight: number;
  filesCollapsed: boolean;
  conversationCollapsed: boolean;
  terminalOpen: boolean;
  region: 'files' | 'document' | 'conversation' | 'terminal';
}
export const defaultEngineLayout: EngineLayout = { version: 1, filesWidth: 240, conversationWidth: 360,
  terminalHeight: 180, filesCollapsed: false, conversationCollapsed: false, terminalOpen: false, region: 'document' };
const clamp = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
export function normalizeEngineLayout(input: unknown): EngineLayout {
  const row = input as Partial<EngineLayout> | null;
  if (!row || row.version !== 1) return { ...defaultEngineLayout };
  return { version: 1, filesWidth: clamp(row.filesWidth, 240, 160, 480), conversationWidth: clamp(row.conversationWidth, 360, 280, 720),
    terminalHeight: clamp(row.terminalHeight, 180, 100, 600), filesCollapsed: row.filesCollapsed === true,
    conversationCollapsed: row.conversationCollapsed === true, terminalOpen: row.terminalOpen === true,
    region: ['files', 'document', 'conversation', 'terminal'].includes(row.region || '') ? row.region! : 'document' };
}
// sessionStorage 只属于当前窗口，两个窗口不会以最后一次写入覆盖彼此；key 另含用户/节点/Session。
export const engineLayoutKey = (identity: string) => `awu-engine-layout-v1:${identity}`;
export function readEngineLayout(storage: Pick<Storage, 'getItem'>, identity: string): EngineLayout {
  try { const raw = storage.getItem(engineLayoutKey(identity)); return raw && raw.length <= 2048 ? normalizeEngineLayout(JSON.parse(raw)) : { ...defaultEngineLayout }; }
  catch { return { ...defaultEngineLayout }; }
}
export function writeEngineLayout(storage: Pick<Storage, 'setItem'>, identity: string, value: EngineLayout): boolean {
  try { storage.setItem(engineLayoutKey(identity), JSON.stringify(normalizeEngineLayout(value))); return true; } catch { return false; }
}
export function fittedEngineWidths(layout: EngineLayout, width: number): { files: number; conversation: number } {
  const files = layout.filesCollapsed ? 0 : layout.filesWidth, conversation = layout.conversationCollapsed ? 0 : layout.conversationWidth;
  const budget = Math.max(0, width - 332);
  const scale = files + conversation > budget ? budget / (files + conversation) : 1;
  return { files: Math.floor(files * scale), conversation: Math.floor(conversation * scale) };
}
