import React from 'react';
import { CodexModelOptionsEditor } from './CodexModelOptionsEditor';
import type { CodexModelOption } from '../utils/codexModelOptions';

export interface HarnessConfigFields {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modelOptions?: CodexModelOption[] | null;
  cliPath?: string;
  workingDir?: string;
  harnessProvider?: string;
  harnessPermissionMode?: string;
  harnessMaxTokens?: number;
  skipPermissions?: boolean;
}

export const HarnessBackendFields: React.FC<{
  value: HarnessConfigFields;
  onChange: (patch: Partial<HarnessConfigFields>) => void;
}> = ({ value, onChange }) => <section aria-label="DeepSeek Harness 配置" style={{ minWidth: 0 }}>
  <p style={hintStyle}>DeepSeek Harness 0.2.1-rc.3（预发布）· 原生文件、命令和工具执行。支持排到下一轮；尚不支持同轮引导、接管外部线程或图片输入。</p>
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12 }}>
    <label style={fieldStyle}>API Key
      <input type="password" autoComplete="off" value={value.apiKey || ''} style={inputStyle}
        onChange={e => onChange({ apiKey: e.target.value })} placeholder="留空使用执行节点凭据" />
    </label>
    <label style={fieldStyle}>连接地址（可选）
      <input value={value.baseUrl || ''} style={inputStyle} onChange={e => onChange({ baseUrl: e.target.value })}
        placeholder="留空使用 Harness 官方地址" />
    </label>
    <label style={fieldStyle}>默认模型（可选）
      <input value={value.model || ''} style={inputStyle} onChange={e => onChange({ model: e.target.value })}
        placeholder="手填模型 ID；留空使用锁定 SDK 默认" />
    </label>
    <label style={fieldStyle}>最大输出 Tokens（可选）
      <input type="number" min={1} step={1} value={value.harnessMaxTokens ?? ''} style={inputStyle}
        onChange={e => onChange({ harnessMaxTokens: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="跟随运行时默认" />
    </label>
    <label style={fieldStyle}>访问策略
      <select aria-label="访问策略" value={value.harnessPermissionMode || 'workspace-write'} style={inputStyle}
        onChange={e => onChange({ harnessPermissionMode: e.target.value })}>
        <option value="read-only">只读</option>
        <option value="workspace-write">工作区可写</option>
        <option value="danger-full-access">全文件访问（显式启用）</option>
      </select>
    </label>
    <label style={fieldStyle}>权限升级
      <select aria-label="权限升级" value={value.skipPermissions ? 'reject' : 'ask'} style={inputStyle}
        onChange={e => onChange({ skipPermissions: e.target.value === 'reject' })}>
        <option value="ask">询问确认</option>
        <option value="reject">不询问，拒绝升级</option>
      </select>
    </label>
    <label style={fieldStyle}>Runtime 绝对路径（可选）
      <input value={value.cliPath || ''} style={inputStyle} onChange={e => onChange({ cliPath: e.target.value })}
        placeholder="留空使用随包运行时" />
    </label>
    <label style={fieldStyle}>默认工作目录（可选）
      <input value={value.workingDir || ''} style={inputStyle} onChange={e => onChange({ workingDir: e.target.value })}
        placeholder="Session 可指定自己的工作目录" />
    </label>
  </div>
  <p style={hintStyle}>Provider：deepseek-official。模型候选由你维护，账号可用性未确认。访问策略取决于当前平台的 Harness 实现；“不询问”不会放行权限升级。查看或保存配置不启动模型。</p>
  <CodexModelOptionsEditor backendType="deepseek-harness" value={value.modelOptions} onChange={modelOptions => onChange({ modelOptions })} />
</section>;

const hintStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 11, lineHeight: 1.6 };
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 6, color: 'var(--theme-text)', fontSize: 12 };
const inputStyle: React.CSSProperties = { width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '10px 12px', border: '1px solid var(--theme-border)', borderRadius: 6, background: 'var(--theme-input-bg)', color: 'var(--theme-text)', fontFamily: 'inherit' };
