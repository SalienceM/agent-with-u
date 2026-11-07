import React, { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { usePreviewPan } from '../hooks/usePreviewPan';
import { usePreviewSize } from '../hooks/usePreviewLayout';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = usePreviewSize<HTMLDivElement>();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [hand, setHand] = useState(false);
  const [paper, setPaper] = useState({ width: 850, height: 0 });
  const fallbackRef = useRef(onFallback); fallbackRef.current = onFallback;
  const dragging = usePreviewPan(scrollRef, hand, data);
  const scale = zoom === 'fit' ? Math.min(1, Math.max(0.1, (size.width - 16) / paper.width)) : zoom;

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    setZoom('fit');
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
      fallbackRef.current?.(message);
    });
    return () => { disposed = true; };
  }, [data]);

  useEffect(() => {
    if (loading || !bodyRef.current) return;
    const body = bodyRef.current;
    const measure = () => {
      const width = Math.max(1, ...Array.from(body.querySelectorAll<HTMLElement>('section.awu-docx')).map(page => page.offsetWidth)) + 60;
      const height = body.scrollHeight;
      setPaper(old => old.width === width && old.height === height ? old : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(body.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [loading]);

  return (
    <div style={rootStyle}>
      <div ref={styleRef} />
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: 6, background: 'var(--theme-bg-tertiary)' }}>
        <select aria-label="Word 缩放" value={zoom} onChange={e => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))} style={toolStyle}>
          <option value="fit">适配宽度</option>{[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value * 100}%</option>)}
        </select>
        <button style={toolStyle} aria-pressed={hand} onClick={() => setHand(!hand)}>{hand ? '手形浏览' : '选择文字'}</button>
        <span style={{ fontSize: 11, color: 'var(--theme-text-muted)' }}>{Math.round(scale * 100)}%</span>
      </div>
      {loading && <div style={statusStyle}>正在解析 Word 文档…</div>}
      {error && <div style={{ ...statusStyle, color: '#f87171' }}>版式预览失败，正在切换到兼容预览：{error}</div>}
      <div ref={size.ref} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        <div ref={scrollRef} data-docx-scroll style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', touchAction: 'pan-x pan-y pinch-zoom', cursor: hand ? dragging ? 'grabbing' : 'grab' : 'text' }}>
          <div style={{ position: 'relative', width: paper.width * scale, height: paper.height * scale, margin: '8px auto', flexShrink: 0, overflow: 'hidden' }}>
            <div ref={bodyRef} style={{ ...bodyStyle, width: paper.width, transform: `scale(${scale})`, transformOrigin: 'top left' }} />
          </div>
        </div>
      </div>
    </div>
  );
};

const rootStyle: React.CSSProperties = { height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#d8d8d8' };
const bodyStyle: React.CSSProperties = { position: 'absolute', top: 0, left: 0 };
const statusStyle: React.CSSProperties = { flexShrink: 0, maxHeight: '20%', overflow: 'auto', padding: '7px 11px', background: 'rgba(17,24,39,.9)', color: '#d1d5db', fontSize: 12 };
const toolStyle: React.CSSProperties = { minHeight: 36, padding: '4px 8px', border: '1px solid var(--theme-border)', borderRadius: 6, color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)', cursor: 'pointer' };

export default DocxPreview;
