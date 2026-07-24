import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StructuredPreviewPayload } from './StructuredFilePreview';

interface Props {
  xml: string;
  fallback?: StructuredPreviewPayload;
  onReveal?: () => void;
}

interface DrawioSheet {
  id: string;
  name: string;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] || char));
}

function parseSheets(xml: string): DrawioSheet[] {
  try {
    const documentNode = new DOMParser().parseFromString(xml, 'application/xml');
    if (documentNode.querySelector('parsererror')) return [{ id: '0', name: 'Page 1' }];
    const diagrams = Array.from(documentNode.getElementsByTagName('diagram'));
    if (diagrams.length === 0) return [{ id: '0', name: 'Page 1' }];
    return diagrams.map((diagram, index) => ({
      // Viewer 会为缺少 id 的页面按序补 0, 1, 2...，这里保持相同规则。
      id: diagram.getAttribute('id') || String(index),
      name: diagram.getAttribute('name') || `Page ${index + 1}`,
    }));
  } catch {
    return [{ id: '0', name: 'Page 1' }];
  }
}

/**
 * 官方 viewer-static 在隔离 iframe 中工作。CSP 禁止联网，文件只在当前 WebView 内解析。
 * Sheet、缩放和适配由外层显式控制；兼容模式复用相同 Sheet 导航和可拖动画布。
 */
export const DrawioPreview: React.FC<Props> = ({ xml, fallback, onReveal }) => {
  const sheets = useMemo(() => parseSheets(xml), [xml]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [compatibilityMode, setCompatibilityMode] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [compatZoom, setCompatZoom] = useState(1);
  const [compatPan, setCompatPan] = useState({ x: 20, y: 20 });

  const safeSheet = Math.min(activeSheet, Math.max(0, sheets.length - 1));
  const selectedSheet = sheets[safeSheet] || sheets[0];
  const fallbackPage = fallback?.kind === 'drawio' ? fallback.pages?.[safeSheet] : undefined;
  const fallbackUrl = useMemo(() => fallbackPage?.svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fallbackPage.svg)}`
    : '', [fallbackPage]);

  useEffect(() => { setActiveSheet(0); }, [xml]);

  const srcDoc = useMemo(() => {
    const viewerUrl = new URL('./vendor/drawio/viewer-static.min.js', document.baseURI).href;
    const config = escapeAttribute(JSON.stringify({
      highlight: '#3b82f6',
      nav: true,
      resize: false,
      center: true,
      'auto-fit': true,
      // 禁用 Viewer 自带的“单击进入灯箱/放大”行为。缩放仍由外层工具栏和滚轮控制，
      // 避免一次很短的手形拖拽在 mouseup 时被误判为单击放大。
      'allow-zoom-in': false,
      'allow-zoom-out': true,
      toolbar: 'zoom layers tags',
      pageId: selectedSheet?.id || '0',
      xml,
    }));
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#e5e7eb}.mxgraph{box-sizing:border-box;width:100%;height:100%;min-width:100%;min-height:100%;overflow:hidden;background:#e5e7eb}</style>
</head><body><div class="mxgraph" data-mxgraph='${config}'></div>
<script>
(function(){
  var viewer = null;
  window.onDrawioViewerLoad = function(){
    var element = document.querySelector('.mxgraph');
    GraphViewer.createViewerForElement(element, function(instance){
      viewer = instance;
      // 官方 Viewer 会给画布安装 click -> lightbox 的处理器。手形拖拽距离较短时，
      // mouseup 可能被它识别为点击，表现为画面突然放大；预览器不需要该行为。
      viewer.lightboxClickEnabled = false;
      viewer.allowZoomIn = false;
      var graph = viewer && viewer.graph;
      if (graph) {
        graph.setPanning(true);
        graph.panningHandler.useLeftButtonForPanning = true;
        graph.panningHandler.ignoreCell = true;
        graph.panningHandler.pinchEnabled = false;
        graph.container.style.touchAction = 'none';
        graph.container.style.cursor = 'grab';
        graph.container.addEventListener('wheel', function(event){
          event.preventDefault();
          if (event.deltaY < 0) graph.zoomIn(); else graph.zoomOut();
        }, { passive: false });
        graph.container.addEventListener('mousedown', function(){ graph.container.style.cursor = 'grabbing'; });
        graph.container.addEventListener('mouseup', function(){ graph.container.style.cursor = 'grab'; });
        graph.container.addEventListener('mouseleave', function(){ graph.container.style.cursor = 'grab'; });
      }
      window.setTimeout(function(){ if (viewer && viewer.fitGraph) viewer.fitGraph(); }, 0);
    });
  };
  window.addEventListener('message', function(event){
    if (event.source !== parent || !event.data || event.data.type !== 'awu-drawio-control' || !viewer) return;
    var graph = viewer.graph;
    if (!graph) return;
    switch (event.data.action) {
      case 'zoom-in': graph.zoomIn(); break;
      case 'zoom-out': graph.zoomOut(); break;
      case 'actual': graph.zoomActual(); graph.center(true, true); break;
      case 'fit': graph.maxFitScale = null; graph.fit(null, null, null, null, null, true); graph.center(true, true); break;
    }
  });
})();
</script>
<script src="${escapeAttribute(viewerUrl)}"></script></body></html>`;
  }, [xml, selectedSheet?.id]);

  const officialControl = useCallback((action: 'zoom-in' | 'zoom-out' | 'actual' | 'fit') => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'awu-drawio-control', action }, '*');
  }, []);

  const fitCompatibility = useCallback(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image || !image.naturalWidth || !image.naturalHeight) return;
    const width = Math.max(1, viewport.clientWidth - 36);
    const height = Math.max(1, viewport.clientHeight - 36);
    const nextZoom = Math.max(0.1, Math.min(4, Math.min(width / image.naturalWidth, height / image.naturalHeight)));
    setCompatZoom(nextZoom);
    setCompatPan({
      x: (viewport.clientWidth - image.naturalWidth * nextZoom) / 2,
      y: (viewport.clientHeight - image.naturalHeight * nextZoom) / 2,
    });
  }, []);

  const actualCompatibility = useCallback(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return;
    setCompatZoom(1);
    setCompatPan({
      x: (viewport.clientWidth - image.naturalWidth) / 2,
      y: (viewport.clientHeight - image.naturalHeight) / 2,
    });
  }, []);

  const zoomCompatibility = useCallback((factor: number, anchorX?: number, anchorY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const x = anchorX ?? viewport.clientWidth / 2;
    const y = anchorY ?? viewport.clientHeight / 2;
    setCompatZoom((previous) => {
      const next = Math.max(0.1, Math.min(6, previous * factor));
      const ratio = next / previous;
      setCompatPan((pan) => ({ x: x - (x - pan.x) * ratio, y: y - (y - pan.y) * ratio }));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!compatibilityMode || !viewportRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitCompatibility());
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [compatibilityMode, safeSheet, fitCompatibility]);

  const beginPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: compatPan.x, panY: compatPan.y };
    setDragging(true);
  }, [compatPan]);

  const movePan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setCompatPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
  }, []);

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  const switchSheet = useCallback((index: number) => {
    setActiveSheet(index);
    setCompatZoom(1);
    setCompatPan({ x: 20, y: 20 });
  }, []);

  return (
    <div style={rootStyle}>
      <div style={toolbarStyle}>
        <button style={{ ...buttonStyle, ...(!compatibilityMode ? activeButtonStyle : {}) }} onClick={() => setCompatibilityMode(false)}>官方渲染</button>
        <button style={{ ...buttonStyle, ...(compatibilityMode ? activeButtonStyle : {}) }} disabled={!fallback} onClick={() => setCompatibilityMode(true)}>兼容预览</button>
        <span style={dividerStyle} />
        <button style={buttonStyle} title="缩小" onClick={() => compatibilityMode ? zoomCompatibility(0.8) : officialControl('zoom-out')}>−</button>
        {compatibilityMode && <span style={zoomLabelStyle}>{Math.round(compatZoom * 100)}%</span>}
        <button style={buttonStyle} title="放大" onClick={() => compatibilityMode ? zoomCompatibility(1.25) : officialControl('zoom-in')}>＋</button>
        <button style={buttonStyle} onClick={() => compatibilityMode ? fitCompatibility() : officialControl('fit')}>适配窗口</button>
        <button style={buttonStyle} onClick={() => compatibilityMode ? actualCompatibility() : officialControl('actual')}>1:1</button>
        <div style={{ flex: 1 }} />
        {onReveal && <button style={buttonStyle} onClick={onReveal}>📂 定位</button>}
        <span style={labelStyle}>左键拖动画布 · 滚轮缩放</span>
      </div>

      <div style={sheetBarStyle}>
        <span style={{ ...labelStyle, padding: '0 5px' }}>Sheet</span>
        {sheets.map((sheet, index) => (
          <button key={`${sheet.id}-${index}`} title={sheet.name} style={{ ...sheetButtonStyle, ...(safeSheet === index ? activeSheetStyle : {}) }} onClick={() => switchSheet(index)}>
            {sheet.name}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {compatibilityMode ? (
          fallbackUrl ? (
            <div
              ref={viewportRef}
              style={{ ...canvasViewportStyle, cursor: dragging ? 'grabbing' : 'grab' }}
              onPointerDown={beginPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onWheel={(event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                zoomCompatibility(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top);
              }}
            >
              <img
                ref={imageRef}
                src={fallbackUrl}
                alt={fallbackPage?.name || selectedSheet?.name || 'Draw.io'}
                draggable={false}
                onLoad={fitCompatibility}
                style={{
                  position: 'absolute', left: 0, top: 0, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none',
                  transformOrigin: '0 0', transform: `translate(${compatPan.x}px, ${compatPan.y}px) scale(${compatZoom})`,
                }}
              />
            </div>
          ) : (
            <div style={emptyStyle}>兼容预览没有生成此 Sheet；可切回官方渲染查看。</div>
          )
        ) : (
          <iframe
            key={selectedSheet?.id || safeSheet}
            ref={iframeRef}
            title={`Draw.io ${selectedSheet?.name || ''}`}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '100%', border: 0, background: '#e5e7eb' }}
          />
        )}
      </div>
    </div>
  );
};

const rootStyle: React.CSSProperties = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' };
const toolbarStyle: React.CSSProperties = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)', overflowX: 'auto' };
const buttonStyle: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 6, padding: '5px 9px', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' };
const activeButtonStyle: React.CSSProperties = { borderColor: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', color: 'var(--theme-accent)' };
const dividerStyle: React.CSSProperties = { width: 1, alignSelf: 'stretch', background: 'var(--theme-border)', margin: '0 3px' };
const labelStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 11, whiteSpace: 'nowrap' };
const zoomLabelStyle: React.CSSProperties = { ...labelStyle, minWidth: 38, textAlign: 'center' };
const sheetBarStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3, minHeight: 34, padding: '4px 8px', overflowX: 'auto', flexShrink: 0, borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)' };
const sheetButtonStyle: React.CSSProperties = { maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', border: '1px solid transparent', borderRadius: 5, padding: '4px 9px', whiteSpace: 'nowrap', background: 'transparent', color: 'var(--theme-text-muted)', cursor: 'pointer', fontSize: 11 };
const activeSheetStyle: React.CSSProperties = { borderColor: 'var(--theme-accent)', color: 'var(--theme-accent)', background: 'var(--theme-accent-bg)', fontWeight: 700 };
const canvasViewportStyle: React.CSSProperties = { position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#d9dde3', backgroundImage: 'linear-gradient(45deg, rgba(148,163,184,.14) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,.14) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,.14) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,.14) 75%)', backgroundSize: '24px 24px', backgroundPosition: '0 0, 0 12px, 12px -12px, -12px 0' };
const emptyStyle: React.CSSProperties = { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--theme-text-muted)', fontSize: 13 };

export default DrawioPreview;
