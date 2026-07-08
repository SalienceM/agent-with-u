import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('FileTreePanel.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# Check if we already have these styles defined
if 'const wrapStyle' in content:
    print("Styles already exist, skipping.")
    sys.exit(0)

# Add the Empty component and all missing style definitions before the closing of the file
# Find the last line of the file
additional = """

// ── Empty 组件 ──────────────────────────────────────────────────
const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
    {text}
  </div>
);

// ── 文件树样式 ──────────────────────────────────────────────────

const wrapStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%',
  background: 'var(--theme-bg-secondary, #1e1e1e)',
  color: 'var(--theme-text, #c9d1d9)',
  fontSize: 12, overflow: 'hidden',
};

const topBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', flexShrink: 0,
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const tagStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(88,166,255,0.15)', color: '#58a6ff',
  border: '1px solid rgba(88,166,255,0.25)', marginLeft: 4,
  maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const gitBranchBadgeStyle: React.CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(63,185,80,0.12)', color: '#3fb950',
  border: '1px solid rgba(63,185,80,0.25)', marginLeft: 4,
};

const hdrIconStyle: React.CSSProperties = {
  width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted, #8b949e)',
  cursor: 'pointer', borderRadius: 4, fontSize: 13, flexShrink: 0,
};

const gitToolbarStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '6px 10px',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
};

const gitMiniBtn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 10.5, borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)',
  color: 'var(--theme-text, #c9d1d9)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 3,
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 2,
  padding: '2px 4px', cursor: 'pointer', userSelect: 'none',
  borderRadius: 3, minHeight: 22,
};

const emptyStyle: React.CSSProperties = {
  padding: '12px 16px', color: 'var(--theme-text-muted, #8b949e)',
  fontSize: 11, textAlign: 'center',
};

const guideStyle: React.CSSProperties = {
  display: 'inline-block', width: 8, height: 1,
  background: 'var(--theme-border, rgba(255,255,255,0.1))',
  marginRight: 2, flexShrink: 0,
};

const chevronStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 14, height: 14, fontSize: 10, color: 'var(--theme-text-muted, #8b949e)',
  flexShrink: 0,
};

const iconStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 18, height: 18, fontSize: 13, flexShrink: 0,
};

const nameStyle: React.CSSProperties = {
  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontSize: 12, color: 'var(--theme-text, #c9d1d9)',
};

const actBtnStyle: React.CSSProperties = {
  width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: 'var(--theme-text-muted, #8b949e)',
  cursor: 'pointer', borderRadius: 3, fontSize: 11, flexShrink: 0, padding: 0,
};
"""

with open('FileTreePanel.tsx', 'a', encoding='utf-8') as f:
    f.write(additional)

print("Added all missing style definitions.")
