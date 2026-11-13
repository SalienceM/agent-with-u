import React, { useEffect, useState } from 'react';
import { AppModalPortal } from '../../src/components/AppModalPortal';
import { ChatInput } from '../../src/components/ChatInput';
import { AdvancedPromptTextarea } from '../../src/components/AdvancedPromptTextarea';
// App 集成测试替身：记录挂载/卸载，保留真实输入框与 portal，所有执行能力均为 spy。
export function SessionWorkbench(props: any) {
  const f = (window as any).privacyFixture, meta = f.rows.find((r: any) => r.id === props.sessionId);
  const [file, setFile] = useState(''), [dialog, setDialog] = useState(false);
  const [prompt, setPrompt] = useState('');
  useEffect(() => { f.mounts.push(props.sessionId); props.onStreamingChange(props.sessionId, true);
    return () => { f.unmounts.push(props.sessionId); }; }, []);
  return <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
    <h2>{meta?.title}</h2><p>{meta?.workingDir}</p><p>正文 {props.sessionId}</p>
    <input aria-label="文件缓冲" value={file} onChange={event => setFile(event.target.value)} />
    <AdvancedPromptTextarea aria-label="高级提示" value={prompt} onValueChange={setPrompt} sessionId={props.sessionId} execKey={meta?.execKey} />
    <button onClick={() => setDialog(true)}>打开会话浮层</button>
    {dialog && <AppModalPortal><div role="dialog" aria-label="会话浮层">{meta?.title}<button onClick={() => setDialog(false)}>关闭浮层</button></div></AppModalPortal>}
    <ChatInput sessionId={props.sessionId} execKey={meta?.execKey} historyKey={props.sessionId} backends={[]} activeBackendId="qa"
      isStreaming={false} isFocused={props.isFocused} onSend={() => f.mutations.push('send')}
      onAbort={() => f.mutations.push('abort')} onAdjustFontSize={() => {}} />
  </div>;
}
