/** Chain inspector — the causation tree of the selected correlation chain,
 * with live outcome chip (running/complete/tripped) and per-hop latency. */
import { useEffect, useState } from 'react';
import { fmtRelative, parseIsoMs } from '../fmt';
import { useStudio } from '../store';

export function ChainInspector() {
  const journal = useStudio((s) => s.journal);
  const corr = useStudio((s) => s.selectedCorrelation);
  const nodeStatus = useStudio((s) => s.nodeStatus);
  const chainOutcome = useStudio((s) => s.chainOutcome);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  void nodeStatus; // subscription: outcome chip re-evaluates on scheduler pushes

  if (!corr) return <div className="faint">Select a journal row (or emit) to inspect a chain.</div>;
  const chain = journal.filter((e) => e.correlation_id === corr);
  if (chain.length === 0) return <div className="faint">No events for this chain in the buffer.</div>;

  const outcome = chainOutcome(corr);
  const activeCount = Object.values(nodeStatus).filter(
    (n) => n.correlationId === corr && (n.queued > 0 || n.active > 0),
  ).length;

  return (
    <div className="">
      <h3>
        Chain <code>{corr.slice(0, 8)}…</code>{' '}
        <span className={`chain-chip ${outcome}`}>
          {outcome}
          {outcome === 'running' && activeCount > 0 ? ` (${activeCount})` : ''}
        </span>
        <span className="faint">{chain.length} hops</span>
      </h3>
      {chain.map((e, i) => {
        const tsMs = parseIsoMs(e.ts);
        const prevMs = i > 0 ? parseIsoMs(chain[i - 1].ts) : null;
        const latency = prevMs !== null ? tsMs - prevMs : null;
        return (
          <div
            key={`${e.ts}-${i}`}
            className={`hop ${e.dropped ? 'dropped' : ''} ${e.topic.startsWith('flow.error') ? 'errored' : ''}`}
            style={{ marginLeft: e.depth * 18 }}
          >
            <div className="hop-title">
              <b>{e.topic}</b>{' '}
              <span className="faint">
                depth {e.depth} · {e.source} · {fmtRelative(tsMs, now)}
                {latency !== null && latency >= 0 && (
                  <> · +{latency < 1000 ? `${latency}ms` : `${(latency / 1000).toFixed(1)}s`}</>
                )}
              </span>
            </div>
            {e.dropped && <div className="err">⛔ {e.dropped}</div>}
            {Object.keys(e.payload ?? {}).length > 0 && (
              <pre>{JSON.stringify(e.payload, null, 1)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
