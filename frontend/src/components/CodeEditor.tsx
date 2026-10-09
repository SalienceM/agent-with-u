/**
 * CodeEditor — CodeMirror 6 封装,**懒加载**专用(由 FileTreePanel 经 React.lazy
 * 动态 import),所以 CodeMirror 及其语言包都进独立 chunk,不进主包。
 *
 * 提供：行号、括号匹配、历史撤销、搜索、按文件类型语法高亮(边写边高亮)、
 * Tab 缩进、Ctrl/⌘+S 保存。明暗主题二选一(oneDark / 默认浅色)。
 */
import React, { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { vue } from '@codemirror/lang-vue';
import { autocompletion, type Completion } from '@codemirror/autocomplete';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { languageEditorText, languageOffset } from '../utils/languageEdits';
import type { LanguageEditorBinding } from '../hooks/useLanguageEditor';
import { yaml } from '@codemirror/lang-yaml';
import { php } from '@codemirror/lang-php';
import { openSearchPanel, gotoLine } from '@codemirror/search';
import type { EditorDocumentState } from '../utils/editorDocumentState';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function langFor(ext: string): any | null {
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: true });
    case 'ts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'py': return python();
    case 'json': case 'jsonc': return json();
    case 'md': case 'markdown': case 'mdx': return markdown();
    case 'html': case 'htm': return html();
    case 'vue': return vue();
    case 'css': case 'scss': case 'less': return css();
    case 'xml': case 'svg': return xml();
    case 'sql': return sql();
    case 'rs': return rust();
    case 'c': case 'h': case 'cpp': case 'cc': case 'cxx': case 'hpp': return cpp();
    case 'java': return java();
    case 'go': return go();
    case 'yml': case 'yaml': return yaml();
    case 'php': return php();
    default: return null;
  }
}

interface Props {
  value: string;
  ext: string;
  dark: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onSaveAll?: () => void;
  documentKey?: string;
  editorState?: EditorDocumentState;
  onEditorState?: (state: EditorDocumentState) => void;
  readOnly?: boolean;
  height?: string;
  command?: { id: number; type: 'position' | 'search' | 'line'; line?: number; column?: number };
  language?: LanguageEditorBinding;
}

const sizing = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--theme-panel-solid)', color: 'var(--theme-text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--theme-panel-solid)', color: 'var(--theme-text-muted)', borderRight: '1px solid var(--theme-border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--theme-accent-bg)' },
  '.cm-cursor': { borderLeftColor: 'var(--theme-text)' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--theme-popover-bg)', color: 'var(--theme-text)', borderColor: 'var(--theme-border)' },
  '.cm-textfield, .cm-button': { background: 'var(--theme-panel-solid)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)', borderRadius: '4px' },
});

export default function CodeEditor({ value, ext, dark, onChange, onSave, onSaveAll, documentKey,
  editorState, onEditorState, readOnly = false, height = '62vh', command, language }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const externalChangeRef = useRef(false);
  const stateRef = useRef(editorState);
  stateRef.current = editorState;
  const onStateRef = useRef(onEditorState);
  onStateRef.current = onEditorState;
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onSaveAllRef = useRef(onSaveAll); onSaveAllRef.current = onSaveAll;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const languageRef = useRef(language); languageRef.current = language;

  // 容器可卸载，文档状态由共享存储拥有；配置替换不重建历史字段。
  useEffect(() => {
    if (!hostRef.current) return;
    const publishState = onStateRef.current;
    const lang = langFor(ext);
    const extensions = [
      basicSetup,
      keymap.of([indentWithTab]),
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { if (!readOnly) onSaveRef.current(); return true; } }]),
      keymap.of([{ key: 'Mod-Shift-s', preventDefault: true, run: () => { if (!readOnly) onSaveAllRef.current?.(); return true; } }]),
      keymap.of((['F12', 'Shift-F12', 'F2', 'Shift-Alt-f'] as const).map((key, i) => ({ key, preventDefault: true, run: (view: EditorView) => {
        if (readOnly || !languageRef.current) return false;
        languageRef.current.execute((['definition', 'references', 'rename', 'format'] as const)[i], view.state.selection.main.head); return true;
      } }))),
      autocompletion({ override: [async context => {
        const binding = languageRef.current, text = context.state.doc.toString();
        if (readOnly || !binding || !binding.valid(text)) return null;
        const word = context.matchBefore(/[\w$]+/u); if (!word && !context.explicit) return null;
        const controller = new AbortController(); context.addEventListener('abort', () => controller.abort(), { onDocChange: true });
        const items = await binding.complete(context.pos, text, controller.signal);
        if (context.aborted || !binding.valid(text)) return null;
        const from = word?.from ?? context.pos;
        const options: Completion[] = items.map(item => ({ label: item.label, detail: typeof item.detail === 'string' ? item.detail.slice(0, 256) : '项目补全',
          apply: (view, _completion, start, end) => {
            if (!binding.valid(view.state.doc.toString())) return;
            let left = start, right = end, insert = item.insertText ?? item.label;
            if (item.textEdit) {
              const range = item.textEdit.range || item.textEdit.replace;
              try { left = languageOffset(text, range.start); right = languageOffset(text, range.end); insert = item.textEdit.newText; } catch { return; }
            }
            if (typeof insert !== 'string' || insert.length > 65536 || left > right) return;
            view.dispatch({ changes: { from: left, to: right, insert }, selection: { anchor: left + insert.length }, userEvent: 'input.complete' });
          } }));
        return { from, options };
      }] }),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !externalChangeRef.current && !readOnly) onChangeRef.current(u.state.doc.toString());
        if (u.docChanged || u.selectionSet) publishState?.({ state: u.state,
          scrollTop: u.view.scrollDOM.scrollTop, scrollLeft: u.view.scrollDOM.scrollLeft });
        if (u.docChanged || u.selectionSet) languageRef.current?.position(u.state.selection.main.head);
      }),
      sizing,
      ...(dark ? [oneDark] : []),
      ...(lang ? [lang] : []),
    ];
    const saved = stateRef.current;
    let state = saved?.state ?? EditorState.create({ doc: value, extensions });
    if (saved) state = state.update({ effects: StateEffect.reconfigure.of(extensions) }).state;
    if (state.doc.toString() !== languageEditorText(value)) state = state.update({ changes: { from: 0, to: state.doc.length, insert: value } }).state;
    const view = new EditorView({
      state,
      parent: hostRef.current,
    });
    viewRef.current = view;
    if (saved) { view.scrollDOM.scrollTop = saved.scrollTop; view.scrollDOM.scrollLeft = saved.scrollLeft; }
    const remember = () => publishState?.({ state: view.state,
      scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft });
    view.scrollDOM.addEventListener('scroll', remember, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => view.requestMeasure()) : null;
    observer?.observe(hostRef.current);
    view.focus();
    return () => {
      remember(); observer?.disconnect(); view.scrollDOM.removeEventListener('scroll', remember);
      viewRef.current = null; view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, ext, dark, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && view.state.doc.toString() !== languageEditorText(value)) {
      externalChangeRef.current = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }
      finally { externalChangeRef.current = false; }
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    const text = view.state.doc.toString(), diagnostics: Diagnostic[] = [];
    for (const item of language?.diagnostics || []) {
      try { const from = languageOffset(text, item.range.start), to = languageOffset(text, item.range.end);
        if (from <= to) diagnostics.push({ from, to, severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info', message: item.message, source: item.source });
      } catch { /* 无效位置不定位到其他源码 */ }
    }
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [language?.diagnostics, documentKey, value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !command) return;
    view.focus();
    if (command.type === 'search') openSearchPanel(view);
    else if (command.type === 'line') gotoLine(view);
    else {
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.trunc(command.line || 1))));
      const anchor = line.from + Math.max(0, Math.min(line.length, Math.trunc(command.column || 1) - 1));
      view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    }
  }, [command, documentKey]);

  return <div ref={hostRef} style={{ height, width: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }} />;
}
