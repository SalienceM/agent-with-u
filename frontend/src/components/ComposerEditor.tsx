import { WorkflowButton, workflowHeaderStyle, workflowNavStyle, workflowDialogStyle, workflowFieldStyle } from './WorkflowControls';
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, selectAll } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { composerDrafts } from '../utils/composerDrafts';
import { AppModalPortal } from './AppModalPortal';

interface Props { scope: string; onChange: () => void; onClose: () => void; onSend: () => void; menu?: React.ReactNode; onInput?: () => void; onMenuKey?: (event: KeyboardEvent) => void }
export const ComposerTransformUndo: React.FC<{ scope: string; onChange: () => void }> = ({ scope, onChange }) => {
  useSyncExternalStore(composerDrafts.subscribe, composerDrafts.snapshot);
  if (!composerDrafts.canUndoTransform(scope)) return null;
  return <WorkflowButton onClick={() => { if (composerDrafts.undoTransform(scope)) onChange(); }}>撤销文本收纳 / 恢复</WorkflowButton>;
};
export const ComposerEditor: React.FC<Props> = ({ scope, onChange, onClose, onSend, menu, onInput, onMenuKey }) => {
  useSyncExternalStore(composerDrafts.subscribe, composerDrafts.snapshot);
  const draft = composerDrafts.ensure(scope), block = draft.textAttachments.find(x => x.id === draft.activeBlock);
  const active = block?.id || 'main', content = block?.content ?? draft.text;
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDivElement>(null), view = useRef<EditorView>();
  const callbacks = useRef({ onChange, onClose, onSend, onInput, onMenuKey }); callbacks.current = { onChange, onClose, onSend, onInput, onMenuKey };
  const writing = useRef(false);
  useEffect(() => {
    const selection = composerDrafts.ensure(scope).selections[active];
    const editor = new EditorView({ parent: host.current!, state: EditorState.create({ doc: content,
      selection: { anchor: Math.min(content.length, selection?.start || 0), head: Math.min(content.length, selection?.end || 0) }, extensions: [
        EditorView.domEventHandlers({ keydown: (event, editor) => {
          if (event.isComposing || editor.composing || event.keyCode === 229 || active !== 'main') return false;
          callbacks.current.onChange(); // 将当前选择同步到共享主输入，再派发同一菜单规则。
          callbacks.current.onMenuKey?.(event);
          return event.defaultPrevented;
        } }),
        EditorView.lineWrapping, search(), keymap.of([
          { key: 'Mod-Enter', run: () => { if (view.current?.composing) return false; callbacks.current.onSend(); return true; } },
          { key: 'Mod-z', run: () => { const ok = composerDrafts.undo(scope, active); if (ok) callbacks.current.onChange(); return ok; } },
          { key: 'Mod-Shift-z', run: () => { const ok = composerDrafts.undo(scope, active, true); if (ok) callbacks.current.onChange(); return ok; } },
          { key: 'Mod-y', run: () => { const ok = composerDrafts.undo(scope, active, true); if (ok) callbacks.current.onChange(); return ok; } },
          ...searchKeymap, ...defaultKeymap,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': block ? `编辑文本块 ${block.name}` : '编辑主消息', role: 'textbox', 'aria-multiline': 'true' }),
        EditorView.theme({ '&': { height: '100%', fontSize: '14px', background: 'var(--theme-bg, #fff)', color: 'var(--theme-text, #222)' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' }, '.cm-content': { minHeight: '220px' }, '.cm-cursor': { borderLeftColor: 'var(--theme-text, #222)' } }),
        EditorView.updateListener.of(update => {
          const sel = update.state.selection.main;
          composerDrafts.select(scope, active, { start: sel.from, end: sel.to, scrollTop: update.view.scrollDOM.scrollTop });
          if (update.docChanged && !writing.current) { composerDrafts.edit(scope, active, update.state.doc.toString()); callbacks.current.onChange(); if (active === 'main') callbacks.current.onInput?.(); }
        }),
      ] }) });
    view.current = editor;
    editor.scrollDOM.scrollTop = selection?.scrollTop || 0; editor.focus();
    return () => {
      const sel = editor.state.selection.main;
      composerDrafts.select(scope, active, { start: sel.from, end: sel.to, scrollTop: editor.scrollDOM.scrollTop });
      editor.destroy(); view.current = undefined;
    };
  }, [scope, active]);
  useEffect(() => {
    const editor = view.current; if (!editor || editor.state.doc.toString() === content) return;
    writing.current = true;
    const selection = composerDrafts.ensure(scope).selections[active];
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: content },
      selection: { anchor: Math.min(content.length, selection?.start || 0), head: Math.min(content.length, selection?.end || 0) } });
    writing.current = false;
    editor.focus();
  }, [content]);
  const change = (action: () => void) => { action(); onChange(); };
  return <AppModalPortal><div style={{ position: 'fixed', inset: 0, zIndex: 31000, background: '#0008', display: 'grid', placeItems: 'center', padding: 12 }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="展开编辑消息" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.defaultPrevented || view.current?.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, [contenteditable=true]')];
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} style={{ ...workflowDialogStyle, width: 'min(100%, 1000px)', height: 'min(85vh, 720px)', display: 'flex', flexDirection: 'column', background: 'var(--theme-bg-secondary, #fff)', color: 'var(--theme-text, #222)', borderRadius: 16, overflow: 'hidden' }}>
      <header style={workflowHeaderStyle}>
        <strong style={{ flex: 1 }}>编辑消息</strong>
        <WorkflowButton onClick={() => view.current && openSearchPanel(view.current)}>查找</WorkflowButton>
        <WorkflowButton onClick={() => view.current && selectAll(view.current)}>全选</WorkflowButton>
        <WorkflowButton onClick={onClose}>返回输入框</WorkflowButton>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav aria-label="消息文本块" style={{ ...workflowNavStyle, flex: '0 0 clamp(100px, 24%, 210px)', overflow: 'auto', borderRight: '1px solid var(--theme-border, #ddd)', padding: 6 }}>
          {[{ id: 'main', name: '主消息' }, ...draft.textAttachments].map((item, index) => <WorkflowButton tone="quiet" key={item.id} aria-pressed={active === item.id}
            onClick={() => composerDrafts.activate(scope, item.id)} style={{ display: 'block', width: '100%', padding: 8, marginBottom: 4, overflowWrap: 'anywhere' }}>{index || ''} {item.name}</WorkflowButton>)}
        </nav>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {block && <div style={{ padding: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <input aria-label="文本块名称" value={block.name} style={{ ...workflowFieldStyle, minWidth: 0 }} onChange={e => change(() => composerDrafts.rename(scope, active, e.target.value))} />
            <WorkflowButton onClick={() => change(() => composerDrafts.move(scope, active, -1))}>上移</WorkflowButton>
            <WorkflowButton onClick={() => change(() => composerDrafts.move(scope, active, 1))}>下移</WorkflowButton>
            <WorkflowButton onClick={() => change(() => composerDrafts.restore(scope, active))}>恢复到正文光标</WorkflowButton>
          </div>}
          <div style={{ position: 'relative', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
            {active === 'main' && <div style={{ position: 'absolute', top: 240, left: 0, right: 0 }}>{menu}</div>}
          </div>
        </div>
      </div>
      <footer style={{ padding: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <WorkflowButton onClick={() => change(() => composerDrafts.undo(scope, active))}>撤销本块</WorkflowButton>
        <WorkflowButton onClick={() => change(() => composerDrafts.undo(scope, active, true))}>重做本块</WorkflowButton>
        <span style={{ flex: 1, fontSize: 11 }}>Enter 换行 · Ctrl/⌘+Enter 发送 · {draft.textAttachments.length} 个文本块 / {draft.images.length} 张图片</span>
        <WorkflowButton tone="primary" onClick={onSend}>发送当前消息</WorkflowButton>
      </footer>
    </div>
  </div></AppModalPortal>;
};
