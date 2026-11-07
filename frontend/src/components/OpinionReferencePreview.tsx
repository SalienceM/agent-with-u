import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { OpinionReference } from '../types/sessionCollaboration';

export const OpinionReferencePreview: React.FC<{ session: string; content: string }> = ({ session, content }) => {
  const references = [...content.matchAll(/【角色意见：[^\n]*?｜报告 ([\w-]+) v(\d+)｜来源 ([\w-]+)】/g)].slice(0, 20);
  const [result, setResult] = useState<{ key: string; reference?: OpinionReference; notice?: string }>(), [busy, setBusy] = useState(false);
  const current = useRef({ session, content }); current.current = { session, content };
  useEffect(() => { setResult(undefined); setBusy(false); }, [session, content]);
  if (!references.length) return null;
  return <div style={{ fontSize: 12, marginTop: 8 }}>
    {references.map((value, index) => <div key={`${value[1]}:${index}`}>
      <button disabled={busy} onClick={() => {
        const identity = current.current; setBusy(true);
        void api.reviewReferenceLookup(session, value[3], value[1], Number(value[2])).then(response => {
          if (current.current.session === identity.session && current.current.content === identity.content) setResult({ key: value[1], ...response });
        }).catch(error => { if (current.current.session === identity.session && current.current.content === identity.content) setResult({ key: value[1], notice: `来源暂不可核对：${String(error)}；摘录保持原样。` }); })
          .finally(() => { if (current.current.session === identity.session && current.current.content === identity.content) setBusy(false); });
      }}>查看固定意见来源 · {value[1].slice(0, 12)} v{value[2]}</button>
      {result?.key === value[1] && <div role="status">
        {result.notice || <details open><summary>{result.reference?.roleName} · 原版本意见</summary>
          <p>{result.reference?.summary}</p>{result.reference?.claims.map(claim => <p key={claim.id}>{claim.quote} · {claim.reason}</p>)}
        </details>}
      </div>}
    </div>)}
  </div>;
};
