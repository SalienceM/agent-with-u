import React, { useEffect, useRef, useState } from 'react';
import { documentKey, documentStore, type DocumentBuffer, type DocumentClient } from '../utils/documentStore';
import { useWorkspaceLanguages, belongsToLanguage } from '../components/WorkspaceLanguages';
import { applyLanguageTextEdits, languageEditorText, languagePosition, languageRelative, prepareLanguageEdit, validateLanguageEdit, type LanguageEditPlan } from '../utils/languageEdits';
import type { LanguageDiagnostic, LanguageRecord } from '../utils/workspaceLanguages';
import type { EditorDocumentState } from '../utils/editorDocumentState';
import { workbenchButtonStyle } from '../components/WorkbenchChrome';

export interface LanguageEditorBinding {
  complete(offset: number, text: string, signal: AbortSignal): Promise<any[]>;
  execute(action: 'definition' | 'references' | 'rename' | 'format', offset: number): void;
  position(offset: number): void;
  diagnostics: LanguageDiagnostic[];
  valid(text: string): boolean;
}
const buttonStyle = workbenchButtonStyle;

export function useLanguageEditor(buffer: Readonly<DocumentBuffer> | undefined, documents: DocumentClient | undefined,
  navigate: (path: string, line: number, column: number) => void) {
  const context = useWorkspaceLanguages(), current = useRef({ context, buffer, documents });
  current.current = { context, buffer, documents };
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [plan, setPlan] = useState<LanguageEditPlan | null>(null);
  const [locations, setLocations] = useState<{ path: string; line: number; column: number }[]>([]);
  const cursor = useRef(0), cancel = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel.current?.abort(); }; }, []);
  useEffect(() => { setPlan(null); setLocations([]); setMessage(''); cursor.current = 0; cancel.current?.abort(); }, [buffer?.key, context?.client]);
  const row = buffer ? context?.rows.find(r => r.status === 'ready' && belongsToLanguage(buffer, r)) : undefined;
  const active = !!row && !!context?.client && !context.blocked;
  const valid = (doc: Readonly<DocumentBuffer>, service: LanguageRecord) => {
    const latest = documentStore.get(doc.key), value = current.current;
    return !!value.context?.client && !value.context.blocked && value.buffer?.key === doc.key && latest?.revision === doc.revision
      && latest?.lifecycleId === doc.lifecycleId && value.context.rows.some(r => r.resourceId === service.resourceId && r.generation === service.generation && r.status === 'ready');
  };
  const perform = async (action: string, offset: number, signal?: AbortSignal, newName?: string) => {
    const doc = current.current.buffer, ctx = current.current.context;
    const service = doc && ctx?.rows.find(r => r.status === 'ready' && belongsToLanguage(doc, r));
    if (!doc || !service || !ctx?.client || !valid(doc, service)) throw new Error('此文件语义服务未就绪或窗口正在交接');
    if (!service.capabilities[action]) throw new Error(`所选提供器不支持 ${action}`);
    const expected = documentStore.all().filter(d => belongsToLanguage(d, service));
    await ctx.sync(service);
    if (!valid(doc, service)) throw new Error('语义源版本已变化');
    const response = await ctx.client.request(service, action, { relativePath: doc.identity.relativePath, text: doc.text,
      revision: doc.revision, position: languagePosition(languageEditorText(doc.text), offset), ...(newName ? { newName } : {}) }, signal);
    if (!valid(doc, service)) throw new Error('语义结果已过时');
    return { response, doc, service: response.service as LanguageRecord, expected };
  };
  const execute = async (action: 'definition' | 'references' | 'rename' | 'format', offset: number) => {
    if (busy || !active) return;
    if (['rename', 'format'].includes(action) && !current.current.buffer?.read?.editable) return;
    const newName = action === 'rename' ? window.prompt('输入新符号名称；下一步仅预览跨文件修改') : null;
    if (action === 'rename' && !newName) return;
    setBusy(true); setMessage(''); setPlan(null); setLocations([]); cancel.current = new AbortController();
    try {
      const { response, doc, service, expected } = await perform(action, offset, cancel.current.signal, newName || undefined);
      if (action === 'format') {
        const text = applyLanguageTextEdits(doc.text, response.result);
        if (!valid(doc, service)) throw new Error('格式化结果已过时');
        if (text === doc.text) { setMessage('格式已一致，没有修改。'); return; }
        const editor = doc.editor as EditorDocumentState | undefined;
        const updated = editor?.state ? { ...editor, state: editor.state.update({ changes: { from: 0, to: editor.state.doc.length, insert: text } }).state } : undefined;
        documentStore.applyBatch([{ key: doc.key, lifecycleId: doc.lifecycleId, revision: doc.revision, text, editor: updated }]);
        setMessage('格式化已进入草稿，可撤销；尚未保存。');
      } else if (action === 'rename') {
        const client = current.current.documents; if (!client) throw new Error('安全文档接口未就绪');
        // 首轮只发现并安全读取目标。新打开文件先同步，再重新请求；不能把后来读到的字节当作旧结果的基线。
        await prepareLanguageEdit(service, response.result, client, documentStore, expected);
        const second = await perform(action, offset, cancel.current.signal, newName || undefined);
        const prepared = await prepareLanguageEdit(second.service, second.response.result, client, documentStore, second.expected);
        if (prepared.files.some(file => !second.expected.some(d => d.key === file.key))) throw new Error('重构目标集合变化，请重新预览');
        if (!valid(doc, service)) throw new Error('重命名源版本已变化');
        setPlan(prepared);
      } else {
        const items = Array.isArray(response.result) ? response.result : response.result ? [response.result] : [];
        if (items.length > 1000) throw new Error('位置结果超过展示上限');
        const values = items.map((location: any) => {
          const path = languageRelative(service.workspace, location.targetUri || location.uri), range = location.targetSelectionRange || location.range;
          if (!range || !Number.isSafeInteger(range.start?.line) || !Number.isSafeInteger(range.start?.character) || range.start.line < 0 || range.start.character < 0) throw new Error('位置结果无效');
          return { path, line: range.start.line + 1, column: range.start.character + 1 };
        });
        setLocations(values); setMessage(values.length ? `${values.length} 个${action === 'definition' ? '定义' : '引用'}，点击定位当前缓冲区。` : '未找到位置。');
        if (action === 'definition' && values.length === 1) navigate(values[0].path, values[0].line, values[0].column);
      }
    } catch (reason) { if (mounted.current) setMessage(String(reason)); }
    finally { if (mounted.current) setBusy(false); cancel.current = null; }
  };
  const diagnostics = row ? context?.diagnostics[row.resourceId] || [] : [];
  const validDiagnostics = diagnostics.filter(d => {
    const doc = row && documentStore.get(documentKey({ workspace: row.workspace, source: 'executor', relativePath: d.relativePath }));
    return d.freshness === 'current' && doc?.revision === d.revision;
  });
  const currentDiagnostics = validDiagnostics.find(d => buffer && documentKey({ ...buffer.identity, relativePath: d.relativePath }) === buffer.key)?.items || [];
  const binding: LanguageEditorBinding | undefined = active ? {
    diagnostics: currentDiagnostics,
    valid: text => !!buffer && !!row && valid(buffer, row) && text === languageEditorText(buffer.text),
    position: offset => { cursor.current = offset; },
    execute: (action, offset) => { void execute(action, offset); },
    complete: async (offset, text, signal) => {
      if (!current.current.buffer || text !== languageEditorText(current.current.buffer.text)) return [];
      try {
        const { response } = await perform('completion', offset, signal);
        const items = Array.isArray(response.result) ? response.result : response.result?.items;
        if (!Array.isArray(items)) return [];
        return items.filter(item => typeof item.label === 'string' && item.label.length <= 512 && item.insertTextFormat !== 2
          && !item.additionalTextEdits?.length && !item.command).slice(0, 200);
      } catch (reason) { if (!signal.aborted && mounted.current) setMessage(String(reason)); return []; }
    },
  } : undefined;
  const panel = buffer?.identity.source === 'executor' && (row || message || busy || plan || locations.length > 0) && <div style={{ fontSize: 12, padding: '4px 8px', borderBottom: '1px solid var(--theme-border)', maxHeight: '38vh', overflow: 'auto', flexShrink: 0 }}>
    <span style={{ color: 'var(--theme-text-muted)', fontSize: 11 }}>{row ? `${row.provider} 语义就绪` : '基础编辑 · 工程语义可在顶部语言服务中配置'}</span>{' '}
    {row && (['definition', 'references', 'rename', 'format'] as const).map((action, i) => <button key={action} className="awu-wb-control" style={buttonStyle}
      disabled={!active || busy || !row?.capabilities[action] || ['rename', 'format'].includes(action) && !buffer.read?.editable} onClick={() => void execute(action, cursor.current)}>{['定义 F12', '引用 ⇧F12', '重命名 F2', '格式化 ⇧Alt+F'][i]}</button>)}
    {busy && <button style={buttonStyle} onClick={() => cancel.current?.abort()}>取消语义请求</button>}
    {message && <div role="status">{message}</div>}
    {locations.length > 0 && <details open><summary>位置结果</summary>{locations.map((loc, i) => <button key={i} style={buttonStyle} onClick={() => navigate(loc.path, loc.line, loc.column)}>{loc.path}:{loc.line}:{loc.column}</button>)}</details>}
    {row && <details><summary>问题 · {validDiagnostics.reduce((n, d) => n + d.items.length, 0)}（仅当前版本；无诊断不等于项目通过）</summary>
      {!validDiagnostics.length && <p>尚未收到当前版本诊断，或服务正在分析。</p>}
      {[...validDiagnostics].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map(d => <div key={d.relativePath}><strong>{d.relativePath}</strong>
        {[...d.items].sort((a, b) => a.severity - b.severity).map((item, i) => <button key={i} style={{ ...buttonStyle, display: 'block', textAlign: 'left' }} onClick={() => navigate(d.relativePath, item.range.start.line + 1, item.range.start.character + 1)}>
          {item.severity === 1 ? '错误' : item.severity === 2 ? '警告' : '信息'} · {item.range.start.line + 1} · {item.message}</button>)}{d.truncated && <span>诊断达到上限，结果不完整。</span>}</div>)}
    </details>}
    {plan && <div role="dialog" aria-label="跨文件重命名预览"><p>{plan.files.length} 个文件。应用前整体重新核对磁盘及缓冲区；只改草稿，不自动保存。</p>
      {plan.files.map(file => <details key={file.key}><summary>{file.path}</summary><div style={{ display: 'flex', gap: 8 }}>
        <pre aria-label="修改前" style={{ flex: 1, overflow: 'auto', background: '#7f1d1d22', maxHeight: 220 }}>{file.before.slice(0, 200000)}</pre>
        <pre aria-label="修改后" style={{ flex: 1, overflow: 'auto', background: '#16653422', maxHeight: 220 }}>{file.after.slice(0, 200000)}</pre>
      </div>{Math.max(file.before.length, file.after.length) > 200000 && <p>预览仅展示前 200000 字符；请减少重构范围后再核验。</p>}</details>)}
      <button style={buttonStyle} disabled={busy || !active || plan.files.some(f => Math.max(f.before.length, f.after.length) > 200000)} onClick={() => {
        const client = current.current.documents; if (!client) return; setBusy(true);
        const isCurrent = () => !!current.current.context && !current.current.context.blocked && current.current.context.rows.some(r => r.resourceId === plan.service.resourceId && r.generation === plan.service.generation && r.status === 'ready');
        void validateLanguageEdit(plan, client, documentStore, isCurrent).then(() => {
          const changes = plan.files.map(file => {
            const editor = documentStore.get(file.key)?.editor as EditorDocumentState | undefined;
            return { key: file.key, lifecycleId: file.lifecycleId, revision: file.revision, text: file.after,
              editor: editor?.state ? { ...editor, state: editor.state.update({ changes: { from: 0, to: editor.state.doc.length, insert: file.after } }).state } : undefined };
          });
          documentStore.applyBatch(changes); setPlan(null); setMessage('全部目标已进入可撤销草稿；请使用保存 / 保存全部，结果逐文件核对。');
        }).catch(reason => { setPlan(null); setMessage(String(reason)); }).finally(() => setBusy(false));
      }}>确认应用到全部草稿</button><button style={buttonStyle} onClick={() => setPlan(null)}>取消重命名</button>
    </div>}
  </div>;
  return { binding, panel };
}
