export interface CodexModelOption { id: string; label?: string }
export interface CodexModelCatalog { type?: string; modelOptions?: CodexModelOption[] | null }

export const CODEX_MODELS: readonly CodexModelOption[] = Object.freeze([
  { id: 'gpt-6-astra', label: 'GPT-6 Astra · 最强端到端复杂任务' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 复杂任务/精细交付' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 日常均衡执行' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 快速/轻量' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
].map(item => Object.freeze(item)));

// 与 Python str.strip / isspace 一致（JS 的 \s 会额外接纳 BOM，遗漏 NEL 等）。
const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trimSpace = new RegExp(`^${whitespace}+|${whitespace}+$`, 'g');
const internalSpace = new RegExp(whitespace);
const control = /[\u0000-\u001f\u007f-\u009f]/;

export function normalizeCodexModelOptions(value: unknown): CodexModelOption[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 100) throw new Error('模型候选必须是最多 100 项的数组或 null');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const prefix = `模型候选第 ${index + 1} 项`;
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => key !== 'id' && key !== 'label')) {
      throw new Error(`${prefix} 必须是只含 ID 和可选名称的对象`);
    }
    if (typeof item.id !== 'string') throw new Error(`${prefix} ID 必须是字符串`);
    const id = item.id.replace(trimSpace, '');
    if (!id || [...id].length > 200 || internalSpace.test(id) || control.test(id)) {
      throw new Error(`${prefix} ID 必须为 1–200 字符，不能包含空白或控制字符`);
    }
    if (seen.has(id)) throw new Error(`${prefix} ID 重复：${id}`);
    if (item.label !== undefined && typeof item.label !== 'string') throw new Error(`${prefix} 显示名称必须是字符串`);
    const label = (item.label ?? '').replace(trimSpace, '');
    if ([...label].length > 120 || control.test(label)) throw new Error(`${prefix} 显示名称最多 120 字符，不能包含控制字符`);
    seen.add(id);
    return label ? { id, label } : { id };
  });
}

export function cloneCodexModelOptions(value?: CodexModelOption[] | null): CodexModelOption[] | null {
  return value == null ? null : value.map(item => ({ ...item }));
}

export function resolveCodexModelOptions(backend?: CodexModelCatalog | null): CodexModelOption[] {
  if (backend?.type !== 'codex-office') return [];
  return (backend.modelOptions ?? CODEX_MODELS).map(item => ({ ...item }));
}

export function assertCodexModelOptionsSaved(submitted: CodexModelCatalog, actual?: CodexModelCatalog): void {
  if (submitted.type !== 'codex-office' || submitted.modelOptions === undefined) return;
  let matches = false;
  try {
    matches = actual?.type === 'codex-office'
      && JSON.stringify(normalizeCodexModelOptions(submitted.modelOptions))
        === JSON.stringify(normalizeCodexModelOptions(actual.modelOptions));
  } catch { /* 非法回读同样不能宣称保存成功。 */ }
  if (!matches) throw new Error('模型候选未保存：执行节点回读与提交不一致，请确认执行端已升级。编辑草稿已保留；其他字段可能已保存。');
}

export async function saveAndVerifyBackend<T extends CodexModelCatalog & { id: string }>(
  config: T, execKey: string,
  save: (config: T, execKey: string) => Promise<void>,
  read: (execKey: string, includeDisabled: boolean) => Promise<T[]>,
): Promise<T[]> {
  await save(config, execKey);
  let list: T[];
  try { list = await read(execKey, true); }
  catch (error) {
    throw new Error(`Backend 已提交，但回读失败，无法确认候选已保存；草稿保留。${error instanceof Error ? error.message : ''}`);
  }
  assertCodexModelOptionsSaved(config, list.find(item => item.id === config.id));
  return list;
}
