import React from 'react';
import { resolveCodexModelOptions, normalizeCodexModelOptions, type CodexModelOption } from '../utils/codexModelOptions';

interface Props {
  value?: CodexModelOption[] | null;
  onChange: (value: CodexModelOption[] | null) => void;
}

export const CodexModelOptionsEditor: React.FC<Props> = ({ value, onChange }) => {
  const rows = resolveCodexModelOptions({ type: 'codex-office', modelOptions: value });
  let error = '';
  try { normalizeCodexModelOptions(value); } catch (e) { error = (e as Error).message; }
  const move = (index: number, delta: number) => {
    [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]];
    onChange(rows);
  };
  return <section aria-label="模型候选编辑" style={{ minWidth: 0, margin: '14px 0', padding: 10, border: '1px solid var(--theme-border)', borderRadius: 8 }}>
    <div style={{ fontSize: 12, fontWeight: 600 }}>模型候选 · {value == null ? '内置' : '自定义'}（{rows.length}/100）</div>
    <p style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--theme-text-muted)', margin: '6px 0' }}>
      候选由你维护，不保证账号可用。只影响输入建议，不修改默认模型或已有会话；可随时手填其他模型。修改后请保存 Backend。
    </p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((row, index) => <div key={index} data-testid="model-option-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 8, borderRadius: 6, background: 'var(--theme-input-bg)' }}>
        <label style={fieldStyle}>模型 ID {index + 1}
          <input aria-label={`模型 ID ${index + 1}`} value={row.id} style={inputStyle}
            onChange={e => onChange(rows.map((item, i) => i === index ? { ...item, id: e.target.value } : item))} />
        </label>
        <label style={fieldStyle}>显示名称 {index + 1}（可选）
          <input aria-label={`显示名称 ${index + 1}`} value={row.label ?? ''} placeholder="留空显示 ID" style={inputStyle}
            onChange={e => onChange(rows.map((item, i) => i === index ? { ...item, label: e.target.value } : item))} />
        </label>
        <div style={{ display: 'flex', gap: 4, alignItems: 'end', flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} aria-label={`上移候选 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" style={buttonStyle} aria-label={`下移候选 ${index + 1}`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button type="button" style={buttonStyle} aria-label={`删除候选 ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>删除</button>
        </div>
      </div>)}
    </div>
    {rows.length === 0 && <p style={{ fontSize: 11 }}>无候选；仍可手填模型或留空继承。</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      <button type="button" style={buttonStyle} disabled={rows.length >= 100} onClick={() => onChange([...rows, { id: '' }])}>添加候选</button>
      <button type="button" style={buttonStyle} onClick={() => onChange([])}>清空候选</button>
      <button type="button" style={buttonStyle} onClick={() => onChange(null)}>恢复内置候选</button>
    </div>
    {error && <div role="alert" style={{ fontSize: 11, color: 'var(--theme-danger, #f85149)', marginTop: 8 }}>{error}</div>}
  </section>;
};

const fieldStyle: React.CSSProperties = { flex: '1 1 170px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 };
const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '8px', border: '1px solid var(--theme-border)', borderRadius: 5, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const buttonStyle: React.CSSProperties = { minHeight: 34, padding: '6px 10px', borderRadius: 5, border: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer', fontSize: 11 };
