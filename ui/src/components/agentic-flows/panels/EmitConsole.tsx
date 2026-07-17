/** Emit console — every test scenario starts here. */
import { useState } from 'react';
import { flowManager, isValidTopicName } from '@sdk/services/flow-manager';
import { useStudio } from '../store';

export function EmitConsole() {
  const snapshot = useStudio((s) => s.snapshot);
  const selectCorrelation = useStudio((s) => s.selectCorrelation);
  const [topic, setTopic] = useState('flow.hello.world');
  const [payload, setPayload] = useState('{\n  "msg": "hi"\n}');
  const [lastCorr, setLastCorr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const emit = async () => {
    setError(null);
    if (!isValidTopicName(topic)) {
      setError('Invalid topic name (lowercase dot-path: seg.seg.seg)');
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      setError('Payload is not valid JSON');
      return;
    }
    try {
      const routed = await flowManager.emitTopic(topic, parsed);
      if (routed) {
        setLastCorr(routed.correlation_id);
        selectCorrelation(routed.correlation_id);
        if (routed.dropped) setError(`DROPPED: ${routed.dropped}`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="">
      <h3>Emit</h3>
      <label>Topic</label>
      <input list="topic-names" value={topic} onChange={(e) => setTopic(e.target.value)} />
      <datalist id="topic-names">
        {snapshot?.topics.map((t) => <option key={t.id} value={t.name} />)}
      </datalist>
      <label>Payload (JSON)</label>
      <textarea rows={6} value={payload} onChange={(e) => setPayload(e.target.value)} />
      <button className="primary" onClick={emit}>Emit event</button>
      {lastCorr && (
        <div className="faint">
          chain: <code onClick={() => selectCorrelation(lastCorr)}>{lastCorr.slice(0, 8)}…</code>
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
