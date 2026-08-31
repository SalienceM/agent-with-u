export type ScratchColor = 'yellow' | 'rose' | 'mint' | 'sky' | 'lavender' | 'slate';

export type ScratchBlock =
  | { type: 'text'; id: string; content: string }
  | { type: 'image'; id: string; src: string };

export interface ScratchTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

export interface ScratchEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  color: ScratchColor;
  pinned: boolean;
  archived: boolean;
  todos: ScratchTodo[];
  blocks: ScratchBlock[];
}

export const SCRATCH_COLORS: ScratchColor[] = [
  'yellow', 'rose', 'mint', 'sky', 'lavender', 'slate',
];

const finiteTimestamp = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');

export function normalizeScratchEntries(value: unknown, now = Date.now()): ScratchEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw, entryIndex): ScratchEntry[] => {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, unknown>;
    const id = stringValue(data.id).trim() || `legacy-entry-${now}-${entryIndex}`;
    const createdAt = finiteTimestamp(data.createdAt, now);
    const updatedAt = finiteTimestamp(data.updatedAt, createdAt);

    const blocks: ScratchBlock[] = Array.isArray(data.blocks)
      ? data.blocks.flatMap((rawBlock, blockIndex): ScratchBlock[] => {
          if (!rawBlock || typeof rawBlock !== 'object') return [];
          const block = rawBlock as Record<string, unknown>;
          const blockId = stringValue(block.id).trim() || `${id}-block-${blockIndex}`;
          if (block.type === 'text') {
            return [{ type: 'text', id: blockId, content: stringValue(block.content) }];
          }
          if (block.type === 'image') {
            return [{ type: 'image', id: blockId, src: stringValue(block.src) }];
          }
          return [];
        })
      : [];
    if (blocks.length === 0) {
      blocks.push({ type: 'text', id: `${id}-text`, content: '' });
    }

    const todos: ScratchTodo[] = Array.isArray(data.todos)
      ? data.todos.flatMap((rawTodo, todoIndex): ScratchTodo[] => {
          if (!rawTodo || typeof rawTodo !== 'object') return [];
          const todo = rawTodo as Record<string, unknown>;
          return [{
            id: stringValue(todo.id).trim() || `${id}-todo-${todoIndex}`,
            text: stringValue(todo.text),
            done: todo.done === true || todo.completed === true,
            createdAt: finiteTimestamp(todo.createdAt, createdAt + todoIndex),
          }];
        })
      : [];

    const color = SCRATCH_COLORS.includes(data.color as ScratchColor)
      ? data.color as ScratchColor
      : 'yellow';

    return [{
      id,
      createdAt,
      updatedAt,
      title: stringValue(data.title),
      color,
      pinned: data.pinned === true,
      archived: data.archived === true,
      todos,
      blocks,
    }];
  });
}

export function scratchTodoStats(entry: ScratchEntry): { total: number; done: number; pending: number } {
  const total = entry.todos.length;
  const done = entry.todos.reduce((count, todo) => count + (todo.done ? 1 : 0), 0);
  return { total, done, pending: total - done };
}

export function scratchEntryPreview(entry: ScratchEntry): string {
  const title = entry.title.trim();
  if (title) return title;
  for (const block of entry.blocks) {
    if (block.type !== 'text') continue;
    const firstLine = block.content.split('\n').map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  const todo = entry.todos.find((item) => item.text.trim());
  if (todo) return todo.text.trim();
  if (entry.blocks.some((block) => block.type === 'image')) return '图片便签';
  return '（空）';
}

export function filterScratchEntries(
  entries: ScratchEntry[], query: string, archived: boolean,
): ScratchEntry[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (entry.archived !== archived) return false;
    if (tokens.length === 0) return true;
    const searchable = [
      entry.title,
      ...entry.todos.map((todo) => todo.text),
      ...entry.blocks.flatMap((block) => block.type === 'text' ? [block.content] : []),
    ].join('\n').toLocaleLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}

export function sortScratchEntries(entries: ScratchEntry[]): ScratchEntry[] {
  return [...entries].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.updatedAt - left.updatedAt;
  });
}
