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
 *
 * URL-first: the selected run and the scope both live in the dock's options
 * (`?run=…&flow_id=…`), never in local state, so every row is linkable and a
 * reload lands where you were. The scope keys go to the backend untranslated —
 * see PROCESS_RUN_SCOPE_KEYS.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import apiClient from '@sdk/client';
import { useOnTag } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer, PROCESS_RUN_SCOPE_KEYS, type ProcessRunScope } from '@src/navigation/DockPointer';
import { RunDetail } from './RunDetail';
import { RunRow, type RunSummary } from './RunRow';
import { RunFilters, matchesFilters, type RunFilterState, NO_RUN_FILTERS } from './RunFilters';
import './runs.css';

const PAGE = 50;

interface RunsResponse {
  runs: RunSummary[];
  limit: number;
  offset: number;
  scope: ProcessRunScope;
}

/** `?flow_id=…&agent=…` → the query string the backend expects, or ''. */
export function scopeQuery(scope: ProcessRunScope): string {
  const params = new URLSearchParams();
  for (const key of PROCESS_RUN_SCOPE_KEYS) {
    const value = scope[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `&${query}` : '';
}

/**
 * The runs list. Rendered both as the `/dock/process-runs` destination (no
 * props — scope and selection come from the URL) and, with an explicit
 * `scope`, inside the graph-workflow studio and the run-preview dialog. One
 * component, three surfaces: the alternative was a fourth divergent renderer,
 * and there were already three.
 */
export function RunsView({
  scope: fixedScope,
  onSelect,
  selectedId,
  compact,
}: {
  /** When given, the list is pinned to this scope and the URL is not read. */
  scope?: ProcessRunScope;
  /** Embedded surfaces own their own selection; the destination uses the URL. */
  onSelect?: (runId: string | null) => void;
  selectedId?: string | null;
  compact?: boolean;
} = {}) {
  const { navigation, currentDock } = useDockNavigation();
  const embedded = !!fixedScope;

  const scope = useMemo(
    () => fixedScope ?? currentDock?.processRunScope ?? {},
    // The dock is a fresh object per URL change; its scope is value-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fixedScope, JSON.stringify(fixedScope ?? currentDock?.processRunScope ?? {})],
  );
  const selected = embedded ? (selectedId ?? null) : (currentDock?.selectedRunId ?? null);

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<RunFilterState>(NO_RUN_FILTERS);

  const load = useCallback(async () => {
    try {
      const data = (await apiClient.get(`/runs?limit=${PAGE}${scopeQuery(scope)}`)) as RunsResponse | null;
      setRuns(data?.runs ?? []);
    } catch {
      // An empty list is the honest fallback; the detail pane explains itself.
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  // A run that starts or finishes should appear without a refresh. Both
  // families are already on the bus, so this needs no new plumbing.
  useOnTag('agent.status', () => void load());
  useOnTag('graph_workflow.done', () => void load());

  const select = useCallback(
    (runId: string | null) => {
      if (onSelect) {
        onSelect(runId);
        return;
      }
      navigation.openDock(DockPointer.forProcessRuns({ ...scope, run: runId }));
    },
    [navigation, onSelect, scope],
  );

  const shown = useMemo(() => runs.filter((r) => matchesFilters(r, filters)), [runs, filters]);

  return (
    <div className={`runs${compact ? ' compact' : ''}`}>
      <aside className="runs-list">
        <RunFilters
          runs={runs}
          value={filters}
          onChange={setFilters}
          shown={shown.length}
          scope={scope}
          // Only the destination can widen its own scope — an embedded list is
          // pinned by the surface that hosts it.
          onClearScope={embedded ? undefined : () => navigation.openDock(DockPointer.forProcessRuns())}
        />
        {loading ? (
          <p className="runs-empty">loading…</p>
        ) : shown.length === 0 ? (
          <p className="runs-empty">
            {runs.length === 0
              ? 'No runs yet. Anything that spawns a worker — a flow, an agent, a data source — shows up here.'
              : 'No run matches these filters.'}
          </p>
        ) : (
          <ol className="runs-rows">
            {shown.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                active={run.id === selected}
                onSelect={() => select(run.id === selected ? null : run.id)}
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
