import React from 'react';
import type { AimeinPlayState, AimeinTool } from '../utils/aimeinPlay';

export const tools: Array<{ id: AimeinTool; name: string; hint: string; path: string }> = [
  { id: 'inspect', name: '观察', hint: '拿起模块，看看里面', path: 'M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Zm9-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6' },
  { id: 'assemble', name: '装配', hint: '查看系统安排的阶段模块与依赖，可提出调整建议', path: 'm4 7 8-4 8 4-8 4-8-4Zm0 0v10l8 4 8-4V7M12 11v10M8 5l8 4' },
  { id: 'probe', name: '成果', hint: '查看已做步骤、验证依据与待修补缺口', path: 'M3 12h4l3-8 4 16 3-8h4' },
  { id: 'reviewers', name: '评委', hint: '点选评委，查看依据并校准判断', path: 'M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 21v-3a8 5 0 0 1 16 0v3M9 18l2 2 4-4' },
];

export const AimeinHotbar: React.FC<{ play: AimeinPlayState; compact: boolean; quiet?: boolean }> = ({ play, compact, quiet }) => <div style={{ padding: quiet ? '4px 8px' : compact ? '5px' : '8px 12px', background: 'linear-gradient(180deg,#102729,#0b1d20)', flexShrink: 0, borderTop: '1px solid #466158' }}>
  <div role="toolbar" aria-label="沙盘工具栏" style={{ display: 'flex', justifyContent: 'center', gap: compact ? 4 : 7 }}>
    {tools.map((tool, i) => <button key={tool.id} type="button" aria-label={`工具 ${i + 1}：${tool.name}`} aria-pressed={play.tool === tool.id} title={`${i + 1} · ${tool.hint}`} onClick={() => play.onTool(tool.id)} style={{
      position: 'relative', display: 'flex', flexDirection: compact ? 'column' : 'row', gap: compact ? 2 : 9, alignItems: 'center', justifyContent: 'center', minWidth: compact ? 43 : 86,
      color: play.tool === tool.id ? '#17372e' : '#bad4c9', background: play.tool === tool.id ? '#d6dfad' : '#1a3635', border: `1px solid ${play.tool === tool.id ? '#f1edc6' : '#49665b'}`,
      borderRadius: 5, padding: compact ? '5px 3px' : '10px 12px', cursor: 'pointer', boxShadow: play.tool === tool.id ? 'inset 0 -3px #9ca879, 0 0 18px #c8da9b20' : 'inset 0 -3px #112824', transform: play.tool === tool.id ? 'translateY(-2px)' : 'none',
      ...(quiet ? { minWidth: 0, flex: 1, flexDirection: 'row', padding: '5px 3px', background: 'transparent', color: '#a6c0b3', borderColor: 'transparent', boxShadow: 'none', transform: 'none' } : {}),
    }}><span style={{ position: 'absolute', top: 2, left: 4, font: '9px monospace', opacity: .6 }}>{i + 1}</span><svg width={compact ? 17 : 22} height={compact ? 17 : 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d={tool.path} /></svg><span style={{ fontSize: compact ? 10 : 12 }}>{tool.name}</span></button>)}
    {play.launch && <button type="button" aria-label={`工坊：${play.launch.label}`} disabled={play.launch.disabled} title={play.launch.reason || play.launch.label} onClick={play.launch.onClick} style={{ border: '1px solid #b5ac77', borderRadius: 5, background: '#3c4b36', color: '#f1dfaa', padding: compact || quiet ? '5px 7px' : '8px 15px', fontSize: compact || quiet ? 11 : 13, cursor: play.launch.disabled ? 'default' : 'pointer', opacity: play.launch.disabled ? .5 : 1 }}><span style={{ display: quiet ? 'none' : 'block', fontSize: compact ? 17 : 22 }}>⏵</span>{play.launch.label}</button>}
  </div>
  {!compact && !quiet && <div style={{ textAlign: 'center', color: '#91aea2', fontSize: 11, marginTop: 7 }}>{tools.find(t => t.id === play.tool)?.hint} <span style={{ opacity: .6 }}>· 1–4 切换工具</span></div>}
</div>;
