import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../../api';
import type {
  ProvAnnotation, ProvDocument, ProvImageShape, ProvOpenResult, ProvPoint,
  ProvReviewState, ProvSelector, ProvSourcePreview, ProvTool,
} from '../../types/prov';
import { AppModalPortal } from '../AppModalPortal';

interface Props {
  initial: ProvOpenResult;
  workingDir: string;
  execKey?: string;
  onClose: () => void;
  onSaved?: () => void;
}

type Notice = { kind: 'ok' | 'error' | 'info'; text: string };

const SHAPE_PREFIX: Record<string, string> = {
  rectangle: '框', ellipse: '圈', arrow: '箭', polygon: '区', point: '点',
  block: '段', text: '文', document: '总',
};

const TOOL_LABELS: Array<{ tool: ProvTool; icon: string; label: string }> = [
  { tool: 'select', icon: '↖', label: '选择/移动' },
  { tool: 'rectangle', icon: '□', label: '矩形框' },
  { tool: 'ellipse', icon: '○', label: '椭圆圈' },
  { tool: 'arrow', icon: '↗', label: '箭头' },
  { tool: 'polygon', icon: '⬡', label: '多边形' },
  { tool: 'point', icon: '•', label: '点标记' },
];

function cloneDocument(document: ProvDocument): ProvDocument {
  return JSON.parse(JSON.stringify(document)) as ProvDocument;
}

function uid(prefix: string): string {
  try { return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`; }
  catch { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
}

function nowIso(): string { return new Date().toISOString(); }
function clamp(value: number, min = 0, max = 1): number { return Math.max(min, Math.min(max, value)); }

function selectorLabel(selector: ProvSelector): string {
  if (selector.type === 'document') return '整个文件';
  if (selector.type === 'image-region') {
    const labels: Record<ProvImageShape, string> = {
      rectangle: '矩形区域', ellipse: '椭圆区域', arrow: '箭头指向',
      polygon: '多边形区域', point: '点位置',
    };
    return labels[selector.shape];
  }
  const heading = selector.headingPath.filter(Boolean).join(' › ');
  return `${selector.type === 'text-block' ? '段落' : '文本片段'}${heading ? ` · ${heading}` : ''}`;
}

function annotationAnchor(annotation: ProvAnnotation): ProvPoint {
  const selector = annotation.target.selector;
  if (selector.type !== 'image-region') return { x: 0, y: 0 };
  const g = selector.geometry;
  if (selector.shape === 'arrow') return { x: g.x1 || 0, y: g.y1 || 0 };
  if (selector.shape === 'polygon') return (g.points || [])[0] || { x: 0, y: 0 };
  return { x: g.x || 0, y: g.y || 0 };
}

function shapeGeometry(selector: ProvSelector): Record<string, any> | null {
  return selector.type === 'image-region' ? selector.geometry : null;
}

function makeAnnotation(
  ref: string,
  selector: ProvSelector,
  order: number,
  parentId: string | null,
): ProvAnnotation {
  const now = nowIso();
  return {
    id: uid('ann'), ref, title: '', parentId, order,
    target: { selector },
    body: {
      kind: 'change_request', comment: '', expected: '', severity: 'normal', blocking: false,
    },
    status: 'open', createdAt: now, updatedAt: now,
  };
}

function descendantsOf(document: ProvDocument, annotationId: string): Set<string> {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of document.annotations) {
      if (!result.has(item.id) && (item.parentId === annotationId || (item.parentId && result.has(item.parentId)))) {
        result.add(item.id); changed = true;
      }
    }
  }
  return result;
}

export const ReviewWorkbench: React.FC<Props> = ({
  initial, workingDir, execKey, onClose, onSaved,
}) => {
  const [document, setDocument] = useState<ProvDocument>(() => cloneDocument(initial.document));
  const [sourceStatus, setSourceStatus] = useState(initial.sourceStatus);
  const [sourcePreview] = useState<ProvSourcePreview | null>(initial.sourcePreview);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.document.annotations[0]?.id || null,
  );
  const [tool, setTool] = useState<ProvTool>('select');
  const [polygonPoints, setPolygonPoints] = useState<ProvPoint[]>([]);
  const [dirty, setDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<ProvDocument[]>([]);
  const [redoStack, setRedoStack] = useState<ProvDocument[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [workOrder, setWorkOrder] = useState<string | null>(null);
  const [loadingWorkOrder, setLoadingWorkOrder] = useState(false);

  const selected = useMemo(
    () => document.annotations.find((item) => item.id === selectedId) || null,
    [document.annotations, selectedId],
  );
  const isImage = sourcePreview?.kind === 'image';

  const replaceDocument = useCallback((next: ProvDocument) => {
    // 已审批的稿件一旦再次编辑就回到草稿，避免旧结论继续挂在新内容上。
    if (next.review.state !== 'draft') next.review.state = 'draft';
    next.review.updatedAt = nowIso();
    setUndoStack((items) => [...items.slice(-39), cloneDocument(document)]);
    setRedoStack([]);
    setDocument(next);
    setDirty(true);
  }, [document]);

  const undo = useCallback(() => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((items) => items.slice(0, -1));
    setRedoStack((items) => [...items.slice(-39), cloneDocument(document)]);
    setDocument(cloneDocument(previous)); setDirty(true);
    if (selectedId && !previous.annotations.some((item) => item.id === selectedId)) setSelectedId(null);
  }, [document, selectedId, undoStack]);

  const redo = useCallback(() => {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setRedoStack((items) => items.slice(0, -1));
    setUndoStack((items) => [...items.slice(-39), cloneDocument(document)]);
    setDocument(cloneDocument(next)); setDirty(true);
  }, [document, redoStack]);

  const updateAnnotation = useCallback((id: string, patch: Partial<ProvAnnotation>) => {
    const next = cloneDocument(document);
    const index = next.annotations.findIndex((item) => item.id === id);
    if (index < 0) return;
    next.annotations[index] = {
      ...next.annotations[index], ...patch, updatedAt: nowIso(),
      body: patch.body ? { ...next.annotations[index].body, ...patch.body } : next.annotations[index].body,
      target: patch.target ? { ...next.annotations[index].target, ...patch.target } : next.annotations[index].target,
    };
    replaceDocument(next);
  }, [document, replaceDocument]);

  const createAnnotation = useCallback((selector: ProvSelector, counterKey: string) => {
    const next = cloneDocument(document);
    const count = Number(next.counters[counterKey] || 0) + 1;
    next.counters[counterKey] = count;
    const ref = `${SHAPE_PREFIX[counterKey] || '标'}${count}`;
    const annotation = makeAnnotation(
      ref, selector, next.annotations.length,
      selectedId && next.annotations.some((item) => item.id === selectedId) ? selectedId : null,
    );
    next.annotations.push(annotation);
    replaceDocument(next);
    setSelectedId(annotation.id);
    setTool('select');
    return annotation.id;
  }, [document, replaceDocument, selectedId]);

  const deleteAnnotation = useCallback((id: string) => {
    const target = document.annotations.find((item) => item.id === id);
    if (!target || !window.confirm(`删除 ${target.ref}？其子意见会提升到当前层级。`)) return;
    const next = cloneDocument(document);
    next.annotations = next.annotations
      .filter((item) => item.id !== id)
      .map((item) => item.parentId === id ? { ...item, parentId: target.parentId } : item);
    replaceDocument(next);
    setSelectedId(target.parentId || next.annotations[0]?.id || null);
  }, [document, replaceDocument]);

  const save = useCallback(async (
    candidate: ProvDocument = document,
    rebindSource = false,
  ): Promise<ProvDocument | null> => {
    if (saving) return null;
    setSaving(true); setNotice(null);
    try {
      const result = await api.provSave(
        workingDir, initial.provPath, candidate,
        document.review.revision, rebindSource, execKey,
      );
      if (result.status === 'source_changed') {
        setSourceStatus('changed');
        setNotice({ kind: 'error', text: result.message || '源文件已变化' });
        return null;
      }
      if (result.status !== 'ok' || !result.document) {
        setNotice({ kind: 'error', text: result.message || '保存失败' });
        return null;
      }
      setDocument(result.document);
      setDirty(false); setSourceStatus('ok');
      setNotice({ kind: 'ok', text: `已保存 ${initial.provPath} · r${result.document.review.revision}` });
      onSaved?.();
      return result.document;
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || String(error) });
      return null;
    } finally { setSaving(false); }
  }, [document, execKey, initial.provPath, onSaved, saving, workingDir]);

  const saveAsState = useCallback(async (state: ProvReviewState) => {
    const next = cloneDocument(document);
    next.review.state = state;
    await save(next);
  }, [document, save]);

  const previewWorkOrder = useCallback(async () => {
    if (dirty || document.review.revision === 0) {
      const saved = await save(document);
      if (!saved) return;
    }
    setLoadingWorkOrder(true);
    try {
      const result = await api.provResolve(workingDir, initial.provPath, execKey);
      if (result.status !== 'ok') throw new Error(result.message || '生成工作单失败');
      setWorkOrder(result.workOrder || '没有可展示的工作单');
    } catch (error: any) {
      setNotice({ kind: 'error', text: error?.message || String(error) });
    } finally { setLoadingWorkOrder(false); }
  }, [dirty, document, execKey, initial.provPath, save, workingDir]);

  const requestClose = useCallback(() => {
    if (!dirty || window.confirm('关闭并放弃尚未保存的审阅修改？')) onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (workOrder != null) setWorkOrder(null);
        else if (polygonPoints.length) setPolygonPoints([]);
        else requestClose();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); void save();
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); undo();
      }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
        event.preventDefault(); redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [polygonPoints.length, redo, requestClose, save, undo, workOrder]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const addGlobal = useCallback(() => {
    createAnnotation({ type: 'document' }, 'document');
  }, [createAnnotation]);

  return (
    <AppModalPortal>
      <div style={overlayStyle} onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
        <div style={workbenchStyle} role="dialog" aria-modal="true" aria-label="文件审阅工作台">
          <header style={headerStyle}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                审阅 · {document.source.path}
              </div>
              <div style={subtleStyle} title={initial.provPath}>
                {initial.provPath} · r{document.review.revision}{dirty ? ' · 未保存' : ''}
              </div>
            </div>
            <span style={stateBadgeStyle(document.review.state)}>{reviewStateLabel(document.review.state)}</span>
            <div style={{ flex: 1 }} />
            <button style={headerButtonStyle} onClick={undo} disabled={!undoStack.length} title="撤销（Ctrl+Z）">↶</button>
            <button style={headerButtonStyle} onClick={redo} disabled={!redoStack.length} title="重做（Ctrl+Y）">↷</button>
            <button style={headerButtonStyle} onClick={previewWorkOrder} disabled={loadingWorkOrder || saving}>
              {loadingWorkOrder ? '生成中…' : 'Agent 工作单'}
            </button>
            <button style={headerButtonStyle} onClick={() => void saveAsState('draft')} disabled={saving}>
              {saving ? '保存中…' : '保存草稿'}
            </button>
            <button style={{ ...headerButtonStyle, color: '#f59e0b' }} onClick={() => void saveAsState('changes_requested')} disabled={saving}>
              需修改
            </button>
            <button style={{ ...headerButtonStyle, color: '#22c55e' }} onClick={() => void saveAsState('approved')} disabled={saving}>
              通过
            </button>
            <select
              aria-label="更多审批结论"
              title="更多审批结论"
              style={{ ...headerButtonStyle, maxWidth: 94 }}
              value=""
              disabled={saving}
              onChange={(event) => {
                const state = event.target.value as ProvReviewState;
                if (state) void saveAsState(state);
              }}
            >
              <option value="">更多…</option>
              <option value="conditionally_approved">有条件通过</option>
              <option value="rejected">拒绝</option>
            </select>
            <button style={closeButtonStyle} onClick={requestClose} aria-label="关闭审阅">×</button>
          </header>

          {sourceStatus !== 'ok' && (
            <div style={warningStyle}>
              <strong>{sourceStatus === 'missing' ? '源文件已缺失' : '源文件已发生变化'}</strong>
              <span>{sourceStatus === 'changed' ? '旧锚点可能偏移，请核对后再重新绑定。' : 'Prov 仍可查看，但不能继续保存。'}</span>
              {sourceStatus === 'changed' && (
                <button style={warningButtonStyle} onClick={() => void save(document, true)} disabled={saving}>我已核对，重新绑定</button>
              )}
            </div>
          )}

          <main style={mainStyle}>
            <aside style={toolRailStyle}>
              {isImage ? TOOL_LABELS.map((item) => (
                <button
                  key={item.tool}
                  style={{ ...toolButtonStyle, ...(tool === item.tool ? toolButtonActiveStyle : {}) }}
                  title={item.label}
                  onClick={() => { setTool(item.tool); if (item.tool !== 'polygon') setPolygonPoints([]); }}
                >
                  <span style={{ fontSize: 19 }}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              )) : (
                <>
                  <button style={{ ...toolButtonStyle, ...toolButtonActiveStyle }}><span style={{ fontSize: 18 }}>T</span><span>文字选择</span></button>
                  <button style={toolButtonStyle} onClick={addGlobal}><span style={{ fontSize: 18 }}>≡</span><span>总体意见</span></button>
                </>
              )}
              {isImage && <button style={toolButtonStyle} onClick={addGlobal}><span style={{ fontSize: 18 }}>≡</span><span>总体意见</span></button>}
              {tool === 'polygon' && polygonPoints.length > 0 && (
                <div style={{ padding: 6, color: 'var(--theme-text-muted)', fontSize: 10, lineHeight: 1.4 }}>
                  已取 {polygonPoints.length} 点
                  <button
                    style={{ ...warningButtonStyle, width: '100%', marginTop: 6 }}
                    disabled={polygonPoints.length < 3}
                    onClick={() => {
                      if (polygonPoints.length >= 3) {
                        createAnnotation({
                          type: 'image-region', shape: 'polygon',
                          geometry: { unit: 'normalized', points: polygonPoints },
                        }, 'polygon');
                        setPolygonPoints([]);
                      }
                    }}
                  >完成区域</button>
                </div>
              )}
            </aside>

            <section style={surfaceStyle}>
              {!sourcePreview ? (
                <EmptySurface text="无法载入源文件预览" />
              ) : sourcePreview.kind === 'image' ? (
                <ImageReviewSurface
                  preview={sourcePreview}
                  annotations={document.annotations}
                  selectedId={selectedId}
                  tool={tool}
                  polygonPoints={polygonPoints}
                  onPolygonPoints={setPolygonPoints}
                  onSelect={setSelectedId}
                  onCreate={(selector, key) => createAnnotation(selector, key)}
                  onGeometry={(id, selector) => updateAnnotation(id, { target: { selector } })}
                />
              ) : (
                <TextReviewSurface
                  preview={sourcePreview}
                  annotations={document.annotations}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onCreate={(selector, key) => createAnnotation(selector, key)}
                  onNotice={(text) => setNotice({ kind: 'info', text })}
                />
              )}
            </section>

            <aside style={rightPanelStyle}>
              <AnnotationTree
                document={document} selectedId={selectedId}
                onSelect={setSelectedId} onAddGlobal={addGlobal}
              />
              <div style={editorAreaStyle}>
                {selected ? (
                  <AnnotationEditor
                    document={document}
                    annotation={selected}
                    onChange={(patch) => updateAnnotation(selected.id, patch)}
                    onDelete={() => deleteAnnotation(selected.id)}
                  />
                ) : (
                  <div style={{ padding: 18, color: 'var(--theme-text-muted)', fontSize: 12, lineHeight: 1.7 }}>
                    在中间画布创建标记，或选择文字、添加总体意见。每条标记都会获得稳定编号。
                  </div>
                )}
              </div>
            </aside>
          </main>

          <footer style={footerStyle}>
            <span>{document.annotations.length} 条意见</span>
            <span>{document.annotations.filter((item) => item.body.blocking && item.status === 'open').length} 条阻断</span>
            <span>{document.annotations.filter((item) => item.status === 'verified').length} 条已验证</span>
            <div style={{ flex: 1 }} />
            <span>Ctrl+S 保存 · Esc 关闭</span>
          </footer>

          {notice && <div style={noticeStyle(notice.kind)}>{notice.text}</div>}
          {workOrder != null && (
            <div style={workOrderOverlayStyle} onClick={() => setWorkOrder(null)}>
              <div style={workOrderBoxStyle} onClick={(event) => event.stopPropagation()}>
                <div style={{ ...headerStyle, height: 46 }}>
                  <strong>Agent 将收到的审阅工作单</strong>
                  <div style={{ flex: 1 }} />
                  <button style={headerButtonStyle} onClick={async () => {
                    await navigator.clipboard.writeText(workOrder);
                    setNotice({ kind: 'ok', text: '工作单已复制' });
                  }}>复制</button>
                  <button style={closeButtonStyle} onClick={() => setWorkOrder(null)}>×</button>
                </div>
                <pre style={workOrderPreStyle}>{workOrder}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppModalPortal>
  );
};

interface ImageSurfaceProps {
  preview: Extract<ProvSourcePreview, { kind: 'image' }>;
  annotations: ProvAnnotation[];
  selectedId: string | null;
  tool: ProvTool;
  polygonPoints: ProvPoint[];
  onPolygonPoints: (points: ProvPoint[]) => void;
  onSelect: (id: string | null) => void;
  onCreate: (selector: ProvSelector, counterKey: string) => string;
  onGeometry: (id: string, selector: ProvSelector) => void;
}

type ImageInteraction = {
  kind: 'draw' | 'move' | 'resize';
  start: ProvPoint;
  annotation?: ProvAnnotation;
  original?: Record<string, any>;
  handle?: string;
};

const ImageReviewSurface: React.FC<ImageSurfaceProps> = ({
  preview, annotations, selectedId, tool, polygonPoints, onPolygonPoints,
  onSelect, onCreate, onGeometry,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const interactionRef = useRef<ImageInteraction | null>(null);
  const [draft, setDraft] = useState<{ shape: ProvImageShape; start: ProvPoint; end: ProvPoint } | null>(null);
  const imageAnnotations = annotations.filter((item) => item.target.selector.type === 'image-region');

  const pointForEvent = (event: React.PointerEvent<SVGSVGElement | SVGElement>): ProvPoint => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };

  const startShapeInteraction = (event: React.PointerEvent<SVGElement>, annotation: ProvAnnotation, handle?: string) => {
    if (tool !== 'select') return;
    event.stopPropagation();
    const selector = annotation.target.selector;
    if (selector.type !== 'image-region') return;
    interactionRef.current = {
      kind: handle ? 'resize' : 'move', start: pointForEvent(event), annotation,
      original: JSON.parse(JSON.stringify(selector.geometry)), handle,
    };
    onSelect(annotation.id);
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = pointForEvent(event);
    if (tool === 'select') { onSelect(null); return; }
    if (tool === 'point') {
      onCreate({ type: 'image-region', shape: 'point', geometry: { unit: 'normalized', x: point.x, y: point.y } }, 'point');
      return;
    }
    if (tool === 'polygon') {
      onPolygonPoints([...polygonPoints, point]);
      return;
    }
    interactionRef.current = { kind: 'draw', start: point };
    setDraft({ shape: tool, start: point, end: point });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const point = pointForEvent(event);
    if (interaction.kind === 'draw') {
      setDraft((current) => current ? { ...current, end: point } : current);
      return;
    }
    const annotation = interaction.annotation;
    const original = interaction.original;
    if (!annotation || !original || annotation.target.selector.type !== 'image-region') return;
    const selector = annotation.target.selector;
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const next = JSON.parse(JSON.stringify(original)) as Record<string, any>;
    if (interaction.kind === 'move') {
      if (selector.shape === 'rectangle' || selector.shape === 'ellipse') {
        next.x = clamp(Number(original.x) + dx, 0, 1 - Number(original.width));
        next.y = clamp(Number(original.y) + dy, 0, 1 - Number(original.height));
      } else if (selector.shape === 'arrow') {
        const minX = Math.min(Number(original.x1), Number(original.x2));
        const maxX = Math.max(Number(original.x1), Number(original.x2));
        const minY = Math.min(Number(original.y1), Number(original.y2));
        const maxY = Math.max(Number(original.y1), Number(original.y2));
        const safeDx = clamp(dx, -minX, 1 - maxX);
        const safeDy = clamp(dy, -minY, 1 - maxY);
        next.x1 = Number(original.x1) + safeDx; next.x2 = Number(original.x2) + safeDx;
        next.y1 = Number(original.y1) + safeDy; next.y2 = Number(original.y2) + safeDy;
      } else if (selector.shape === 'point') {
        next.x = clamp(Number(original.x) + dx); next.y = clamp(Number(original.y) + dy);
      } else {
        const points = (original.points || []) as ProvPoint[];
        const minX = Math.min(...points.map((item) => item.x));
        const maxX = Math.max(...points.map((item) => item.x));
        const minY = Math.min(...points.map((item) => item.y));
        const maxY = Math.max(...points.map((item) => item.y));
        const safeDx = clamp(dx, -minX, 1 - maxX);
        const safeDy = clamp(dy, -minY, 1 - maxY);
        next.points = points.map((item) => ({ x: item.x + safeDx, y: item.y + safeDy }));
      }
    } else if (selector.shape === 'rectangle' || selector.shape === 'ellipse') {
      let x1 = Number(original.x), y1 = Number(original.y);
      let x2 = x1 + Number(original.width), y2 = y1 + Number(original.height);
      if (interaction.handle?.includes('n')) y1 = point.y;
      if (interaction.handle?.includes('s')) y2 = point.y;
      if (interaction.handle?.includes('w')) x1 = point.x;
      if (interaction.handle?.includes('e')) x2 = point.x;
      const left = clamp(Math.min(x1, x2)), top = clamp(Math.min(y1, y2));
      next.x = left; next.y = top;
      next.width = Math.max(0.005, clamp(Math.max(x1, x2)) - left);
      next.height = Math.max(0.005, clamp(Math.max(y1, y2)) - top);
    } else if (selector.shape === 'arrow') {
      if (interaction.handle === 'start') { next.x1 = point.x; next.y1 = point.y; }
      else { next.x2 = point.x; next.y2 = point.y; }
    } else if (selector.shape === 'polygon' && interaction.handle?.startsWith('p')) {
      const index = Number(interaction.handle.slice(1));
      next.points[index] = point;
    }
    onGeometry(annotation.id, { ...selector, geometry: next } as ProvSelector);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    if (!interaction || interaction.kind !== 'draw' || !draft) { setDraft(null); return; }
    const end = pointForEvent(event);
    if (draft.shape === 'arrow') {
      if (Math.hypot(end.x - draft.start.x, end.y - draft.start.y) > 0.01) {
        onCreate({ type: 'image-region', shape: 'arrow', geometry: {
          unit: 'normalized', x1: draft.start.x, y1: draft.start.y, x2: end.x, y2: end.y,
        } }, 'arrow');
      }
    } else {
      const x = Math.min(draft.start.x, end.x), y = Math.min(draft.start.y, end.y);
      const width = Math.abs(end.x - draft.start.x), height = Math.abs(end.y - draft.start.y);
      if (width > 0.006 && height > 0.006) {
        onCreate({ type: 'image-region', shape: draft.shape, geometry: {
          unit: 'normalized', x, y, width, height,
        } }, draft.shape);
      }
    }
    setDraft(null);
  };

  const dataUrl = `data:${preview.mimeType};base64,${preview.dataBase64}`;
  return (
    <div style={imageViewportStyle}>
      <div style={imageStageStyle}>
        <img src={dataUrl} alt="待审阅文件" draggable={false} style={reviewImageStyle} />
        <svg
          ref={svgRef} viewBox="0 0 1000 1000" preserveAspectRatio="none"
          style={{ ...svgOverlayStyle, cursor: tool === 'select' ? 'default' : 'crosshair' }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => { interactionRef.current = null; setDraft(null); }}
        >
          <defs>
            <marker id="prov-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L0,6 L7,3 z" fill="#f43f5e" />
            </marker>
          </defs>
          {imageAnnotations.map((annotation) => (
            <ImageAnnotationShape
              key={annotation.id} annotation={annotation} selected={annotation.id === selectedId}
              onPointerDown={(event, handle) => startShapeInteraction(event, annotation, handle)}
            />
          ))}
          {draft && <DraftShape draft={draft} />}
          {polygonPoints.length > 0 && (
            <g pointerEvents="none">
              <polyline points={polygonPoints.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')} fill="rgba(244,63,94,.1)" stroke="#f43f5e" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              {polygonPoints.map((point, index) => <circle key={index} cx={point.x * 1000} cy={point.y * 1000} r="7" fill="#f43f5e" vectorEffect="non-scaling-stroke" />)}
            </g>
          )}
        </svg>
        {imageAnnotations.map((annotation) => {
          const anchor = annotationAnchor(annotation);
          return <button key={`label-${annotation.id}`} style={{
            ...imageLabelStyle, left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%`,
            ...(annotation.id === selectedId ? imageLabelSelectedStyle : {}),
          }} onClick={() => onSelect(annotation.id)}>{annotation.ref}</button>;
        })}
      </div>
    </div>
  );
};

const ImageAnnotationShape: React.FC<{
  annotation: ProvAnnotation;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent<SVGElement>, handle?: string) => void;
}> = ({ annotation, selected, onPointerDown }) => {
  const selector = annotation.target.selector;
  if (selector.type !== 'image-region') return null;
  const g = selector.geometry;
  const stroke = selected ? '#38bdf8' : '#f43f5e';
  const common = {
    fill: selected ? 'rgba(56,189,248,.10)' : 'rgba(244,63,94,.08)',
    stroke, strokeWidth: selected ? 4 : 3, vectorEffect: 'non-scaling-stroke' as const,
    onPointerDown: (event: React.PointerEvent<SVGElement>) => onPointerDown(event),
  };
  let shape: React.ReactNode = null;
  if (selector.shape === 'rectangle') shape = <rect x={(g.x || 0) * 1000} y={(g.y || 0) * 1000} width={(g.width || 0) * 1000} height={(g.height || 0) * 1000} {...common} />;
  else if (selector.shape === 'ellipse') shape = <ellipse cx={((g.x || 0) + (g.width || 0) / 2) * 1000} cy={((g.y || 0) + (g.height || 0) / 2) * 1000} rx={(g.width || 0) * 500} ry={(g.height || 0) * 500} {...common} />;
  else if (selector.shape === 'arrow') shape = <line x1={(g.x1 || 0) * 1000} y1={(g.y1 || 0) * 1000} x2={(g.x2 || 0) * 1000} y2={(g.y2 || 0) * 1000} {...common} fill="none" markerEnd="url(#prov-arrow)" />;
  else if (selector.shape === 'point') shape = <circle cx={(g.x || 0) * 1000} cy={(g.y || 0) * 1000} r="13" {...common} fill={stroke} />;
  else shape = <polygon points={(g.points || []).map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')} {...common} />;

  const handles: React.ReactNode[] = [];
  if (selected && (selector.shape === 'rectangle' || selector.shape === 'ellipse')) {
    const x = (g.x || 0) * 1000, y = (g.y || 0) * 1000;
    const right = x + (g.width || 0) * 1000, bottom = y + (g.height || 0) * 1000;
    ([['nw', x, y], ['ne', right, y], ['sw', x, bottom], ['se', right, bottom]] as Array<[string, number, number]>).forEach(([name, cx, cy]) => {
      handles.push(<circle key={name} cx={cx} cy={cy} r="9" fill="#fff" stroke={stroke} strokeWidth="3" vectorEffect="non-scaling-stroke" onPointerDown={(event) => onPointerDown(event, name)} />);
    });
  } else if (selected && selector.shape === 'arrow') {
    handles.push(<circle key="start" cx={(g.x1 || 0) * 1000} cy={(g.y1 || 0) * 1000} r="9" fill="#fff" stroke={stroke} strokeWidth="3" onPointerDown={(event) => onPointerDown(event, 'start')} />);
    handles.push(<circle key="end" cx={(g.x2 || 0) * 1000} cy={(g.y2 || 0) * 1000} r="9" fill="#fff" stroke={stroke} strokeWidth="3" onPointerDown={(event) => onPointerDown(event, 'end')} />);
  } else if (selected && selector.shape === 'polygon') {
    (g.points || []).forEach((point, index) => handles.push(
      <circle key={index} cx={point.x * 1000} cy={point.y * 1000} r="8" fill="#fff" stroke={stroke} strokeWidth="3" onPointerDown={(event) => onPointerDown(event, `p${index}`)} />,
    ));
  }
  return <g>{shape}{handles}</g>;
};

const DraftShape: React.FC<{ draft: { shape: ProvImageShape; start: ProvPoint; end: ProvPoint } }> = ({ draft }) => {
  const x = Math.min(draft.start.x, draft.end.x) * 1000;
  const y = Math.min(draft.start.y, draft.end.y) * 1000;
  const width = Math.abs(draft.end.x - draft.start.x) * 1000;
  const height = Math.abs(draft.end.y - draft.start.y) * 1000;
  const common = { fill: 'rgba(244,63,94,.08)', stroke: '#f43f5e', strokeWidth: 3, strokeDasharray: '8 5', vectorEffect: 'non-scaling-stroke' as const };
  if (draft.shape === 'arrow') return <line x1={draft.start.x * 1000} y1={draft.start.y * 1000} x2={draft.end.x * 1000} y2={draft.end.y * 1000} {...common} markerEnd="url(#prov-arrow)" />;
  if (draft.shape === 'ellipse') return <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} {...common} />;
  return <rect x={x} y={y} width={width} height={height} {...common} />;
};

interface TextBlock {
  index: number;
  text: string;
  raw: string;
  kind: 'heading' | 'paragraph' | 'code';
  headingLevel: number;
  headingPath: string[];
  prefixOffset: number;
}

function parseTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const headingPath: string[] = [];
  let paragraph: string[] = [];
  let code: string[] = [];
  let inCode = false;
  const push = (raw: string, display: string, kind: TextBlock['kind'], headingLevel = 0, prefixOffset = 0) => {
    blocks.push({
      index: blocks.length, text: display, raw, kind, headingLevel,
      headingPath: headingPath.filter(Boolean), prefixOffset,
    });
  };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const raw = paragraph.join('\n').trimEnd();
    if (raw.trim()) push(raw, raw, 'paragraph');
    paragraph = [];
  };
  const flushCode = () => {
    if (!code.length) return;
    const raw = code.join('\n');
    push(raw, raw, 'code');
    code = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!inCode) { flushParagraph(); inCode = true; code = [line]; }
      else { code.push(line); inCode = false; flushCode(); }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const display = heading[2];
      headingPath.splice(level - 1);
      headingPath[level - 1] = display;
      push(line, display, 'heading', level, line.indexOf(display));
    } else if (!line.trim()) flushParagraph();
    else paragraph.push(line);
  }
  flushParagraph(); flushCode();
  return blocks;
}

async function fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const TextReviewSurface: React.FC<{
  preview: Extract<ProvSourcePreview, { kind: 'markdown' | 'text' }>;
  annotations: ProvAnnotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (selector: ProvSelector, counterKey: string) => string;
  onNotice: (text: string) => void;
}> = ({ preview, annotations, selectedId, onSelect, onCreate, onNotice }) => {
  const blocks = useMemo(() => parseTextBlocks(preview.text), [preview.text]);
  const textAnnotations = annotations.filter((item) => {
    const type = item.target.selector.type;
    return type === 'text-block' || type === 'text-range';
  });

  const addBlock = async (block: TextBlock) => {
    onCreate({
      type: 'text-block', headingPath: block.headingPath,
      blockFingerprint: await fingerprint(block.text), exactQuote: block.text,
      startOffset: 0, endOffset: block.text.length, blockIndex: block.index,
    }, 'block');
  };

  const selectText = async (block: TextBlock, element: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const startBlock = range.startContainer.parentElement?.closest('[data-prov-block]');
    const endBlock = range.endContainer.parentElement?.closest('[data-prov-block]');
    if (startBlock !== element || endBlock !== element) {
      onNotice('首期请在同一个段落内选择文字；跨段意见可先创建段落级总体意见。');
      selection.removeAllRanges();
      return;
    }
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const startOffset = before.toString().length;
    const selectedText = range.toString();
    const endOffset = startOffset + selectedText.length;
    if (!selectedText.trim() || endOffset <= startOffset) return;
    const prefix = block.text.slice(Math.max(0, startOffset - 24), startOffset);
    const suffix = block.text.slice(endOffset, endOffset + 24);
    onCreate({
      type: 'text-range', headingPath: block.headingPath,
      blockFingerprint: await fingerprint(block.text), exactQuote: selectedText,
      prefix, suffix, startOffset, endOffset, blockIndex: block.index,
    }, 'text');
    selection.removeAllRanges();
  };

  return (
    <div style={textSurfaceStyle} onClick={(event) => { if (event.target === event.currentTarget) onSelect(null); }}>
      {preview.truncated && <div style={textWarningStyle}>文件过长，当前只审阅预览范围；请勿把截断位置后的意见视为已覆盖。</div>}
      {blocks.map((block) => {
        const related = textAnnotations.filter((item) => {
          const selector = item.target.selector;
          if (selector.type !== 'text-block' && selector.type !== 'text-range') return false;
          const expected = selector.blockIndex == null ? undefined : blocks[selector.blockIndex];
          if (expected && expected.text.includes(selector.exactQuote)) return expected.index === block.index;
          if (!selector.exactQuote) return selector.blockIndex === block.index;
          const relocated = blocks.filter((candidate) => candidate.text.includes(selector.exactQuote));
          return relocated.length === 1 && relocated[0].index === block.index;
        });
        return (
          <div key={block.index} data-prov-block-row style={{ ...textBlockRowStyle, ...(related.some((item) => item.id === selectedId) ? textBlockSelectedStyle : {}) }}>
            <button style={blockAddButtonStyle} title="添加段落级意见" onClick={() => void addBlock(block)}>＋</button>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                data-prov-block={block.index}
                style={textBlockStyle(block)}
                onMouseUp={(event) => void selectText(block, event.currentTarget)}
              >
                <HighlightedText text={block.text} annotations={related} selectedId={selectedId} onSelect={onSelect} />
              </div>
              {related.length > 0 && (
                <div style={inlineRefsStyle}>
                  {related.map((item) => <button key={item.id} style={{ ...inlineRefStyle, ...(item.id === selectedId ? inlineRefActiveStyle : {}) }} onClick={() => onSelect(item.id)}>{item.ref}</button>)}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {blocks.length === 0 && <EmptySurface text="文件没有可审阅的文本" />}
    </div>
  );
};

const HighlightedText: React.FC<{
  text: string; annotations: ProvAnnotation[]; selectedId: string | null; onSelect: (id: string) => void;
}> = ({ text, annotations, selectedId, onSelect }) => {
  const ranges = annotations.flatMap((annotation) => {
    const selector = annotation.target.selector;
    if (selector.type !== 'text-block' && selector.type !== 'text-range') return [];
    let start = selector.startOffset || 0;
    let end = selector.endOffset || text.length;
    if (selector.exactQuote && text.slice(start, end) !== selector.exactQuote) {
      const found = text.indexOf(selector.exactQuote);
      if (found >= 0 && text.indexOf(selector.exactQuote, found + 1) < 0) {
        start = found; end = found + selector.exactQuote.length;
      }
    }
    return [{ annotation, start: clamp(start, 0, text.length), end: clamp(end, 0, text.length) }];
  }).filter((range) => range.end > range.start);
  if (!ranges.length) return <>{text}</>;
  const boundaries = Array.from(new Set([0, text.length, ...ranges.flatMap((range) => [range.start, range.end])])).sort((a, b) => a - b);
  return <>{boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const covering = ranges.filter((range) => range.start <= start && range.end >= end);
    if (!covering.length) return <React.Fragment key={start}>{text.slice(start, end)}</React.Fragment>;
    const active = covering.find((range) => range.annotation.id === selectedId) || covering[0];
    return <mark key={start} title={covering.map((range) => range.annotation.ref).join('、')} style={{
      background: active.annotation.id === selectedId ? 'rgba(56,189,248,.34)' : 'rgba(250,204,21,.28)',
      color: 'inherit', padding: '1px 0', cursor: 'pointer',
      borderBottom: active.annotation.id === selectedId ? '1px solid #38bdf8' : '1px solid #eab308',
    }} onClick={(event) => { event.stopPropagation(); onSelect(active.annotation.id); }}>{text.slice(start, end)}</mark>;
  })}</>;
};

const AnnotationTree: React.FC<{
  document: ProvDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddGlobal: () => void;
}> = ({ document, selectedId, onSelect, onAddGlobal }) => {
  const byParent = useMemo(() => {
    const map = new Map<string | null, ProvAnnotation[]>();
    for (const item of document.annotations) {
      const key = item.parentId || null;
      const group = map.get(key) || [];
      group.push(item); map.set(key, group);
    }
    for (const group of map.values()) group.sort((a, b) => a.order - b.order);
    return map;
  }, [document.annotations]);
  const render = (parentId: string | null, depth: number): React.ReactNode => (
    (byParent.get(parentId) || []).map((item) => (
      <React.Fragment key={item.id}>
        <button style={{ ...treeItemStyle, paddingLeft: 10 + depth * 15, ...(selectedId === item.id ? treeItemActiveStyle : {}) }} onClick={() => onSelect(item.id)}>
          <span style={annotationDotStyle(item)} />
          <strong style={{ flexShrink: 0 }}>{item.ref}</strong>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--theme-text-muted)' }}>
            {item.title || item.body.comment || selectorLabel(item.target.selector)}
          </span>
        </button>
        {render(item.id, depth + 1)}
      </React.Fragment>
    ))
  );
  return (
    <div style={treeStyle}>
      <div style={panelTitleStyle}>
        <span>审阅意见</span><span style={countBadgeStyle}>{document.annotations.length}</span>
        <div style={{ flex: 1 }} />
        <button style={smallIconButtonStyle} onClick={onAddGlobal} title="添加文件总体意见">＋总体</button>
      </div>
      <div style={{ overflow: 'auto', minHeight: 70, maxHeight: '42%' }}>
        {document.annotations.length ? render(null, 0) : <div style={treeEmptyStyle}>尚无意见</div>}
      </div>
    </div>
  );
};

const AnnotationEditor: React.FC<{
  document: ProvDocument;
  annotation: ProvAnnotation;
  onChange: (patch: Partial<ProvAnnotation>) => void;
  onDelete: () => void;
}> = ({ document, annotation, onChange, onDelete }) => {
  const excluded = descendantsOf(document, annotation.id);
  excluded.add(annotation.id);
  return (
    <div style={annotationEditorStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={annotationRefStyle}>{annotation.ref}</span>
        <span style={{ ...subtleStyle, flex: 1 }}>{selectorLabel(annotation.target.selector)}</span>
        <button style={deleteButtonStyle} onClick={onDelete}>删除</button>
      </div>
      <label style={fieldLabelStyle}>标题（可选）
        <input style={inputStyle} value={annotation.title} placeholder="例如：主操作按钮" onChange={(event) => onChange({ title: event.target.value })} />
      </label>
      <label style={fieldLabelStyle}>归属意见
        <select style={inputStyle} value={annotation.parentId || ''} onChange={(event) => onChange({ parentId: event.target.value || null })}>
          <option value="">顶层意见</option>
          {document.annotations.filter((item) => !excluded.has(item.id)).map((item) => <option key={item.id} value={item.id}>{item.ref} · {item.title || item.body.comment || selectorLabel(item.target.selector)}</option>)}
        </select>
      </label>
      <div style={twoColumnStyle}>
        <label style={fieldLabelStyle}>意见类型
          <select style={inputStyle} value={annotation.body.kind} onChange={(event) => onChange({ body: { ...annotation.body, kind: event.target.value as ProvAnnotation['body']['kind'] } })}>
            <option value="change_request">修改要求</option><option value="comment">建议</option>
            <option value="question">问题</option><option value="approval">认可</option>
          </select>
        </label>
        <label style={fieldLabelStyle}>严重程度
          <select style={inputStyle} value={annotation.body.severity} onChange={(event) => onChange({ body: { ...annotation.body, severity: event.target.value as ProvAnnotation['body']['severity'] } })}>
            <option value="minor">轻微</option><option value="normal">一般</option>
            <option value="major">重要</option><option value="critical">严重</option>
          </select>
        </label>
      </div>
      <label style={fieldLabelStyle}>审阅意见
        <textarea style={textareaStyle} value={annotation.body.comment} placeholder="说明问题或判断；这是 Agent 后续执行的主要依据。" onChange={(event) => onChange({ body: { ...annotation.body, comment: event.target.value } })} />
      </label>
      <label style={fieldLabelStyle}>期望结果（可选）
        <textarea style={{ ...textareaStyle, minHeight: 62 }} value={annotation.body.expected} placeholder="说明修改后应达到什么效果。" onChange={(event) => onChange({ body: { ...annotation.body, expected: event.target.value } })} />
      </label>
      <div style={twoColumnStyle}>
        <label style={fieldLabelStyle}>处理状态
          <select style={inputStyle} value={annotation.status} onChange={(event) => onChange({ status: event.target.value as ProvAnnotation['status'] })}>
            <option value="open">待处理</option><option value="addressed">Agent 称已处理</option>
            <option value="verified">用户已验证</option><option value="dismissed">已忽略</option>
          </select>
        </label>
        <label style={{ ...fieldLabelStyle, justifyContent: 'flex-end' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 31 }}>
            <input type="checkbox" checked={annotation.body.blocking} onChange={(event) => onChange({ body: { ...annotation.body, blocking: event.target.checked } })} />
            阻断审批
          </span>
        </label>
      </div>
    </div>
  );
};

const EmptySurface: React.FC<{ text: string }> = ({ text }) => <div style={{ padding: 36, textAlign: 'center', color: 'var(--theme-text-muted)' }}>{text}</div>;

function reviewStateLabel(state: ProvReviewState): string {
  return {
    draft: '草稿', changes_requested: '需修改', conditionally_approved: '有条件通过',
    approved: '已通过', rejected: '已拒绝',
  }[state];
}

function stateBadgeStyle(state: ProvReviewState): React.CSSProperties {
  const color = state === 'approved' ? '#22c55e' : state === 'changes_requested' ? '#f59e0b' : state === 'rejected' ? '#ef4444' : '#60a5fa';
  return { color, border: `1px solid ${color}66`, background: `${color}14`, padding: '3px 7px', borderRadius: 4, fontSize: 10.5, flexShrink: 0 };
}

function annotationDotStyle(annotation: ProvAnnotation): React.CSSProperties {
  const color = annotation.status === 'verified' ? '#22c55e' : annotation.status === 'dismissed' ? '#64748b' : annotation.body.blocking ? '#ef4444' : '#f59e0b';
  return { width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 };
}

function textBlockStyle(block: TextBlock): React.CSSProperties {
  if (block.kind === 'heading') return { fontSize: Math.max(16, 25 - block.headingLevel * 1.6), fontWeight: 700, lineHeight: 1.45, whiteSpace: 'pre-wrap', color: 'var(--theme-text)' };
  if (block.kind === 'code') return { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.65, background: 'var(--theme-code-bg)', padding: 10, border: '1px solid var(--theme-border)' };
  return { whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8, color: 'var(--theme-text)' };
}

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 10120, background: 'rgba(2,6,23,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const workbenchStyle: React.CSSProperties = { width: '96vw', height: '94vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--theme-bg-secondary, #111827)', color: 'var(--theme-text, #e5e7eb)', border: '1px solid var(--theme-border, #334155)', borderRadius: 6, boxShadow: '0 22px 70px rgba(0,0,0,.55)', position: 'relative' };
const headerStyle: React.CSSProperties = { height: 54, padding: '0 13px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)' };
const subtleStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const headerButtonStyle: React.CSSProperties = { border: '1px solid var(--theme-border)', background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', padding: '6px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer', flexShrink: 0 };
const closeButtonStyle: React.CSSProperties = { width: 30, height: 30, border: 'none', background: 'transparent', color: 'var(--theme-text-muted)', fontSize: 22, cursor: 'pointer', flexShrink: 0 };
const warningStyle: React.CSSProperties = { minHeight: 38, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 10, color: '#fbbf24', background: 'rgba(245,158,11,.10)', borderBottom: '1px solid rgba(245,158,11,.35)', fontSize: 11.5, flexShrink: 0 };
const warningButtonStyle: React.CSSProperties = { border: '1px solid rgba(245,158,11,.45)', background: 'rgba(245,158,11,.10)', color: '#fbbf24', padding: '4px 7px', borderRadius: 3, cursor: 'pointer', fontSize: 10.5 };
const mainStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr) minmax(310px, 25vw)', flex: 1, minHeight: 0 };
const toolRailStyle: React.CSSProperties = { padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 5, borderRight: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)', overflowY: 'auto' };
const toolButtonStyle: React.CSSProperties = { minHeight: 50, padding: '5px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, border: '1px solid transparent', borderRadius: 4, color: 'var(--theme-text-muted)', background: 'transparent', cursor: 'pointer', fontSize: 9.5 };
const toolButtonActiveStyle: React.CSSProperties = { color: 'var(--theme-accent, #38bdf8)', borderColor: 'color-mix(in srgb, var(--theme-accent, #38bdf8) 45%, transparent)', background: 'var(--theme-accent-bg, rgba(56,189,248,.10))' };
const surfaceStyle: React.CSSProperties = { minWidth: 0, minHeight: 0, overflow: 'hidden', background: '#0b1220' };
const rightPanelStyle: React.CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--theme-border)', background: 'var(--theme-bg-secondary)' };
const treeStyle: React.CSSProperties = { maxHeight: '45%', minHeight: 120, display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--theme-border)' };
const panelTitleStyle: React.CSSProperties = { height: 38, padding: '0 9px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, borderBottom: '1px solid var(--theme-border)', flexShrink: 0 };
const countBadgeStyle: React.CSSProperties = { padding: '1px 5px', borderRadius: 8, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text-muted)', fontSize: 9.5 };
const smallIconButtonStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: 'var(--theme-accent, #38bdf8)', cursor: 'pointer', fontSize: 10.5 };
const treeItemStyle: React.CSSProperties = { width: '100%', minHeight: 30, paddingRight: 8, display: 'flex', alignItems: 'center', gap: 6, border: 'none', borderBottom: '1px solid color-mix(in srgb, var(--theme-border) 50%, transparent)', background: 'transparent', color: 'var(--theme-text)', textAlign: 'left', cursor: 'pointer', fontSize: 10.5 };
const treeItemActiveStyle: React.CSSProperties = { background: 'var(--theme-accent-bg, rgba(56,189,248,.10))', color: 'var(--theme-accent, #38bdf8)' };
const treeEmptyStyle: React.CSSProperties = { padding: 22, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 11 };
const editorAreaStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };
const annotationEditorStyle: React.CSSProperties = { padding: 11, display: 'flex', flexDirection: 'column', gap: 10 };
const annotationRefStyle: React.CSSProperties = { padding: '3px 7px', color: '#fff', background: '#e11d48', borderRadius: 3, fontSize: 10.5, fontWeight: 700 };
const deleteButtonStyle: React.CSSProperties = { border: 'none', background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: 10.5 };
const fieldLabelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--theme-text-muted)', fontSize: 10.5 };
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--theme-border)', borderRadius: 3, background: 'var(--theme-bg-tertiary)', color: 'var(--theme-text)', padding: '6px 7px', fontSize: 11.5, outline: 'none' };
const textareaStyle: React.CSSProperties = { ...inputStyle, minHeight: 86, resize: 'vertical', lineHeight: 1.55, fontFamily: 'inherit' };
const twoColumnStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 };
const footerStyle: React.CSSProperties = { height: 30, padding: '0 11px', display: 'flex', alignItems: 'center', gap: 15, flexShrink: 0, color: 'var(--theme-text-muted)', borderTop: '1px solid var(--theme-border)', fontSize: 9.5 };
const imageViewportStyle: React.CSSProperties = { width: '100%', height: '100%', padding: 18, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' };
const imageStageStyle: React.CSSProperties = { position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '100%', lineHeight: 0, boxShadow: '0 8px 28px rgba(0,0,0,.42)' };
const reviewImageStyle: React.CSSProperties = { display: 'block', maxWidth: '100%', maxHeight: 'calc(94vh - 130px)', userSelect: 'none' };
const svgOverlayStyle: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' };
const imageLabelStyle: React.CSSProperties = { position: 'absolute', transform: 'translate(0,-100%)', zIndex: 4, border: 'none', borderRadius: 3, padding: '3px 6px', color: '#fff', background: '#be123c', fontSize: 10, lineHeight: 1.2, fontWeight: 700, cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,.35)' };
const imageLabelSelectedStyle: React.CSSProperties = { background: '#0284c7', outline: '2px solid rgba(56,189,248,.45)' };
const textSurfaceStyle: React.CSSProperties = { height: '100%', overflow: 'auto', maxWidth: 900, margin: '0 auto', padding: '24px 34px 80px', boxSizing: 'border-box', background: 'var(--theme-bg-secondary)', color: 'var(--theme-text)' };
const textWarningStyle: React.CSSProperties = { marginBottom: 16, padding: 9, border: '1px solid rgba(245,158,11,.35)', color: '#fbbf24', background: 'rgba(245,158,11,.08)', fontSize: 11 };
const textBlockRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 7, margin: '5px 0', padding: '7px 8px', borderLeft: '2px solid transparent' };
const textBlockSelectedStyle: React.CSSProperties = { borderLeftColor: '#38bdf8', background: 'rgba(56,189,248,.05)' };
const blockAddButtonStyle: React.CSSProperties = { width: 23, height: 23, marginTop: 1, border: '1px solid var(--theme-border)', background: 'transparent', color: 'var(--theme-text-muted)', borderRadius: 3, cursor: 'pointer', flexShrink: 0 };
const inlineRefsStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 };
const inlineRefStyle: React.CSSProperties = { border: '1px solid rgba(234,179,8,.35)', borderRadius: 3, padding: '2px 5px', color: '#eab308', background: 'rgba(234,179,8,.07)', fontSize: 9, cursor: 'pointer' };
const inlineRefActiveStyle: React.CSSProperties = { borderColor: '#38bdf8', color: '#38bdf8', background: 'rgba(56,189,248,.08)' };
const noticeStyle = (kind: Notice['kind']): React.CSSProperties => ({ position: 'absolute', left: '50%', bottom: 42, transform: 'translateX(-50%)', zIndex: 20, maxWidth: '70%', padding: '8px 12px', color: kind === 'error' ? '#fecaca' : kind === 'ok' ? '#bbf7d0' : '#bae6fd', background: kind === 'error' ? 'rgba(127,29,29,.95)' : kind === 'ok' ? 'rgba(20,83,45,.95)' : 'rgba(12,74,110,.95)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, boxShadow: '0 7px 24px rgba(0,0,0,.35)', fontSize: 11.5 });
const workOrderOverlayStyle: React.CSSProperties = { position: 'absolute', inset: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,6,23,.72)' };
const workOrderBoxStyle: React.CSSProperties = { width: '72%', maxWidth: 920, height: '78%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--theme-bg-secondary)', border: '1px solid var(--theme-border)', borderRadius: 5, boxShadow: '0 20px 60px rgba(0,0,0,.55)' };
const workOrderPreStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 17, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--theme-text)', background: 'var(--theme-code-bg)', fontSize: 11.5, lineHeight: 1.7 };

export default ReviewWorkbench;
