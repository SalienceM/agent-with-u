/**
 * CodeEditor — CodeMirror 6 封装,**懒加载**专用(由 FileTreePanel 经 React.lazy
 * 动态 import),所以 CodeMirror 及其语言包都进独立 chunk,不进主包。
 *
 * 提供：行号、括号匹配、历史撤销、搜索、按文件类型语法高亮(边写边高亮)、
 * Tab 缩进、Ctrl/⌘+S 保存。明暗主题二选一(oneDark / 默认浅色)。
 */
import React, { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
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
import { yaml } from '@codemirror/lang-yaml';
import { php } from '@codemirror/lang-php';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function langFor(ext: string): any | null {
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ jsx: true });
    case 'ts': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'py': return python();
    case 'json': case 'jsonc': return json();
    case 'md': case 'markdown': case 'mdx': return markdown();
    case 'html': case 'htm': case 'vue': return html();
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
}

const sizing = EditorView.theme({
  '&': { height: '62vh', fontSize: '12.5px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace', lineHeight: '1.6' },
});

export default function CodeEditor({ value, ext, dark, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // 整个编辑器按 (文件) 重建一次：FileTreePanel 用 key={rel} 控制实例生命周期。
  useEffect(() => {
    if (!hostRef.current) return;
    const lang = langFor(ext);
    const extensions = [
      basicSetup,
      keymap.of([indentWithTab]),
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } }]),
      EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); }),
      sizing,
      ...(dark ? [oneDark] : []),
      ...(lang ? [lang] : []),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    view.focus();
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} style={{ height: '62vh' }} />;
}
