/** “local”是连接方式，只有桌面本机 sidecar 才能称为用户的本机。 */
export function skillInstallTargetLabel(key: string, executor: { label: string } | undefined, desktop: boolean): string {
  if (key === 'local') return desktop ? '本机执行节点' : '直连执行节点（服务器）';
  return `远端执行节点 · ${executor?.label || key}`;
}
