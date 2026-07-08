import re

with open('FileTreePanel.tsx', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Keep lines 1-1122 (index 0-1121), discard the rest
kept = lines[:1122]

append = """
      {/* \\u2605 Git Diff \\u72ec\\u7acb\\u9762\\u677f */}
      {diffPanelOpen && (
        <div style={diffOverlayStyle} onClick={() => setDiffPanelOpen(false)}>
          <div style={diffBoxStyle} onClick={(e) => e.stopPropagation()}>
            {/* \\u9876\\u680f\\uff1a\\u6587\\u4ef6\\u540d + \\u4e0a/\\u4e0b\\u4e00\\u4e2a */}
            <div style={diffTopBarStyle}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#c9d1d9' }}>
                \\ud83d\\udcc4 {diffPanelFile || '(no file)'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', marginLeft: 12 }}>
                {diffPanelAllFiles.length > 0
                  ? `${diffPanelAllFiles.indexOf(diffPanelFile) + 1} / ${diffPanelAllFiles.length}`
                  : ''}
              </span>
              <div style={{ flex: 1 }} />
              <button style={diffNavBtn} disabled={diffPanelAllFiles.indexOf(diffPanelFile) <= 0}
                onClick={diffPanelPrevFile} title={"\\u4e0a\\u4e00\\u4e2a\\u6587\\u4ef6"}>{"\\u25c0 \\u4e0a\\u4e00\\u4e2a"}</button>
              <button style={diffNavBtn} disabled={diffPanelAllFiles.indexOf(diffPanelFile) >= diffPanelAllFiles.length - 1}
                onClick={diffPanelNextFile} title={"\\u4e0b\\u4e00\\u4e2a\\u6587\\u4ef6"}>{"\\u4e0b\\u4e00\\u4e2a \\u25b6"}</button>
              <button style={diffCloseBtn} onClick={() => setDiffPanelOpen(false)}>{"\\u2715"}</button>
            </div>
            {/* Diff \\u5185\\u5bb9 */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {diffPanelLoading ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text-muted)' }}>
                  {"\\u52a0\\u8f7d\\u4e2d\\u2026"}
                </div>
              ) : (
                <DiffViewer diff={diffPanelDiff} filename={diffPanelFile} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// \\u2500\\u2500 Git \\u5f39\\u7a97\\u6837\\u5f0f \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

const gitModalOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9998,
  background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const gitModalBoxStyle: React.CSSProperties = {
  width: '78vw', maxWidth: 1100, height: '72vh',
  background: '#161b22', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
};
const gitModalHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.03)', flexShrink: 0,
};
const gitModalBodyStyle: React.CSSProperties = {
  flex: 1, display: 'flex', overflow: 'hidden',
};
const gitModalLeftStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', borderRight: '1px solid rgba(255,255,255,0.06)',
  minWidth: 0,
};
const gitModalRightStyle: React.CSSProperties = {
  width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
  background: 'rgba(255,255,255,0.02)',
};
const gitModalFileItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '5px 14px', fontSize: 12, borderBottom: '1px solid rgba(255,255,255,0.04)',
  cursor: 'default',
};
const gitModalFileName: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: '#c9d1d9', fontSize: 12,
};
const gitModalStatusBadge = (status: string): React.CSSProperties => {
  const colors: Record<string, string> = {
    modified: '#d29922', added: '#3fb950', deleted: '#f85149',
    renamed: '#58a6ff', untracked: '#8b949e', conflicted: '#f85149',
    copied: '#58a6ff',
  };
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, borderRadius: 4, fontSize: 10, fontWeight: 700,
    background: (colors[status] || '#8b949e') + '22',
    color: colors[status] || '#8b949e', flexShrink: 0,
  };
};
const gitCheckboxStyle: React.CSSProperties = {
  width: 14, height: 14, accentColor: '#3fb950', cursor: 'pointer', flexShrink: 0,
};
const gitModalStageBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(63,185,80,0.3)',
  background: 'rgba(63,185,80,0.1)', color: '#3fb950', cursor: 'pointer', flexShrink: 0,
};
const gitModalUnstageBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(248,81,73,0.3)',
  background: 'rgba(248,81,73,0.1)', color: '#f85149', cursor: 'pointer', flexShrink: 0,
};
const gitModalIgnoreBtn: React.CSSProperties = {
  padding: '1px 6px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(139,148,158,0.3)',
  background: 'rgba(139,148,158,0.1)', color: '#8b949e', cursor: 'pointer', flexShrink: 0,
};
const gitModalStageAllBtn: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};
const gitModalCloseBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 13, borderRadius: 4,
  border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer',
};
const gitModalTextareaStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.5,
  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6, color: '#c9d1d9', fontFamily: 'inherit',
};
const gitModalCommitBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
  border: '1px solid rgba(63,185,80,0.3)', color: '#fff', cursor: 'pointer',
};
const gitModalAiBtn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(88,166,255,0.3)', background: 'rgba(88,166,255,0.1)',
  color: '#58a6ff', cursor: 'pointer',
};
const gitBatchBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 16px', background: 'rgba(88,166,255,0.06)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};
const gitBatchBtn = (color: string): React.CSSProperties => ({
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid ' + color + '44', background: color + '18',
  color, cursor: 'pointer',
});

// \\u2500\\u2500 Diff \\u9762\\u677f\\u6837\\u5f0f \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

const diffOverlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 10000,
  background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const diffBoxStyle: React.CSSProperties = {
  width: '90vw', height: '85vh',
  background: '#1e1e1e', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
};
const diffTopBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '8px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: '#252526', flexShrink: 0,
};
const diffNavBtn: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.05)',
  color: '#c9d1d9', cursor: 'pointer',
};
const diffCloseBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 13, borderRadius: 4,
  border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer',
};
"""

with open('FileTreePanel.tsx', 'w', encoding='utf-8') as f:
    f.writelines(kept)
    f.write(append)

print("Done! File fixed.")
