/**
 * Inject panel — the external entry point into the flow: event name + JSON
 * payload (+ optional target node) → POST /graph-workflows/<id>/inject. Starts
 * a run; the run/journal surfaces light up from the live streams.
 */
import { useState } from 'react';
import { agenticFlows } from '@sdk/services/graph-workflows';
import { useStudio } from '../store';

export function InjectPanel() {
  const flowId = useStudio((s) => s.flowId);
  const doc = useStudio((s) => s.doc);
  const flowEnabled = useStudio((s) => s.flowEnabled);
  const [event, setEvent] = useState('go');
  const [payload, setPayload] = useState('{}');
  const [targetNode, setTargetNode] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const inject = async () => {
    if (!flowId) return;
    setStatus(null);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      setStatus('bad JSON');
      return;
    }
    try {
      const res = await agenticFlows.inject(flowId, event.trim() || 'go', parsed, {
        targetNode: targetNode || undefined,
      });
      setStatus(res ? `▶ run ${res.execution_id.slice(0, 8)}` : 'no response');
    } catch (e) {
      setStatus(String(e));
    }
  };

  return (
    <div className="afl-panel afl-inject">
      <div className="eye">inject event</div>
      {!flowEnabled && <p className="afl-note warn">Flow is inactive — injections are refused.</p>}
      <label>event</label>
      <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="event name" />
      <label>payload</label>
      <textarea rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="{}" />
      <label>target node (optional — otherwise routes via $external edges)</label>
      <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
        <option value="">— route by edges —</option>
        {(doc?.nodes ?? [])
          .filter((n) => n.node_type !== 'trigger')
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.name || n.id}
            </option>
          ))}
      </select>
      <button className="afl-cta" onClick={() => void inject()} disabled={!flowId}>
        Inject ▶
      </button>
      {status && <div className="afl-status">{status}</div>}
    </div>
  );
}
