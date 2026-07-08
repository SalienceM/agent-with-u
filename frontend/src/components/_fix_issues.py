import sys, re
sys.stdout.reconfigure(encoding='utf-8')

# ── Fix 1: DiffViewer row alignment ──
with open('DiffViewer.tsx', 'r', encoding='utf-8') as f:
    dv = f.read()

replacements = [
    ("const oldLineStyle: React.CSSProperties = {\n  display: 'flex',\n  background: 'rgba(248, 81, 73, 0.1)',\n};",
     "const ROW_H = 18;\n\nconst oldLineStyle: React.CSSProperties = {\n  display: 'flex',\n  height: ROW_H,\n  alignItems: 'center',\n  background: 'rgba(248, 81, 73, 0.1)',\n};"),
    ("const newLineStyle: React.CSSProperties = {\n  display: 'flex',\n  background: 'rgba(63, 185, 80, 0.1)',\n};",
     "const newLineStyle: React.CSSProperties = {\n  display: 'flex',\n  height: ROW_H,\n  alignItems: 'center',\n  background: 'rgba(63, 185, 80, 0.1)',\n};"),
    ("const sameLineStyle: React.CSSProperties = {\n  display: 'flex',\n  background: 'transparent',\n};",
     "const sameLineStyle: React.CSSProperties = {\n  display: 'flex',\n  height: ROW_H,\n  alignItems: 'center',\n  background: 'transparent',\n};"),
    ("const emptyLineStyle: React.CSSProperties = {\n  display: 'flex',\n  background: '#1e1e1e',\n  minHeight: 18,\n};",
     "const emptyLineStyle: React.CSSProperties = {\n  display: 'flex',\n  height: ROW_H,\n  alignItems: 'center',\n  background: '#1e1e1e',\n};"),
    ("const hunkHeaderStyle: React.CSSProperties = {\n  display: 'flex',\n  background: '#264f78',\n  color: '#c9d1d9',\n};",
     "const hunkHeaderStyle: React.CSSProperties = {\n  display: 'flex',\n  height: ROW_H,\n  alignItems: 'center',\n  background: '#264f78',\n  color: '#c9d1d9',\n};"),
]

for old, new in replacements:
    if old in dv:
        dv = dv.replace(old, new)
        print(f"  DiffViewer: fixed {old.split(':')[0].split(' ')[1]}")
    else:
        print(f"  WARNING: pattern not found: {old[:60]}...")

with open('DiffViewer.tsx', 'w', encoding='utf-8') as f:
    f.write(dv)
print("DiffViewer fix done.\n")

# ── Fix 2: Add missing file tree rendering to FileTreePanel ──
with open('FileTreePanel.tsx', 'r', encoding='utf-8') as f:
    ftp = f.read()

# The git toolbar conditional ends with:
#   )}
# followed by the git modal comment. We need to insert the tree between them.
insert_before = "      {/* ★ Git 提交弹窗 — 变更列表 + 提交 */}"

tree_block = """      {/* ★ 文件树滚动区 */}
      <div style={treeScrollStyle}>
        {renderDir('', 0)}
      </div>

      {/* ★ Stash 列表 */}
      {stashExpanded && stashes.length > 0 && (
        <div style={stashListStyle}>
          {stashes.map((s, i) => (
            <div key={s.hash || i} style={stashItemStyle}>
              <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.message || s.hash?.slice(0, 7) || `stash@{${i}}`}
              </span>
              <button style={stashBtnStyle} title="应用此 stash (pop)" onClick={() => handleStashPop(i)}>✅</button>
              <button style={stashBtnStyle} title="删除此 stash (drop)" onClick={() => handleStashDrop(i)}>🗑</button>
            </div>
          ))}
        </div>
      )}
      {stashExpanded && stashes.length === 0 && !stashesLoading && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--theme-text-muted)' }}>
          没有 stash
        </div>
      )}

"""

if insert_before in ftp:
    ftp = ftp.replace(insert_before, tree_block + insert_before)
    print("FileTreePanel: inserted file tree + stash sections.")
else:
    print("ERROR: insert marker not found!")

# Add missing styles if not present
extra_styles = """
// ── 文件树容器 & stash 样式 ───────────────────────────────────

const treeScrollStyle: React.CSSProperties = {
  flex: 1, overflow: 'auto', minHeight: 0,
  padding: '2px 0',
};

const stashListStyle: React.CSSProperties = {
  borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
  maxHeight: 160, overflow: 'auto',
};

const stashItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.04)',
  fontSize: 11,
};

const stashBtnStyle: React.CSSProperties = {
  width: 20, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', cursor: 'pointer',
  fontSize: 11, borderRadius: 3, flexShrink: 0,
};
"""

if 'const treeScrollStyle' not in ftp:
    ftp += extra_styles
    print("Added missing tree/stash styles.")
else:
    print("Styles already present.")

with open('FileTreePanel.tsx', 'w', encoding='utf-8') as f:
    f.write(ftp)

print("\nAll fixes applied!")
