/** Live journal — one row per routed event; click a row to inspect its chain. */
import { useEffect, useState } from 'react';
import { fmtRelative, parseIsoMs } from '../fmt';
import { useStudio } from '../store';

export function JournalTail() {
  const journal = useStudio((s) => s.journal);
  const selected = useStudio((s) => s.selectedCorrelation);
  const selectCorrelation = useStudio((s) => s.selectCorrelation);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const rows = [...journal].reverse().slice(0, 100);
  return (
    <div className="">
      <h3>
        Journal <span className="faint">({journal.length} events)</span>
        {selected && (
          <button className="mini" onClick={() => selectCorrelation(null)}>
            clear filter
          </button>
        )}
      </h3>
      <table>
        <thead>
          <tr>
            <th>when</th>
            <th>topic</th>
            <th>depth</th>
            <th>source</th>
            <th>chain</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((e) => !selected || e.correlation_id === selected)
            .map((e, i) => (
              <tr
                key={`${e.ts}-${i}`}
                className={e.dropped ? 'dropped' : e.topic.startsWith('flow.error') ? 'errored' : ''}
                onClick={() => selectCorrelation(e.correlation_id)}
              >
                <td style={{ color: '#7d87a5', whiteSpace: 'nowrap' }}>
                  {fmtRelative(parseIsoMs(e.ts), now)}
                </td>
                <td title={e.dropped ?? undefined}>
                  {e.topic}
                  {e.dropped ? ' ⛔' : ''}
                </td>
                <td>{e.depth}</td>
                <td>{e.source}</td>
                <td>
                  <code>{e.correlation_id.slice(0, 8)}</code>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
