import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface ExcelBorder {
  style?: string;
  color?: string;
}

export interface ExcelCellStyle {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  horizontal?: string;
  vertical?: string;
  wrap?: boolean;
  rotation?: number;
  numberFormat?: string;
  borders?: Record<string, ExcelBorder>;
}

export interface ExcelCell {
  address: string;
  row: number;
  column: number;
  value: string;
  rawValue?: string;
  formula?: string;
  formulaCached?: boolean;
  type?: string;
  style?: number;
}

export interface ExcelRow {
  index: number;
  height?: number;
  hidden?: boolean;
  cells: ExcelCell[];
}

export interface ExcelColumn {
  index: number;
  width?: number;
  hidden?: boolean;
}

export interface ExcelMerge {
  ref: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface ExcelSheet {
  name: string;
  rows: ExcelRow[];
  columns?: ExcelColumn[];
  merges?: ExcelMerge[];
  rowCount?: number;
  columnCount?: number;
  defaultRowHeight?: number;
  defaultColumnWidth?: number;
  formulaCount?: number;
  cachedFormulaCount?: number;
  autoFilter?: string;
  frozen?: { rows?: number; columns?: number; topLeftCell?: string };
}

interface Props {
  sheets: ExcelSheet[];
  styles?: ExcelCellStyle[];
  calculation?: { mode?: string; date1904?: boolean };
}

type Coordinate = { row: number; column: number };

const MIN_ROWS = 24;
const MIN_COLUMNS = 10;
const MAX_ROWS = 300;
const MAX_COLUMNS = 60;
const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 28;

function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function addressOf(row: number, column: number): string {
  return `${columnName(column)}${row}`;
}

function borderCss(edge?: ExcelBorder): string | undefined {
  if (!edge?.style) return undefined;
  const width = edge.style === 'medium' ? 2 : edge.style === 'thick' ? 3 : 1;
  const line = edge.style.includes('dash') ? 'dashed' : edge.style.includes('dot') ? 'dotted' : 'solid';
  return `${width}px ${line} ${edge.color || '#9aa0a6'}`;
}

function workbookCellStyle(style: ExcelCellStyle | undefined, cell: ExcelCell | undefined): React.CSSProperties {
  const horizontal: React.CSSProperties['textAlign'] = style?.horizontal === 'center'
    ? 'center' : style?.horizontal === 'right' ? 'right' : style?.horizontal === 'justify' ? 'justify'
      : cell?.type === 'number' || (!cell?.type && cell?.rawValue !== '') ? 'right' : 'left';
  const result: React.CSSProperties = {
    background: style?.fill || '#ffffff',
    color: style?.color || '#202124',
    fontWeight: style?.bold ? 700 : 400,
    fontStyle: style?.italic ? 'italic' : 'normal',
    textDecoration: style?.underline ? 'underline' : undefined,
    fontSize: style?.fontSize ? `${style.fontSize}px` : 12,
    textAlign: horizontal,
    verticalAlign: style?.vertical === 'top' ? 'top' : style?.vertical === 'center' ? 'middle' : 'bottom',
    whiteSpace: style?.wrap ? 'pre-wrap' : 'nowrap',
  };
  const borderLeft = borderCss(style?.borders?.left);
  const borderRight = borderCss(style?.borders?.right);
  const borderTop = borderCss(style?.borders?.top);
  const borderBottom = borderCss(style?.borders?.bottom);
  if (borderLeft) result.borderLeft = borderLeft;
  if (borderRight) result.borderRight = borderRight;
  if (borderTop) result.borderTop = borderTop;
  if (borderBottom) result.borderBottom = borderBottom;
  return result;
}

export const ExcelPreview: React.FC<Props> = ({ sheets, styles = [], calculation }) => {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<Coordinate>({ row: 1, column: 0 });
  const [zoom, setZoom] = useState(100);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const safeActive = Math.min(active, Math.max(0, sheets.length - 1));
  const sheet = sheets[safeActive];

  useEffect(() => {
    setActive(0);
    setSelected({ row: 1, column: 0 });
  }, [sheets]);

  useEffect(() => {
    setMatchIndex(0);
  }, [query, safeActive]);

  const model = useMemo(() => {
    const rows = new Map<number, ExcelRow>();
    const cells = new Map<string, ExcelCell>();
    const columns = new Map<number, ExcelColumn>();
    for (const row of sheet?.rows || []) {
      rows.set(row.index, row);
      for (const cell of row.cells || []) cells.set(`${cell.row}:${cell.column}`, cell);
    }
    for (const column of sheet?.columns || []) columns.set(column.index, column);
    const mergeAnchors = new Map<string, ExcelMerge>();
    const mergeCovered = new Set<string>();
    for (const merge of sheet?.merges || []) {
      mergeAnchors.set(`${merge.startRow}:${merge.startColumn}`, merge);
      for (let row = merge.startRow; row <= merge.endRow; row += 1) {
        for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
          if (row !== merge.startRow || column !== merge.startColumn) mergeCovered.add(`${row}:${column}`);
        }
      }
    }
    const rowCount = Math.min(MAX_ROWS, Math.max(MIN_ROWS, sheet?.rowCount || 0));
    const columnCount = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, sheet?.columnCount || 0));
    return { rows, cells, columns, mergeAnchors, mergeCovered, rowCount, columnCount };
  }, [sheet]);

  const scale = zoom / 100;
  const columnWidths = useMemo(() => Array.from({ length: model.columnCount }, (_, index) => {
    const column = model.columns.get(index);
    if (column?.hidden) return 0;
    const units = column?.width || sheet?.defaultColumnWidth || 9;
    return Math.round(Math.max(52, Math.min(520, units * 7 + 10)) * scale);
  }), [model, sheet, scale]);
  const rowHeights = useMemo(() => Array.from({ length: model.rowCount + 1 }, (_, index) => {
    const row = model.rows.get(index);
    if (row?.hidden) return 0;
    const points = row?.height || sheet?.defaultRowHeight || 15;
    return Math.round(Math.max(22, Math.min(240, points * 1.333)) * scale);
  }), [model, sheet, scale]);

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [] as ExcelCell[];
    return [...model.cells.values()].filter((cell) => (
      `${cell.value || ''}\n${cell.formula || ''}`.toLocaleLowerCase().includes(needle)
    ));
  }, [model, query]);
  const matchKeys = useMemo(() => new Set(matches.map((cell) => `${cell.row}:${cell.column}`)), [matches]);

  const selectedCell = model.cells.get(`${selected.row}:${selected.column}`);
  const selectedAddress = selectedCell?.address || addressOf(selected.row, selected.column);
  const formulaText = selectedCell?.formula
    ? (selectedCell.formula.startsWith('[') ? selectedCell.formula : `=${selectedCell.formula}`)
    : (selectedCell?.value || '');

  const selectCell = (row: number, column: number, reveal = false) => {
    const next = {
      row: Math.max(1, Math.min(model.rowCount, row)),
      column: Math.max(0, Math.min(model.columnCount - 1, column)),
    };
    setSelected(next);
    if (reveal) {
      requestAnimationFrame(() => {
        gridRef.current?.querySelector<HTMLElement>(`[data-cell="${addressOf(next.row, next.column)}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
  };

  const moveMatch = (delta: number) => {
    if (!matches.length) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    selectCell(matches[next].row, matches[next].column, true);
  };

  const copySelected = () => {
    const text = selectedCell?.formula ? formulaText : (selectedCell?.value || '');
    if (text && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => undefined);
  };

  if (!sheet) return <div style={emptyStyle}>工作簿没有可显示的工作表</div>;

  const frozenRows = Math.min(8, Math.max(0, sheet.frozen?.rows || 0));
  const frozenColumns = Math.min(5, Math.max(0, sheet.frozen?.columns || 0));
  const frozenTop = (row: number) => COLUMN_HEADER_HEIGHT + rowHeights.slice(1, row).reduce((sum, value) => sum + value, 0);
  const frozenLeft = (column: number) => ROW_HEADER_WIDTH + columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0);

  return (
    <section style={shellStyle} onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        copySelected();
        return;
      }
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      const movement: Record<string, Coordinate> = {
        ArrowUp: { row: -1, column: 0 }, ArrowDown: { row: 1, column: 0 },
        ArrowLeft: { row: 0, column: -1 }, ArrowRight: { row: 0, column: 1 },
        Enter: { row: event.shiftKey ? -1 : 1, column: 0 },
      };
      const delta = movement[event.key];
      if (delta) {
        event.preventDefault();
        selectCell(selected.row + delta.row, selected.column + delta.column, true);
      }
    }} tabIndex={0}>
      <header style={toolbarStyle}>
        <div style={workbookIdentityStyle}>
          <span style={workbookIconStyle}>▦</span>
          <strong style={{ fontSize: 12 }}>电子表格预览</strong>
          <span style={metaPillStyle}>{sheet.rowCount || 0} 行 × {sheet.columnCount || 0} 列</span>
          {!!sheet.formulaCount && (
            <span style={metaPillStyle}>fx {sheet.cachedFormulaCount || 0}/{sheet.formulaCount} 已有结果</span>
          )}
          {!!(sheet.frozen?.rows || sheet.frozen?.columns) && <span style={metaPillStyle}>❄ 已冻结窗格</span>}
        </div>
        <div style={toolbarActionsStyle}>
          <div style={searchBoxStyle}>
            <span style={{ opacity: .7 }}>⌕</span>
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') moveMatch(event.shiftKey ? -1 : 1); }}
              placeholder="在当前工作表查找" style={searchInputStyle} />
            {query && <span style={searchCountStyle}>{matches.length ? `${Math.min(matchIndex + 1, matches.length)}/${matches.length}` : '0'}</span>}
            <button style={iconButtonStyle} onClick={() => moveMatch(-1)} disabled={!matches.length} title="上一个">↑</button>
            <button style={iconButtonStyle} onClick={() => moveMatch(1)} disabled={!matches.length} title="下一个">↓</button>
          </div>
          <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} style={zoomSelectStyle} title="缩放">
            {[75, 90, 100, 110, 125, 150].map((value) => <option key={value} value={value}>{value}%</option>)}
          </select>
        </div>
      </header>

      <div style={formulaBarStyle}>
        <div style={nameBoxStyle}>{selectedAddress}</div>
        <button style={copyButtonStyle} onClick={copySelected} title="复制公式或单元格值">复制</button>
        <div style={fxBadgeStyle}>fx</div>
        <div style={{ ...formulaValueStyle, color: selectedCell?.formula && selectedCell.formulaCached === false ? '#b54708' : '#202124' }}
          title={formulaText || selectedAddress}>
          {formulaText || <span style={{ color: '#9aa0a6' }}>选择单元格查看内容或公式</span>}
        </div>
        {selectedCell?.formula && selectedCell.formulaCached === false && <span style={notCalculatedStyle}>文件未保存计算结果</span>}
      </div>

      <div ref={gridRef} style={gridViewportStyle}>
        <table style={gridStyle} aria-label={`工作表 ${sheet.name}`}>
          <colgroup>
            <col style={{ width: ROW_HEADER_WIDTH }} />
            {columnWidths.map((width, index) => <col key={index} style={{ width, display: width ? undefined : 'none' }} />)}
          </colgroup>
          <thead>
            <tr style={{ height: COLUMN_HEADER_HEIGHT }}>
              <th style={cornerStyle}></th>
              {columnWidths.map((width, column) => width > 0 && (
                <th key={column} style={{
                  ...columnHeaderStyle,
                  width,
                  ...(column < frozenColumns ? { left: frozenLeft(column), zIndex: 8 } : {}),
                  ...(selected.column === column ? activeHeaderStyle : {}),
                }}>{columnName(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: model.rowCount }, (_, offset) => offset + 1).map((row) => {
              const rowMeta = model.rows.get(row);
              const height = rowHeights[row];
              if (!height || rowMeta?.hidden) return null;
              const frozenRowStyle: React.CSSProperties = row <= frozenRows
                ? { position: 'sticky', top: frozenTop(row), zIndex: 5 } : {};
              return (
                <tr key={row} style={{ height }}>
                  <th style={{
                    ...rowHeaderStyle, height, ...frozenRowStyle,
                    ...(selected.row === row ? activeHeaderStyle : {}),
                  }}>{row}</th>
                  {columnWidths.map((width, column) => {
                    if (!width || model.mergeCovered.has(`${row}:${column}`)) return null;
                    const cell = model.cells.get(`${row}:${column}`);
                    const merge = model.mergeAnchors.get(`${row}:${column}`);
                    const style = styles[cell?.style || 0];
                    const isSelected = selected.row === row && selected.column === column;
                    const isMatch = matchKeys.has(`${row}:${column}`);
                    const sticky: React.CSSProperties = {
                      ...(row <= frozenRows ? { position: 'sticky', top: frozenTop(row), zIndex: 4 } : {}),
                      ...(column < frozenColumns ? { position: 'sticky', left: frozenLeft(column), zIndex: row <= frozenRows ? 6 : 3 } : {}),
                    };
                    const visibleValue = cell?.formula && cell.formulaCached === false ? '#未计算' : (cell?.value || '');
                    return (
                      <td key={column} rowSpan={merge ? merge.endRow - merge.startRow + 1 : undefined}
                        colSpan={merge ? merge.endColumn - merge.startColumn + 1 : undefined}
                        data-cell={addressOf(row, column)}
                        onClick={() => selectCell(row, column)}
                        title={cell?.formula ? `${cell.address}: =${cell.formula}${cell.formulaCached === false ? '\n文件中没有缓存计算结果' : ''}` : (cell?.value || addressOf(row, column))}
                        style={{
                          ...cellBaseStyle, ...workbookCellStyle(style, cell), ...sticky,
                          height,
                          ...(isMatch ? matchCellStyle : {}),
                          ...(cell?.formula && cell.formulaCached === false ? pendingFormulaCellStyle : {}),
                          ...(isSelected ? selectedCellStyle : {}),
                        }}>
                        <span style={cellTextStyle}>{visibleValue}</span>
                        {!!cell?.formula && <span style={formulaMarkerStyle}></span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer style={sheetFooterStyle}>
        <div style={sheetTabsStyle}>
          <button style={sheetNavStyle} onClick={() => setActive(Math.max(0, safeActive - 1))} disabled={safeActive === 0}>‹</button>
          <button style={sheetNavStyle} onClick={() => setActive(Math.min(sheets.length - 1, safeActive + 1))} disabled={safeActive >= sheets.length - 1}>›</button>
          {sheets.map((item, index) => (
            <button key={`${item.name}-${index}`} onClick={() => { setActive(index); setSelected({ row: 1, column: 0 }); }}
              style={{ ...sheetTabStyle, ...(index === safeActive ? activeSheetTabStyle : {}) }} title={item.name}>
              {item.name}
            </button>
          ))}
        </div>
        <div style={statusBarStyle}>
          {sheet.autoFilter && <span>筛选区域 {sheet.autoFilter}</span>}
          {!!sheet.formulaCount && <span>公式 {sheet.formulaCount}</span>}
          {sheet.formulaCount !== sheet.cachedFormulaCount && <span style={{ color: '#b54708' }}>待计算 {(sheet.formulaCount || 0) - (sheet.cachedFormulaCount || 0)}</span>}
          <span>{calculation?.mode === 'manual' ? '手动计算工作簿' : '自动计算工作簿'}</span>
        </div>
      </footer>
    </section>
  );
};

const shellStyle: React.CSSProperties = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', outline: 'none', background: '#f8fafc', color: '#202124', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' };
const emptyStyle: React.CSSProperties = { padding: 36, textAlign: 'center', color: 'var(--theme-text-muted)' };
const toolbarStyle: React.CSSProperties = { minHeight: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 12px', color: 'var(--theme-text)', background: 'var(--theme-bg-secondary)', borderBottom: '1px solid var(--theme-border)', flexShrink: 0 };
const workbookIdentityStyle: React.CSSProperties = { minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' };
const workbookIconStyle: React.CSSProperties = { width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', color: '#fff', background: 'linear-gradient(145deg,#18864b,#0f6b3b)', fontSize: 15, boxShadow: '0 2px 8px rgba(15,107,59,.25)' };
const metaPillStyle: React.CSSProperties = { border: '1px solid var(--theme-border)', borderRadius: 999, padding: '2px 7px', color: 'var(--theme-text-muted)', background: 'var(--theme-bg-tertiary)', fontSize: 10 };
const toolbarActionsStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const searchBoxStyle: React.CSSProperties = { height: 30, width: 'min(310px, 30vw)', display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px 0 9px', border: '1px solid var(--theme-border)', borderRadius: 7, background: 'var(--theme-bg-tertiary)' };
const searchInputStyle: React.CSSProperties = { flex: 1, minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--theme-text)', fontSize: 11 };
const searchCountStyle: React.CSSProperties = { color: 'var(--theme-text-muted)', fontSize: 10, whiteSpace: 'nowrap' };
const iconButtonStyle: React.CSSProperties = { width: 21, height: 21, padding: 0, border: 0, borderRadius: 4, color: 'var(--theme-text-muted)', background: 'transparent', cursor: 'pointer' };
const zoomSelectStyle: React.CSSProperties = { height: 30, border: '1px solid var(--theme-border)', borderRadius: 7, padding: '0 6px', color: 'var(--theme-text)', background: 'var(--theme-bg-tertiary)', fontSize: 11 };
const formulaBarStyle: React.CSSProperties = { minHeight: 34, display: 'flex', alignItems: 'center', color: '#202124', background: '#fff', borderBottom: '1px solid #cbd1d8', flexShrink: 0 };
const nameBoxStyle: React.CSSProperties = { width: 72, alignSelf: 'stretch', display: 'grid', placeItems: 'center', borderRight: '1px solid #d8dde3', fontSize: 11, fontWeight: 600 };
const copyButtonStyle: React.CSSProperties = { height: 23, marginLeft: 6, border: '1px solid #d8dde3', borderRadius: 4, padding: '0 7px', background: '#f8fafc', color: '#4b5563', fontSize: 10, cursor: 'pointer' };
const fxBadgeStyle: React.CSSProperties = { width: 38, textAlign: 'center', color: '#18864b', fontFamily: 'Georgia, serif', fontSize: 15, fontStyle: 'italic', fontWeight: 700 };
const formulaValueStyle: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '5px 10px', borderLeft: '1px solid #e2e6ea', font: '11px/1.5 Consolas, monospace' };
const notCalculatedStyle: React.CSSProperties = { marginRight: 10, borderRadius: 4, padding: '2px 6px', color: '#b54708', background: '#fff4e5', fontSize: 9, whiteSpace: 'nowrap' };
const gridViewportStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', background: '#eef1f4', scrollbarColor: '#aeb7c2 #eef1f4' };
const gridStyle: React.CSSProperties = { width: 'max-content', minWidth: '100%', tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0, background: '#fff', fontSize: 12 };
const cornerStyle: React.CSSProperties = { position: 'sticky', left: 0, top: 0, zIndex: 10, width: ROW_HEADER_WIDTH, minWidth: ROW_HEADER_WIDTH, borderRight: '1px solid #c8ced6', borderBottom: '1px solid #c8ced6', background: 'linear-gradient(#f5f7f9,#e8edf2)' };
const columnHeaderStyle: React.CSSProperties = { position: 'sticky', top: 0, zIndex: 7, height: COLUMN_HEADER_HEIGHT, padding: 0, textAlign: 'center', color: '#59636e', background: 'linear-gradient(#f8fafb,#e9edf1)', borderRight: '1px solid #d4d9df', borderBottom: '1px solid #c8ced6', fontSize: 10, fontWeight: 600, userSelect: 'none' };
const rowHeaderStyle: React.CSSProperties = { position: 'sticky', left: 0, zIndex: 6, width: ROW_HEADER_WIDTH, minWidth: ROW_HEADER_WIDTH, padding: '0 7px 0 3px', textAlign: 'right', verticalAlign: 'middle', color: '#65717e', background: 'linear-gradient(90deg,#f5f7f9,#e9edf1)', borderRight: '1px solid #c8ced6', borderBottom: '1px solid #dfe3e7', fontSize: 10, fontWeight: 500, userSelect: 'none' };
const activeHeaderStyle: React.CSSProperties = { color: '#0f6b3b', background: '#dcefe4', fontWeight: 700 };
const cellBaseStyle: React.CSSProperties = { position: 'relative', minWidth: 0, padding: '3px 6px', overflow: 'hidden', borderRight: '1px solid #e1e5e9', borderBottom: '1px solid #e1e5e9', lineHeight: 1.35, cursor: 'cell' };
const cellTextStyle: React.CSSProperties = { display: 'block', maxHeight: '100%', overflow: 'hidden', textOverflow: 'ellipsis' };
const selectedCellStyle: React.CSSProperties = { outline: '2px solid #18864b', outlineOffset: -2, zIndex: 9, boxShadow: 'inset 0 0 0 1px rgba(24,134,75,.12)' };
const matchCellStyle: React.CSSProperties = { background: '#fff2a8' };
const pendingFormulaCellStyle: React.CSSProperties = { color: '#9a6700', background: '#fff8c5', fontStyle: 'italic' };
const formulaMarkerStyle: React.CSSProperties = { position: 'absolute', right: 1, top: 1, width: 0, height: 0, borderTop: '5px solid #18864b', borderLeft: '5px solid transparent', opacity: .65 };
const sheetFooterStyle: React.CSSProperties = { minHeight: 34, display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 10, color: '#3f4b57', background: '#f3f5f7', borderTop: '1px solid #c8ced6', flexShrink: 0 };
const sheetTabsStyle: React.CSSProperties = { minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' };
const sheetNavStyle: React.CSSProperties = { width: 28, border: 0, borderRight: '1px solid #d5dae0', color: '#66727e', background: 'transparent', cursor: 'pointer', fontSize: 16 };
const sheetTabStyle: React.CSSProperties = { maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: 0, borderRight: '1px solid #d5dae0', borderBottom: '3px solid transparent', padding: '0 16px', color: '#56616d', background: 'transparent', cursor: 'pointer', fontSize: 11 };
const activeSheetTabStyle: React.CSSProperties = { color: '#0f6b3b', background: '#fff', borderBottomColor: '#18864b', fontWeight: 700 };
const statusBarStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', color: '#68737f', fontSize: 9, whiteSpace: 'nowrap' };

export default ExcelPreview;
