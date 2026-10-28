import React, { useEffect, useRef, useState } from 'react';
import { AimeinSetupWorld, setupButton, setupPrimary, setupHint, setupHighlight } from './AimeinSetupWorld';

export const AimeinEntrance: React.FC<{
  children: React.ReactNode; blocked: boolean; loading: boolean; creating: boolean; problem: string;
  backendLabel: string; workingDir: string; executorLabel: string; suspended?: boolean;
  onPanelHost?: React.Ref<HTMLDivElement>;
  onCreate: () => void; onClose: () => void; onBack: () => void; onManage: () => void;
}> = props => {
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!props.suspended) close.current?.focus(); }, [props.suspended]);
  return <div role="dialog" aria-modal={!props.suspended} aria-label="进入 AIMEIN 世界"
    style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'block', overflow: 'hidden', background: '#0b201e', padding: 'clamp(8px, 2vw, 24px)', boxSizing: 'border-box' }}
    onKeyDown={event => {
      if (props.suspended) return;
      if (event.key === 'Escape' && !props.creating) { event.stopPropagation(); props.onClose(); }
      if (event.key === 'Tab') {
        const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, [tabindex="0"]')).filter(el => !el.hasAttribute('disabled') && el.getClientRects().length);
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    }}>
    <AimeinSetupWorld step={step} onStep={setStep} complete={[false, false, false, false]} externalPanel={props.suspended} onPanelHost={props.onPanelHost}
      title={step === 0 ? '给想法一个生长的地方' : '先把工坊安放好'}
      hint={step === 0 ? '连接建设模型，选择成果保存的位置。已有可用配置时，可以直接下一步。' : '工坊建立后，就可以在这座沙盘里点亮目标、邀请评委。'}
      actions={<><button type="button" style={setupButton} disabled={props.creating || props.suspended} onClick={props.onBack}>切换模式</button><button ref={close} type="button" aria-label="关闭 AIMEIN 创建" style={setupButton} disabled={props.creating} onClick={props.onClose}>退出</button></>}>
      <div data-testid="aimein-workshop-target" style={setupHighlight}>
        <div style={{ fontSize: 10, color: '#e8a49a', letterSpacing: 1 }}>01 · 当前准备项</div>
        <h4 style={{ margin: '10px 0', fontSize: 15 }}>{props.loading ? '正在读取工坊连接…' : props.backendLabel || '连接你的建设模型'}</h4>
        <div style={setupHint}>{props.executorLabel || '还没有可用执行节点'}<br />{props.workingDir.trim() && props.workingDir.trim() !== '.' ? props.workingDir : '为这个工坊自动创建独立目录'}</div>
        {props.problem && <p role="alert" style={{ ...setupHint, color: '#f0aea2' }}>{props.problem}</p>}
        <button type="button" style={{ ...setupButton, marginTop: 12 }} onClick={() => { setStep(0); setEditing(v => !v); }}>{editing ? '收起工坊设置' : '调整连接与位置'}</button>
      </div>
      <div hidden={!editing && !props.problem} style={{ marginTop: 16 }}>{props.children}</div>
      {props.problem && <button type="button" style={{ ...setupButton, marginTop: 10 }} onClick={props.onManage}>配置模型连接</button>}
      <button type="button" style={{ ...setupPrimary, width: '100%', marginTop: 20, opacity: props.blocked ? .5 : 1 }} disabled={props.blocked || props.suspended} onClick={props.onCreate}>
        {props.creating ? '正在安放工坊…' : '安放工坊，下一步 →'}
      </button>
      <p style={{ ...setupHint, fontSize: 11 }}>此步只创建工作空间。目标和评委准备好后，由你开始建设。</p>
    </AimeinSetupWorld>
  </div>;
};
