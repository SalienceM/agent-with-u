import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentClient } from '../utils/documentStore';
import { documentStore } from '../utils/documentStore';
import { documentDrafts, type StoredDocumentDraft } from '../utils/documentDrafts';
import type { EditorDocumentState } from '../utils/editorDocumentState';
import type { DocumentPreview } from '../utils/documentPreview';
import { extOf } from '../utils/documentPreview';
import { exportGeneratedText } from './FileTreePanel';
import { documentKey } from '../utils/documentStore';
import { markdownToHtml } from '../utils/markdown';
import { buildStandaloneMarkdownHtml, markdownHtmlFilename } from '../utils/markdownExport';
import { previewToolbarButtonStyle as button, previewSegmentStyle, previewSegmentActiveStyle } from './FilePreviewToolbar';
import { WorkbenchOverflow } from './WorkbenchChrome';

const CodeEditor = lazy(() => import('./CodeEditor'));

/** 与主窗口共用文档缓冲、草稿、CodeMirror 和有版本保存协议。 */
export const DetachedTextDocument: React.FC<{
  preview: DocumentPreview; dark: boolean; client: () => Promise<DocumentClient>;
  renderPreview: (text: string) => React.ReactNode;
  onSaved: () => void;
  initialView?: 'preview' | 'source' | 'split';
  toolbarHost?: HTMLElement | null;
  onDocumentState?: (state: { dirty: boolean; editing: boolean }) => void;
}> = ({ preview, dark, client: connect, renderPreview, onSaved, initialView = 'preview', toolbarHost, onDocumentState }) => {
  const [view, setView] = useState<'preview' | 'source' | 'split'>(initialView);
  const [editing, setEditing] = useState(initialView !== 'preview');
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [choices, setChoices] = useState<StoredDocumentDraft[]>([]);
  const [, update] = useState(0);
  const client = useRef<DocumentClient>();
  const alive = useRef(true);
  const docRef = useRef<ReturnType<typeof documentStore.get>>();
  const doc = key ? documentStore.get(key) : undefined;
  docRef.current = doc;
  const pending = !!doc?.save && !['succeeded', 'failed'].includes(doc.save.receipt?.status || '');
  useEffect(() => documentStore.subscribe(() => update(value => value + 1)), []);
  useEffect(() => { onDocumentState?.({ dirty: !!doc?.dirty, editing }); }, [doc?.dirty, editing, onDocumentState]);
  useEffect(() => () => { onDocumentState?.({ dirty: false, editing: false }); }, [onDocumentState]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const beforeClose = (event: BeforeUnloadEvent) => {
      const current = docRef.current;
      if (current?.dirty || current?.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeClose);
    const guard = (event: Event) => {
      const current = docRef.current;
      if (current?.dirty || current?.save && !['succeeded', 'failed'].includes(current.save.receipt?.status || '')) {
        event.preventDefault(); setNotice('文档存在未保存改动或待核对保存，请先保存、导出或明确放弃草稿。');
      }
    };
    window.addEventListener('awu-preview-before-navigate', guard);
    return () => { window.removeEventListener('beforeunload', beforeClose); window.removeEventListener('awu-preview-before-navigate', guard); };
  }, []);
  const open = async (next: 'source' | 'split', edit = editing) => {
    if (loading) return;
    if (doc) { setView(next); setEditing(edit && !!doc.read?.editable); return; }
    setLoading(true); setNotice('');
    try {
      const connected = await connect();
      const existingKey = documentKey({ workspace: connected.identity, source: connected.source || 'executor', relativePath: preview.rel });
      const existing = documentStore.get(existingKey);
      if (existing && !existing.dirty && (!existing.save || ['succeeded', 'failed'].includes(existing.save.receipt?.status || ''))) {
        await documentStore.open(connected, preview.rel, true);
      }
      const loaded = await documentDrafts.open(connected, preview.rel);
      if (!alive.current) return;
      client.current = connected; setKey(loaded.document.key); setChoices(loaded.choices); setView(next); setEditing(edit && !!loaded.document.read?.editable);
      if (!loaded.document.read?.editable) setNotice(loaded.document.read?.reasonCode === 'remote_readonly'
        ? '远端文件按现有规则只读。请在原窗口打开本机副本，再分离窗口编辑。' : `只读：${loaded.document.read?.reasonCode || '完整性未确认'}。`);
    } catch (error) { if (alive.current) setNotice(`无法打开编辑器：${String(error)}`); }
    finally { if (alive.current) setLoading(false); }
  };
  const save = async () => {
    if (!doc || !client.current || saving) return;
    setSaving(true); setNotice('');
    try {
      const receipt = pending ? await documentStore.reconcile(client.current, doc.key) : await documentStore.save(client.current, doc.key);
      if (!alive.current) return;
      setNotice(receipt.status === 'succeeded' ? '已保存到原文件。'
        : receipt.status === 'failed' ? `保存失败：${receipt.reasonCode}，草稿已保留。` : '保存结果未确认，请核对保存。');
      if (receipt.status === 'succeeded') onSaved();
    } catch (error) { if (alive.current) setNotice(`保存未完成：${String(error)}；草稿已保留。`); }
    finally { if (alive.current) setSaving(false); }
  };
  useEffect(() => {
    if (initialView !== 'preview') void open(initialView, true);
  }, []);
  const text = doc?.text ?? preview.text ?? '';
  const editor = <Suspense fallback={<p role="status">加载编辑器…</p>}>
    <CodeEditor key={doc?.lifecycleId} documentKey={doc?.key} value={text} ext={extOf(preview.name)} dark={dark} height="100%"
      readOnly={!editing || !doc?.read?.editable || saving} editorState={doc?.editor as EditorDocumentState | undefined}
      onEditorState={state => { if (doc) documentStore.editorState(doc.key, state, doc.lifecycleId); }}
      onChange={value => { if (doc) documentStore.edit(doc.key, value); }} onSave={() => void save()} />
  </Suspense>;
  const toolbar = <>
      {preview.isMarkdown && !editing && <button style={{ ...button, borderColor: 'rgba(63,185,80,.38)' }} disabled={!doc && preview.truncated} onClick={() => void exportGeneratedText(
        buildStandaloneMarkdownHtml(preview.name, markdownToHtml(text)), markdownHtmlFilename(preview.name), 'text/html;charset=utf-8',
      ).then(result => setNotice(result.mode === 'cancelled' ? '已取消导出' : 'HTML 已导出。')).catch(error => setNotice(String(error)))}>⇩ HTML 另存为</button>}
      <div role="group" aria-label="文档显示方式" style={{ display: 'flex', flexShrink: 0, border: '1px solid var(--theme-border)', borderRadius: 6, overflow: 'hidden', marginRight: 4 }}>
        <button style={{ ...previewSegmentStyle, ...(view === 'preview' ? previewSegmentActiveStyle : {}) }} aria-pressed={view === 'preview'}
          onClick={() => { setView('preview'); setEditing(false); }}>{preview.isHtml ? '🌐 页面' : '👁 预览'}</button>
        <button style={{ ...previewSegmentStyle, ...(view === 'source' ? previewSegmentActiveStyle : {}) }} disabled={loading}
          aria-pressed={view === 'source'} onClick={() => void open('source')}>{loading ? '完整读取中…' : '</> 源码'}</button>
        {doc && (preview.isHtml || preview.isMarkdown) && <button style={{ ...previewSegmentStyle, ...(view === 'split' ? previewSegmentActiveStyle : {}) }}
          aria-pressed={view === 'split'} onClick={() => void open('split')}>并排</button>}
      </div>
      {!editing && (!doc || doc.read?.editable) && <button style={button} disabled={loading} onClick={() => void open('source', true)}>✏️ 编辑</button>}
      {doc && <>
        <button style={{ ...button, ...(doc.dirty ? { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)' } : {}) }}
          disabled={saving || !pending && (!doc.dirty || !doc.read?.canSave)} onClick={() => void save()}>{saving ? '保存中…' : pending ? '核对保存' : '💾 保存'}</button>
        <WorkbenchOverflow enabled label="文件与草稿操作">
        <button style={button} onClick={() => void exportGeneratedText(text, `${preview.name}.draft.txt`, 'text/plain;charset=utf-8').catch(error => setNotice(String(error)))}>导出草稿</button>
        <button style={button} disabled={saving || pending} onClick={() => void documentStore.open(client.current!, preview.rel, true)
          .then(() => setNotice('已读取最新磁盘版本；未修改当前草稿。')).catch(error => setNotice(String(error)))}>比较磁盘版本</button>
        <button style={button} disabled={saving || pending} onClick={async () => {
          if (doc.dirty && !window.confirm('放弃此窗口未保存的草稿并重新读取原文件？')) return;
          try {
            await documentDrafts.discard(doc.key);
            await documentStore.open(client.current!, preview.rel, true);
            setChoices([]); setNotice('已重新读取原文件。');
          } catch (error) { setNotice(String(error)); }
        }}>重新读取 / 放弃草稿</button>
        </WorkbenchOverflow>
      </>}
    </>;
  return <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbarHost === undefined
      ? <div style={{ display: 'flex', gap: 8, padding: '6px 12px', overflowX: 'auto' }}>{toolbar}</div> : null}
    {choices.length > 0 && <div style={{ padding: 8, fontSize: 12 }}>发现其他窗口的草稿：{choices.map(choice => <button key={choice.id} style={button} onClick={() => {
      if (!doc) return;
      void documentDrafts.restore(doc.key, choice, () => alive.current).then(() => setChoices([])).catch(error => setNotice(String(error)));
    }}>恢复 {new Date(choice.updatedAt).toLocaleString()}</button>)}</div>}
    {notice && <div role="status" style={{ padding: '6px 12px', fontSize: 12, color: 'var(--theme-text-muted)' }}>{notice}</div>}
    {doc?.disk?.version && <details open style={{ padding: 8, fontSize: 12, maxHeight: '40vh', overflow: 'auto' }}>
      <summary>磁盘版本与当前草稿</summary>
      <div style={{ display: 'flex', gap: 8 }}>
        <pre style={{ flex: 1, minWidth: 0, overflow: 'auto', maxHeight: 180 }}>{doc.disk.text}</pre>
        <pre style={{ flex: 1, minWidth: 0, overflow: 'auto', maxHeight: 180 }}>{doc.text}</pre>
      </div>
      <button style={button} disabled={saving || pending || !doc.disk.editable || !doc.disk.complete} onClick={() => {
        documentStore.merge(doc.key, doc.disk!.version!, doc.revision, doc.text);
        setNotice('已将当前编辑内容作为合并结果；请检查后点击保存。');
      }}>以当前编辑内容为合并结果</button>
      <button style={button} disabled={saving || pending || !doc.disk.editable || !doc.disk.complete} onClick={() => {
        documentStore.merge(doc.key, doc.disk!.version!, doc.revision, doc.disk!.text);
        setNotice('已采用磁盘内容；未写入文件。');
      }}>采用磁盘内容</button>
    </details>}
    {doc && (view !== 'preview' || doc.dirty || pending) && <div role="status" style={{ padding: '4px 12px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
      {doc.read?.editable ? doc.dirty ? '● 未保存' : '已与原文件保存版本同步' : `只读：${doc.read?.reasonCode || '不支持编辑'}`}
      {doc.dirty && ` · 草稿${doc.persistence === 'saved' ? '已存本设备' : doc.persistence === 'failed' ? '持久化失败，请导出' : '保存中'}`}
      {doc.error && ` · ${doc.error}`}
    </div>}
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {view !== 'preview' && <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{editor}</div>}
      {view !== 'source' && <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>{renderPreview(text)}</div>}
    </div>
  </div>;
};
