export interface TaskTreeItem { id: string; parentSessionId?: string; relationKind?: string; execKey?: string; pinned?: boolean }
/** 一个实体只出现一次；父项缺失/被过滤时子项仍作为可达入口。 */
export function taskSessionTree<T extends TaskTreeItem>(items: T[], collapsed: Set<string>, search: boolean): Array<{ item: T; depth: number; children: T[] }> {
  const ids = new Set(items.map(row => `${row.execKey || 'local'}:${row.id}`));
  const children = new Map<string, T[]>();
  const parentKey = (row: T) => `${row.execKey || 'local'}:${row.parentSessionId}`;
  for (const item of items) {
    if (['task', 'integration'].includes(item.relationKind || '') && item.parentSessionId && item.parentSessionId !== item.id && ids.has(parentKey(item))) {
      children.set(parentKey(item), [...children.get(parentKey(item)) || [], item]);
    }
  }
  const result: Array<{ item: T; depth: number; children: T[] }> = [], seen = new Set<string>();
  const visit = (item: T, depth: number) => {
    const key = `${item.execKey || 'local'}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const kids = children.get(key) || [];
    result.push({ item, depth, children: kids });
    if (!collapsed.has(key) || search) kids.forEach(row => visit(row, Math.min(1, depth + 1)));
    else kids.forEach(row => seen.add(`${row.execKey || 'local'}:${row.id}`));
  };
  items.filter(row => !row.parentSessionId || !children.get(parentKey(row))?.includes(row)).forEach(row => visit(row, 0));
  items.filter(row => !seen.has(`${row.execKey || 'local'}:${row.id}`)).forEach(row => visit(row, 0));
  return result;
}
