/**
 * Runs panel — the flow's execution history. List of runs (status, counts,
 * relative time); selecting one loads its journal (runs/<id>.jsonl) and shows
 * the per-event timeline. The list itself refreshes on run_start/run_end
 * beats (view wiring); this panel only renders store state + fetches
 * journals on demand.
 */
import { useEffect, useState } from 'react';
import {
  graphWorkflows,
  type ArtifactExecution,
  type RunJournalEntry,
} from '@sdk/services/graph-workflows';
import { formatBytes } from '@src/utils/format-bytes';
import { asStr, fmtRelative, parseIsoMs } from '../fmt';
import { useStudio } from '../store';

/** `key`+`name` identifies one artifact across executions. */
const artifactId = (key: string, name: string) => `${key}/${name}`;

/**
 * What each execution actually read and produced.
 *
 * The engine has always written these records; nothing read them back, so a
 * flow's real products were reachable only through the filesystem. Agent-node
 * files live under the agentic process's record dir rather than the run's —
 * the backend resolves that via the journal so both appear in one list.
 */
function ArtifactList({
  flowId,
  runId,
  executions,
}: {
  flowId: string;
  runId: string;
  executions: ArtifactExecution[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  // `null` IS the loading state — it cannot disagree with a separate flag.
  const [text, setText] = useState<string | null>(null);

  const show = (key: string, name: string) => {
    const id = artifactId(key, name);
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setText(null);
    void graphWorkflows
      .fetchRunArtifact(flowId, runId, key, name)
      .then((a) => setText(a?.text ?? '(empty)'))
      .catch((e) => setText(String(e)));
  };

  if (!executions.length) return null;
  return (
    <div className="afl-artifacts">
      <div className="eye">outputs</div>
      {executions.map((ex) => (
        <div key={ex.key} className="afl-exec">
          <div className="afl-exechead">
            <span className="s">#{ex.seq}</span>
            <span className="n">{ex.label || ex.node || ex.key}</span>
            {ex.process_id && <span className="tagpill">agent</span>}
          </div>
          {ex.files.length === 0 && <div className="afl-note">no files</div>}
          {ex.files.map((f) => {
            const id = artifactId(ex.key, f.name);
            return (
              <div key={id} className="afl-file">
                <button
                  className={`afl-filerow ${f.direction}${open === id ? ' on' : ''}`}
                  onClick={() => show(ex.key, f.name)}
                  title={f.path}
                  disabled={!f.previewable}
                >
                  <span className="dir">{f.direction === 'input' ? '→' : '←'}</span>
                  <span className="fn">{f.name}</span>
                  <span className="sz">{formatBytes(f.size)}</span>
                </button>
                {open === id && <pre className="afl-filebody">{text ?? 'loading…'}</pre>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

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

export function RunsPanel({ onSelectRun }: { onSelectRun: (runId: string | null) => void }) {
  const flowId = useStudio((s) => s.flowId);
  const runs = useStudio((s) => s.runs);
  const selectedRunId = useStudio((s) => s.selectedRunId);
  const previewRuns = useStudio((s) => s.previewRuns);
  const [entries, setEntries] = useState<RunJournalEntry[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactExecution[]>([]);
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
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void graphWorkflows
        .fetchRunJournal(flowId, selectedRunId)
        .then((j) => {
          if (!cancelled && j) setEntries(j);
        })
        .catch(() => undefined);
      // Artifacts follow the same cadence: a running run writes files as it
      // goes, so they must not be fetched once and frozen.
      void graphWorkflows
        .fetchRunArtifacts(flowId, selectedRunId)
        .then((a) => {
          if (!cancelled && a) setArtifacts(a.executions ?? []);
        })
        .catch(() => undefined);
    };
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
      <div className="eye">
        runs
        {flowId && (
          <button
            className="lnk"
            title="open this flow's full run history"
            onClick={() =>
              previewRuns?.({ scope: { flow_id: flowId }, title: 'Runs of this flow' })
            }
          >
            all ⬈
          </button>
        )}
      </div>
      {!runs.length && <p className="afl-note">No runs yet — inject an event or fire the trigger.</p>}
      <div className="afl-runlist">
        {runs.map((r) => (
          <button
            key={r.id}
            className={`afl-runrow ${r.status} ${selectedRunId === r.id ? 'on' : ''}`}
            onClick={() => onSelectRun(selectedRunId === r.id ? null : r.id)}
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
            onOpenProcess={(pid) =>
              previewRuns?.({
                scope: selectedRunId ? { flow_run_id: selectedRunId } : {},
                runId: pid,
                title: `Run ${selectedRunId?.slice(0, 8) ?? ''}`,
              })
            }
          />
          {flowId && (
            <ArtifactList flowId={flowId} runId={selectedRunId} executions={artifacts} />
          )}
        </>
      )}
    </div>
  );
}
