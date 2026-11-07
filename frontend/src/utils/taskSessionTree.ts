export interface TaskTreeItem { id: string; parentSessionId?: string; relationKind?: string; execKey?: string; pinned?: boolean }
const keyOf = (row: TaskTreeItem) => `${row.execKey || 'local'}:${row.id}`;
/** 只显示两层；历史多层展平到真实根，缺失父项与环仍保留可达实体。 */
export function taskSessionTree<T extends TaskTreeItem>(items: T[], collapsed: Set<string>, search: boolean): Array<{ item: T; depth: number; children: T[] }> {
  const byKey = new Map(items.map(row => [keyOf(row), row]));
  const rootKey = (item: T): string => {
    const visited = new Set<string>(); let row = item;
    while (['task', 'integration'].includes(row.relationKind || '') && row.parentSessionId) {
      const key = keyOf(row);
      if (visited.has(key)) return [...visited].sort()[0];
      visited.add(key);
      const parent = byKey.get(`${row.execKey || 'local'}:${row.parentSessionId}`);
      if (!parent) break;
      row = parent;
    }
    return keyOf(row);
  };
  const families = new Map<string, T[]>();
  for (const item of items) {
    const root = rootKey(item);
    families.set(root, [...families.get(root) || [], item]);
  }
  const result: Array<{ item: T; depth: number; children: T[] }> = [];
  for (const [root, family] of families) {
    const parent = byKey.get(root)!;
    const children = family.filter(row => keyOf(row) !== root);
    result.push({ item: parent, depth: 0, children });
    if (!collapsed.has(root) || search) children.forEach(item => result.push({ item, depth: 1, children: [] }));
  }
  return result;
}
