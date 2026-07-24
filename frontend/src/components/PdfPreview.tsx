import React, { useEffect, useRef, useState } from 'react';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Props {
  data: Uint8Array;
}

function offlineAsset(path: string): string {
  return new URL(`./vendor/pdfjs/${path}`, document.baseURI).href;
}

/**
 * 单页按需渲染，避免长 PDF 一次创建几十个 canvas 占满内存。
 * PDF.js worker、CMap、标准字体和图片解码 WASM 均从本地安装包加载。
 */
export const PdfPreview: React.FC<Props> = ({ data }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    setPdf(null);
    setPageNumber(1);
    setLoading(true);
    setError('');
    const task = getDocument({
      data: data.slice(),
      cMapUrl: offlineAsset('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: offlineAsset('standard_fonts/'),
    });
    task.promise.then((documentProxy) => {
      if (disposed) return;
      setPdf(documentProxy);
    }).catch((reason: unknown) => {
      if (!disposed) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      void task.destroy();
    };
  }, [data]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let disposed = false;
    setLoading(true);
    setError('');
    renderTaskRef.current?.cancel();

    void pdf.getPage(pageNumber).then((page) => {
      if (disposed || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建 PDF Canvas 上下文');

      const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        background: '#ffffff',
      });
      renderTaskRef.current = renderTask;
      return renderTask.promise;
    }).then(() => {
      if (!disposed) setLoading(false);
    }).catch((reason: unknown) => {
      if (disposed || (reason as { name?: string })?.name === 'RenderingCancelledException') return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, pageNumber, scale]);

  return (
    <div style={rootStyle}>
      <div style={toolbarStyle}>
        <button style={buttonStyle} disabled={!pdf || pageNumber <= 1} onClick={() => setPageNumber((n) => Math.max(1, n - 1))}>◀</button>
        <span style={labelStyle}>第 {pageNumber} / {pdf?.numPages || '—'} 页</span>
        <button style={buttonStyle} disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber((n) => Math.min(pdf?.numPages || n, n + 1))}>▶</button>
        <span style={dividerStyle} />
        <button style={buttonStyle} disabled={scale <= 0.6} onClick={() => setScale((n) => Math.max(0.6, Number((n - 0.2).toFixed(1))))}>−</button>
        <span style={labelStyle}>{Math.round(scale * 100)}%</span>
        <button style={buttonStyle} disabled={scale >= 2.6} onClick={() => setScale((n) => Math.min(2.6, Number((n + 0.2).toFixed(1))))}>＋</button>
        <div style={{ flex: 1 }} />
        <span style={{ ...labelStyle, opacity: 0.75 }}>PDF.js · 离线</span>
      </div>
      <div style={canvasAreaStyle}>
        {loading && <div style={statusStyle}>正在渲染第 {pageNumber} 页…</div>}
        {error && <div style={{ ...statusStyle, color: '#f87171' }}>PDF 预览失败：{error}</div>}
        <canvas ref={canvasRef} style={{ display: error ? 'none' : 'block', boxShadow: '0 4px 24px rgba(0,0,0,.35)' }} />
      </div>
    </div>
  );
};

const rootStyle: React.CSSProperties = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' };
const toolbarStyle: React.CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)' };
const buttonStyle: React.CSSProperties = { minWidth: 30, height: 28, border: '1px solid var(--theme-border)', borderRadius: 6, background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)', cursor: 'pointer' };
const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--theme-text-muted)', whiteSpace: 'nowrap' };
const dividerStyle: React.CSSProperties = { width: 1, height: 20, background: 'var(--theme-border)', margin: '0 2px' };
const canvasAreaStyle: React.CSSProperties = { position: 'relative', flex: 1, minHeight: 0, overflow: 'auto', padding: 22, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: '#525659' };
const statusStyle: React.CSSProperties = { position: 'absolute', zIndex: 1, top: 14, left: '50%', transform: 'translateX(-50%)', padding: '6px 10px', borderRadius: 6, background: 'rgba(17,24,39,.88)', color: '#d1d5db', fontSize: 12 };

export default PdfPreview;
