/**
 * Runs panel — the flow's execution history. List of runs (status, counts,
 * relative time); selecting one loads its journal (runs/<id>.jsonl) and shows
 * the per-event timeline. The list itself refreshes on run_start/run_end
 * beats (view wiring); this panel only renders store state + fetches
 * journals on demand.
 */
import { useEffect, useState } from 'react';
import { graphWorkflows, type RunJournalEntry } from '@sdk/services/graph-workflows';
import { asStr, fmtRelative, parseIsoMs } from '../fmt';
import { useStudio } from '../store';

const STATUS_GLYPH: Record<string, string> = {
  running: '▶',
  complete: '✓',
  tripped: '⚡',
  failed: '✗',
};

function JournalTimeline({
  entries,
  onReexecute,
  onOpenProcess,
}: {
  entries: RunJournalEntry[];
  onReexecute: (seq: number) => void;
  onOpenProcess: (processId: string) => void;
}) {
  return (
    <div className="afl-journal">
      {entries.map((e, i) => {
        const node = typeof e.node === 'string' ? e.node : '';
        const event = typeof e.event === 'string' ? e.event : '';
        const seq = (e.execution as { seq?: number } | undefined)?.seq;
        const processId = typeof e.process_id === 'string' ? e.process_id : '';
        const detail =
          e.kind === 'node_error'
            ? (asStr(e.stderr) || asStr(e.error)).slice(-200)
            : e.kind === 'event'
              ? JSON.stringify(e.data ?? {}).slice(0, 160)
              : '';
        return (
          <div key={i} className={`afl-jrow ${e.kind}`}>
            <span className="k">{e.kind}</span>
            <span className="n">
              {[seq ? `#${seq}` : '', node, event].filter(Boolean).join(' · ')}
            </span>
            {detail && <span className="d">{detail}</span>}
            {processId && (e.kind === 'agent_spawn' || e.kind === 'node_done' || e.kind === 'node_error') && (
              <a className="lnk" title={`open process ${processId}`} onClick={() => onOpenProcess(processId)}>
                proc ⬈
              </a>
            )}
            {seq !== undefined && (e.kind === 'node_done' || e.kind === 'node_error') && (
              <a className="lnk" title="re-deliver this execution's recorded input in a fresh run"
                 onClick={() => onReexecute(seq)}>
                ↻ re-run
              </a>
            )}
          </div>
        );
      })}
      {!entries.length && <div className="afl-note">empty journal</div>}
    </div>
  );
}

export function RunsPanel() {
  const flowId = useStudio((s) => s.flowId);
  const runs = useStudio((s) => s.runs);
  const selectedRunId = useStudio((s) => s.selectedRunId);
  const selectRun = useStudio((s) => s.selectRun);
  const openProcess = useStudio((s) => s.openProcess);
  const [entries, setEntries] = useState<RunJournalEntry[]>([]);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const now = Date.now();
  const selectedStatus = runs.find((r) => r.id === selectedRunId)?.status;

  const replay = () => {
    if (!flowId || !selectedRunId) return;
    setActionStatus(null);
    void graphWorkflows
      .replayRun(flowId, selectedRunId)
      .then((res) => setActionStatus(res?.run_id ? `▶ replayed as ${res.run_id.slice(0, 8)}` : 'replay failed'))
      .catch((e) => setActionStatus(String(e)));
  };

  const reexecute = (seq: number) => {
    if (!flowId || !selectedRunId) return;
    setActionStatus(null);
    void graphWorkflows
      .reexecute(flowId, selectedRunId, seq)
      .then((res) => setActionStatus(res?.run_id ? `▶ #${seq} re-run as ${res.run_id.slice(0, 8)}` : 're-run failed'))
      .catch((e) => setActionStatus(String(e)));
  };

  useEffect(() => {
    if (!flowId || !selectedRunId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      void graphWorkflows
        .fetchRunJournal(flowId, selectedRunId)
        .then((j) => {
          if (!cancelled && j) setEntries(j);
        })
        .catch(() => undefined);
    load();
    // A running run's journal grows — follow it while selected. Keyed on the
    // selected run's STATUS (not the whole runs array) so unrelated run
    // boundaries don't tear down and re-fetch this journal.
    const timer = selectedStatus === 'running' ? setInterval(load, 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [flowId, selectedRunId, selectedStatus]);

  return (
    <div className="afl-panel afl-runs">
      <div className="eye">runs</div>
      {!runs.length && <p className="afl-note">No runs yet — inject an event or fire the trigger.</p>}
      <div className="afl-runlist">
        {runs.map((r) => (
          <button
            key={r.id}
            className={`afl-runrow ${r.status} ${selectedRunId === r.id ? 'on' : ''}`}
            onClick={() => selectRun(selectedRunId === r.id ? null : r.id)}
          >
            <span className="g">{STATUS_GLYPH[r.status] ?? '·'}</span>
            <span className="id">{r.id.slice(0, 8)}</span>
            <span className="meta">
              {r.event_count} ev · {r.execution_count} exec
            </span>
            <span className="when">{r.started_at ? fmtRelative(parseIsoMs(r.started_at), now) : ''}</span>
          </button>
        ))}
      </div>
      {selectedRunId && (
        <>
          <div className="afl-runactions">
            <button className="afl-cta" onClick={replay}
                    title="re-inject this run's recorded entry events into a fresh run (side effects re-fire)">
              Replay run ▶
            </button>
            {actionStatus && <div className="afl-status">{actionStatus}</div>}
          </div>
          <JournalTimeline
            entries={entries}
            onReexecute={reexecute}
            onOpenProcess={(pid) => openProcess?.(pid)}
          />
        </>
      )}
    </div>
  );
}
