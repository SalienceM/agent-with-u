import { WorkflowButton, WorkflowIcon, workflowHeaderStyle, workflowDialogStyle, workflowFieldStyle } from './WorkflowControls';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder, drawSelection } from '@codemirror/view';
import { defaultKeymap, selectAll } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { composerDrafts } from '../utils/composerDrafts';
import { usePreviewViewport } from '../hooks/usePreviewLayout';
import { AppModalPortal } from './AppModalPortal';
import { ComposerPreview } from './ComposerPreview';

interface Props { scope: string; onChange: () => void; onClose: () => void; onSend: () => void; menu?: React.ReactNode; onInput?: () => void; onMenuKey?: (event: KeyboardEvent) => void }
type EditorMode = 'edit' | 'split' | 'preview';
const surface = 'var(--theme-panel-solid, #fff)';
const border = '1px solid var(--theme-border, #dce1e8)';
const muted = 'var(--theme-text-muted, #687487)';
const modes: { id: EditorMode; label: string }[] = [{ id: 'edit', label: '编辑' }, { id: 'split', label: '对照' }, { id: 'preview', label: '预览' }];
const paperStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: '1 1 0', minWidth: 0, minHeight: 0, border, borderRadius: 10, overflow: 'hidden', background: surface, boxShadow: '0 2px 8px #00000008' };
const paperHeaderStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 18px', borderBottom: border, fontSize: 12, flexShrink: 0 };

export const ComposerTransformUndo: React.FC<{ scope: string; onChange: () => void }> = ({ scope, onChange }) => {
  useSyncExternalStore(composerDrafts.subscribe, composerDrafts.snapshot);
  if (!composerDrafts.canUndoTransform(scope)) return null;
  return <WorkflowButton onClick={() => { if (composerDrafts.undoTransform(scope)) onChange(); }}>撤销文本收纳 / 恢复</WorkflowButton>;
};
export const ComposerEditor: React.FC<Props> = ({ scope, onChange, onClose, onSend, menu, onInput, onMenuKey }) => {
  useSyncExternalStore(composerDrafts.subscribe, composerDrafts.snapshot);
  const draft = composerDrafts.ensure(scope), block = draft.textAttachments.find(x => x.id === draft.activeBlock);
  const active = block?.id || 'main', content = block?.content ?? draft.text;
  const viewport = usePreviewViewport(true), narrow = viewport.width < 760;
  const [mode, setMode] = useState<EditorMode>('edit');
  const [fontSize, setFontSize] = useState(16);
  const visibleMode = narrow && mode === 'split' ? 'edit' : mode;
  const modeRef = useRef(visibleMode); modeRef.current = visibleMode;
  const host = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDivElement>(null), view = useRef<EditorView>();
  const typography = useRef(new Compartment());
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
        EditorView.lineWrapping, drawSelection(), markdown(), placeholder('在这里整理你的想法…'), search(), keymap.of([
          { key: 'Mod-Enter', run: () => { if (view.current?.composing) return false; callbacks.current.onSend(); return true; } },
          { key: 'Mod-z', run: () => { const ok = composerDrafts.undo(scope, active); if (ok) callbacks.current.onChange(); return ok; } },
          { key: 'Mod-Shift-z', run: () => { const ok = composerDrafts.undo(scope, active, true); if (ok) callbacks.current.onChange(); return ok; } },
          { key: 'Mod-y', run: () => { const ok = composerDrafts.undo(scope, active, true); if (ok) callbacks.current.onChange(); return ok; } },
          ...searchKeymap, ...defaultKeymap,
        ]),
        EditorView.contentAttributes.of({ 'aria-label': block ? `编辑文本块 ${block.name}` : '编辑主消息', role: 'textbox', 'aria-multiline': 'true' }),
        typography.current.of(EditorView.theme({ '&': { fontSize: `${fontSize}px` } })),
        EditorView.theme({
          '&': { height: '100%', background: surface, color: 'var(--theme-text, #273244)', fontWeight: '400' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.9', overscrollBehavior: 'contain' },
          '.cm-content': { minHeight: '100%', maxWidth: '800px', width: '100%', margin: '0 auto', padding: '24px clamp(16px, 3vw, 36px) 80px', boxSizing: 'border-box', caretColor: 'var(--theme-accent, #4b82f0)' },
          '.cm-line': { padding: '0' },
          '.cm-cursor': { borderLeftColor: 'var(--theme-accent, #4b82f0)', borderLeftWidth: '2px' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { background: 'var(--theme-accent-bg, #4b82f030)' },
          '.cm-placeholder': { color: muted },
          '.cm-panels': { background: surface, color: 'var(--theme-text, #273244)', borderColor: 'var(--theme-border, #dce1e8)' },
          '.cm-search': { padding: '8px', fontFamily: 'inherit', fontSize: '12px' },
          '.cm-textfield, .cm-button': { background: surface, color: 'inherit', border, borderRadius: '5px' },
          '.cm-searchMatch': { background: '#e6b33c50' }, '.cm-searchMatch-selected': { background: '#e6b33c90' },
        }),
        EditorView.updateListener.of(update => {
          const sel = update.state.selection.main;
          composerDrafts.select(scope, active, { start: sel.from, end: sel.to, scrollTop: update.view.scrollDOM.scrollTop });
          if (update.docChanged && !writing.current) { composerDrafts.edit(scope, active, update.state.doc.toString()); callbacks.current.onChange(); if (active === 'main') callbacks.current.onInput?.(); }
        }),
      ] }) });
    view.current = editor;
    editor.scrollDOM.scrollTop = selection?.scrollTop || 0;
    if (modeRef.current !== 'preview') {
      editor.focus();
      editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.selection.main.head, { y: 'nearest', yMargin: 24 }) });
    }
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
    if (modeRef.current !== 'preview') editor.focus();
  }, [content]);
  useEffect(() => { view.current?.dispatch({ effects: typography.current.reconfigure(EditorView.theme({ '&': { fontSize: `${fontSize}px` } })) }); }, [fontSize]);
  useEffect(() => { if (visibleMode !== 'preview') view.current?.requestMeasure(); }, [visibleMode]);
  const change = (action: () => void) => { action(); onChange(); };
  const format = (kind: 'heading' | 'bold' | 'list' | 'quote') => {
    const editor = view.current; if (!editor || editor.composing) return;
    const { from, to } = editor.state.selection.main;
    const selected = editor.state.sliceDoc(from, to);
    if (kind === 'bold') {
      const text = selected || '重点内容';
      editor.dispatch({ changes: { from, to, insert: `**${text}**` }, selection: { anchor: from + 2, head: from + 2 + text.length }, scrollIntoView: true });
    } else {
      const start = editor.state.doc.lineAt(from).from;
      const end = editor.state.doc.lineAt(to > from && editor.state.doc.lineAt(to).from === to ? to - 1 : to).to;
      const prefix = kind === 'heading' ? '## ' : kind === 'list' ? '- ' : '> ';
      const text = editor.state.sliceDoc(start, end).split('\n').map(line => prefix + line).join('\n');
      editor.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length }, scrollIntoView: true });
    }
    editor.focus();
  };
  const paneTitle = block?.name || '主消息';
  return <AppModalPortal><div style={{ position: 'fixed', left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height, zIndex: 31000, background: '#0009', backdropFilter: 'blur(5px)', display: 'grid', placeItems: 'center', padding: narrow ? 0 : 24, boxSizing: 'border-box' }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="展开编辑消息" onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.defaultPrevented || view.current?.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const targets = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, [contenteditable=true], [tabindex="0"]')].filter(el => el.getClientRects().length > 0 && el.tabIndex >= 0);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} style={{ ...workflowDialogStyle, boxSizing: 'border-box', width: 'min(100%, 1200px)', height: narrow ? '100%' : 'min(90dvh, 900px)', maxHeight: '100%', display: 'flex', flexDirection: 'column', background: surface, color: 'var(--theme-text, #273244)', borderRadius: narrow ? 0 : 16, overflow: 'hidden', isolation: 'isolate' }}>
      <header style={{ ...workflowHeaderStyle, padding: narrow ? '12px 14px' : '16px 22px', flexWrap: 'nowrap' }}>
        {!narrow && <span style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 10, background: 'var(--theme-accent-bg, #4b82f014)', color: 'var(--theme-accent, #4b82f0)' }}><WorkflowIcon name="block" size={20} /></span>}
        <div style={{ flex: 1, minWidth: 0 }}><strong style={{ fontSize: 16 }}>编辑消息</strong><div style={{ fontSize: 11, color: muted }}>修改实时保留在草稿中</div></div>
        <WorkflowButton onClick={onClose}>返回输入框</WorkflowButton>
      </header>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: narrow ? '8px 12px' : '10px 22px', borderBottom: border, flexShrink: 0, flexWrap: 'wrap' }}>
        <div role="group" aria-label="编辑视图" style={{ display: 'flex', padding: 3, gap: 2, border, borderRadius: 9 }}>
          {modes.filter(item => !narrow || item.id !== 'split').map(item => <WorkflowButton key={item.id} tone="quiet" aria-pressed={visibleMode === item.id} onClick={() => setMode(item.id)} style={{ minWidth: narrow ? 58 : 64, borderRadius: 6 }}>{item.label}</WorkflowButton>)}
        </div>
        <div style={{ flex: 1 }} />
        {visibleMode !== 'preview' && <><WorkflowButton tone="quiet" onClick={() => view.current && openSearchPanel(view.current)}>查找</WorkflowButton><WorkflowButton tone="quiet" onClick={() => { if (view.current) { selectAll(view.current); view.current.focus(); } }}>全选</WorkflowButton></>}
        {!narrow && <div role="group" aria-label="正文字号" style={{ display: 'flex', alignItems: 'center', borderLeft: border, paddingLeft: 8 }}>
          <WorkflowButton tone="quiet" aria-label="缩小字号" disabled={fontSize <= 14} onClick={() => setFontSize(size => size - 1)}>A−</WorkflowButton>
          <span style={{ fontSize: 11, color: muted, minWidth: 28, textAlign: 'center' }}>{fontSize}</span>
          <WorkflowButton tone="quiet" aria-label="放大字号" disabled={fontSize >= 22} onClick={() => setFontSize(size => size + 1)}>A＋</WorkflowButton>
        </div>}
      </div>
      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', flex: 1, minHeight: 0 }}>
        {draft.textAttachments.length > 0 && <nav aria-label="消息文本块" style={{ flex: narrow ? '0 0 auto' : '0 0 180px', minHeight: 0, overflow: 'auto', borderRight: narrow ? undefined : border, borderBottom: narrow ? border : undefined, padding: narrow ? 8 : 12, display: 'flex', flexDirection: narrow ? 'row' : 'column', gap: 4 }}>
          {!narrow && <span style={{ fontSize: 11, color: muted, padding: '4px 8px 8px' }}>消息内容 · {draft.textAttachments.length + 1}</span>}
          {[{ id: 'main', name: '主消息' }, ...draft.textAttachments].map((item, index) => <WorkflowButton tone="quiet" key={item.id} aria-pressed={active === item.id}
            onClick={() => composerDrafts.activate(scope, item.id)} style={{ display: 'block', textAlign: 'left', padding: '9px 10px', flexShrink: 0, whiteSpace: narrow ? 'nowrap' : 'normal', overflowWrap: 'anywhere' }}>{index || ''} {item.name}</WorkflowButton>)}
        </nav>}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--theme-accent-bg, #4b82f008)' }}>
          {block && <div style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', flexShrink: 0 }}>
            <input aria-label="文本块名称" value={block.name} style={{ ...workflowFieldStyle, width: narrow ? '100%' : 200, marginTop: 0, minWidth: 0, background: surface }} onChange={e => change(() => composerDrafts.rename(scope, active, e.target.value))} />
            <WorkflowButton onClick={() => change(() => composerDrafts.move(scope, active, -1))}>上移</WorkflowButton>
            <WorkflowButton onClick={() => change(() => composerDrafts.move(scope, active, 1))}>下移</WorkflowButton>
            <WorkflowButton onClick={() => change(() => composerDrafts.restore(scope, active))}>恢复到正文光标</WorkflowButton>
          </div>}
          <div style={{ display: 'flex', gap: 14, padding: narrow ? 10 : 18, flex: 1, minHeight: 0, minWidth: 0, fontSize }}>
            {/* 切换预览只隐藏编辑器，保留选区、滚动位置和共享撤销栈。 */}
            <section aria-label="消息编辑区" style={{ ...paperStyle, display: visibleMode === 'preview' ? 'none' : 'flex' }}>
              <div style={paperHeaderStyle}><strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{paneTitle}</strong><span style={{ fontSize: 10, color: muted }}>Markdown</span></div>
              <div role="toolbar" aria-label="文本格式" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 10px', borderBottom: border, flexShrink: 0 }}>
                <WorkflowButton tone="quiet" aria-label="插入标题" title="标题" onClick={() => format('heading')}>H₂</WorkflowButton>
                <WorkflowButton tone="quiet" aria-label="加粗" title="加粗选中文字" onClick={() => format('bold')} style={{ fontWeight: 700 }}>B</WorkflowButton>
                <WorkflowButton tone="quiet" aria-label="插入列表" onClick={() => format('list')}>列表</WorkflowButton>
                <WorkflowButton tone="quiet" aria-label="插入引用" onClick={() => format('quote')}>引用</WorkflowButton>
              </div>
              <div style={{ position: 'relative', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
                {active === 'main' && <div style={{ position: 'absolute', top: 'min(240px, 60%)', left: 0, right: 0, zIndex: 2 }}>{menu}</div>}
              </div>
            </section>
            {visibleMode !== 'edit' && <section aria-label="消息预览区" style={paperStyle}>
              <div style={paperHeaderStyle}><strong>排版预览</strong><span style={{ fontSize: 10, color: muted }}>只读</span></div>
              <ComposerPreview key={active} content={content} padding={narrow ? 18 : 28} />
            </section>}
          </div>
        </div>
      </div>
      <footer style={{ padding: narrow ? '10px 12px' : '12px 22px', borderTop: border, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 2 }}><WorkflowButton tone="quiet" onClick={() => change(() => composerDrafts.undo(scope, active))}>撤销本块</WorkflowButton><WorkflowButton tone="quiet" onClick={() => change(() => composerDrafts.undo(scope, active, true))}>重做本块</WorkflowButton></div>
        <div style={{ flex: 1, minWidth: narrow ? 90 : 160, color: muted, fontSize: 11 }}><span>{content.length.toLocaleString()} 字符</span>{(draft.textAttachments.length > 0 || draft.images.length > 0) && <span> · {draft.textAttachments.length} 个文本块 / {draft.images.length} 张图片</span>}{!narrow && <div>Enter 换行 · Ctrl/⌘+Enter 发送</div>}</div>
        <WorkflowButton tone="primary" onClick={onSend}>发送当前消息</WorkflowButton>
      </footer>
    </div>
  </div></AppModalPortal>;
};
