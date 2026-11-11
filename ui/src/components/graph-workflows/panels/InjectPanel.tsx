/**
 * Inject panel — the external entry point into the flow: event name + JSON
 * payload (+ optional target node) → POST /graph-workflows/<id>/inject. Starts
 * a run; the run/journal surfaces light up from the live streams.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { graphWorkflows } from '@sdk/services/graph-workflows';
import { useStudio } from '../store';

export function InjectPanel() {
  const { t } = useLingui();
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
      const res = await graphWorkflows.inject(flowId, event.trim() || 'go', parsed, {
        targetNode: targetNode || undefined,
      });
      setStatus(res ? `▶ run ${res.execution_id.slice(0, 8)}` : 'no response');
    } catch (e) {
      setStatus(String(e));
    }
  };

  return (
    <div className="afl-panel afl-inject">
      <div className="eye">
        <Trans>inject event</Trans>
      </div>
      {!flowEnabled && (
        <p className="afl-note warn">
          <Trans>Flow is inactive — injections are refused.</Trans>
        </p>
      )}
      <label>
        <Trans>event</Trans>
      </label>
      <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder={t`event name`} />
      <label>
        <Trans>payload</Trans>
      </label>
      <textarea rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="{}" />
      <label>
        <Trans>target node (optional — otherwise routes via $external edges)</Trans>
      </label>
      <select value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
        <option value="">{t`— route by edges —`}</option>
        {(doc?.nodes ?? [])
          .filter((n) => n.node_type !== 'trigger')
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.name || n.id}
            </option>
          ))}
      </select>
      <button className="afl-cta" onClick={() => void inject()} disabled={!flowId}>
        <Trans>Inject ▶</Trans>
      </button>
      {status && <div className="afl-status">{status}</div>}
    </div>
  );
}
