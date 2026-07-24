import React, { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';

interface Props {
  data: Uint8Array;
  onFallback?: (message: string) => void;
}

/** Word Open XML 浏览器渲染。没有 Office/LibreOffice 进程，也不上传文档。 */
export const DocxPreview: React.FC<Props> = ({ data, onFallback }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    bodyRef.current?.replaceChildren();
    styleRef.current?.replaceChildren();
    if (!bodyRef.current || !styleRef.current) return;

    const payload = data.slice().buffer;
    void renderAsync(payload, bodyRef.current, styleRef.current, {
      className: 'awu-docx',
      inWrapper: true,
      breakPages: true,
      ignoreWidth: false,
      ignoreHeight: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderChanges: true,
      useBase64URL: true,
    }).then(() => {
      if (!disposed) setLoading(false);
    }).catch((reason: unknown) => {
      if (disposed) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setLoading(false);
      setError(message);
      onFallback?.(message);
    });
    return () => { disposed = true; };
  }, [data, onFallback]);

  return (
    <div style={rootStyle}>
      <div ref={styleRef} />
      {loading && <div style={statusStyle}>正在解析 Word 文档…</div>}
      {error && <div style={{ ...statusStyle, color: '#f87171' }}>版式预览失败，正在切换到兼容预览：{error}</div>}
      <div ref={bodyRef} style={bodyStyle} />
    </div>
  );
};

const rootStyle: React.CSSProperties = { position: 'relative', height: '100%', minHeight: 0, overflow: 'auto', background: '#d8d8d8' };
const bodyStyle: React.CSSProperties = { minHeight: '100%', padding: '22px 0' };
const statusStyle: React.CSSProperties = { position: 'sticky', zIndex: 3, top: 8, width: 'fit-content', margin: '8px auto -38px', padding: '7px 11px', borderRadius: 6, background: 'rgba(17,24,39,.9)', color: '#d1d5db', fontSize: 12 };

export default DocxPreview;
