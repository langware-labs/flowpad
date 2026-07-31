/**
 * Runs — one place that answers "what ran, and what came out".
 *
 * Before this there were eight surfaces showing a run and not one was a
 * destination: every list was keyed on the entity that SPAWNED the run, so a
 * run with no spawning entity — an ingest driver's worker, an agent launched
 * from its profile — could not be reached from the UI at all.
 *
 * Master–detail, and the detail leads with the OUTPUT. The old panel led with
 * the journal, which is backwards: the artifact is what you came for, and the
 * timeline is forensics for when it went wrong.
 */
import { useCallback, useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { useOnTag } from '@sdk/react/hooks';
import { RunDetail } from './RunDetail';
import { RunRow, type RunSummary } from './RunRow';
import './runs.css';

const PAGE = 50;

interface RunsResponse {
  runs: RunSummary[];
  limit: number;
  offset: number;
}

export function RunsView() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const data = (await apiClient.get(`/runs?limit=${PAGE}`)) as RunsResponse | null;
      setRuns(data?.runs ?? []);
    } catch {
      // An empty list is the honest fallback; the detail pane explains itself.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A run that starts or finishes should appear without a refresh. Both
  // families are already on the bus, so this needs no new plumbing.
  useOnTag('agent.status', () => void load());
  useOnTag('graph_workflow.done', () => void load());

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? runs.filter((r) =>
        [r.name, r.agent, r.prompt].some((v) => (v ?? '').toLowerCase().includes(needle)),
      )
    : runs;

  return (
    <div className="runs">
      <aside className="runs-list">
        <div className="runs-bar">
          <input
            className="runs-filter"
            value={filter}
            placeholder="filter runs…"
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="runs-count">{shown.length}</span>
        </div>
        {loading ? (
          <p className="runs-empty">loading…</p>
        ) : shown.length === 0 ? (
          <p className="runs-empty">
            No runs yet. Anything that spawns a worker — a flow, an agent, a data source —
            shows up here.
          </p>
        ) : (
          <ol className="runs-rows">
            {shown.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === selected}
                onSelect={() => setSelected(run.id === selected ? null : run.id)}
              />
            ))}
          </ol>
        )}
      </aside>
      <section className="runs-detail">
        {selected ? (
          <RunDetail runId={selected} />
        ) : (
          <p className="runs-empty pad">Select a run to see what it produced.</p>
        )}
      </section>
    </div>
  );
}

export default RunsView;
