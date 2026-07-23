import { dataContext, FSRef, Journey, JourneyJournal, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveJourneyId } from './use-active-journey-id';

/**
 * The shared busy-guarded mutation wrapper for journey UI (Tray/Viewer):
 * one op at a time, always `refresh()` on success (the mutation→refresh
 * contract — WS journal updates only reach watching tabs), errors logged.
 */
export function useBusyRun(refresh: () => void): {
  busy: boolean;
  run: (op: () => Promise<unknown>, then?: () => void) => void;
} {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(
    (op: () => Promise<unknown>, then?: () => void) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      op()
        .then(() => {
          refresh();
          then?.();
        })
        .catch((e: unknown) => console.error('[Journey] action failed', e))
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [refresh],
  );
  return { busy, run };
}

/** Where a step points the user — a standard dock pointer descriptor. */
export interface JourneyPresentDock {
  /** `root` = the app home `/` (not a dock URL) — the typical journey start. */
  kind?: 'asset_editor' | 'home' | 'wiki' | 'asset_list' | 'root' | 'shell';
  vfs?: string;
  name?: string;
  /** `shell`: the terminal session id to open — a `run` act targets the SAME
   *  id, so its command lands in the terminal the step just opened. */
  session?: string;
  /** `shell`: working directory to start in. */
  cwd?: string;
}

/** The proof side of an await: a store query that must hold (event ≠ proof). */
export interface JourneyConfirmSpec {
  type?: string;
  match?: Record<string, unknown>;
  min?: number;
  scope?: 'project' | 'all';
  /** Apply `match` CLIENT-side over the fetched rows (QueryFilter.validate)
   *  instead of in the server query — for serialization-derived fields the DB
   *  can't match (e.g. agentic_process.is_turn_busy). */
  local?: boolean;
}

/**
 * What satisfies a step — a unified-bus subscription (docs/topics.md):
 * `topic` names the event, `target` filters it (or `vfs`/`home` resolve a
 * route target via dockTarget), and `confirm` optionally proves it against
 * the store before the step advances.
 */
export interface JourneyAwaitSpec {
  topic?: string;
  target?: string;
  vfs?: string;
  home?: boolean;
  confirm?: JourneyConfirmSpec;
  /** Match against the EVENT'S OWN entity (`event.data.entity`, QueryFilter
   *  semantics): the row that just changed must itself satisfy this — the
   *  precise form of "you just did X", immune to ambient churn on other rows
   *  of the same type. Steps using it never auto-satisfy on mount (there is no
   *  event to match); the tray's Continue stays the escape hatch. */
  matchEvent?: Record<string, unknown>;
  /** The await is about a NEW occurrence: skip the on-mount confirm auto-check
   *  (which would satisfy against PRE-EXISTING state — e.g. "create an agent"
   *  must not auto-pass because old agents exist). The event must arrive; the
   *  confirm still gates it. Reload mid-step falls back to the tray's Continue. */
  fresh?: boolean;
  /** Don't advance on the signal — ARM the tray's Next and let the user click
   *  it. For steps where the user should see what happened before moving on
   *  (an `act` that filled a field for them). */
  manual?: boolean;
}

/**
 * Something the journey does FOR the user, offered as a highlighted button on
 * the step (`fill` → "Fill text") rather than performed behind their back. It
 * aims at the same `data-topic` anchor `present.highlight` uses, and announces
 * itself on the bus (`app.journey.act.done`) so the step's `await` gates on it
 * like any other event.
 */
export interface JourneyActSpec {
  /**
   * `fill` types text into a `data-topic` surface. The setup kinds drive the
   * capability system through its existing verbs: `setup_capability` fires the
   * install agentic process, `oauth_connect` opens the provider's OAuth flow,
   * `device_login` starts the capability's device-login session (surfaced by
   * the harness login modal). Their completion is NOT the act — the step's
   * `await` gates on the capability row reaching the wanted state.
   * `git_check` verifies the project's working tree against real git state
   * (via the compute node's `git-ops` action) — the "Check" button of a
   * try-it-yourself step: done only when the repo actually satisfies `expect`.
   */
  kind: 'fill' | 'open_terminal' | 'run' | 'fs_check' | 'setup_capability' | 'oauth_connect' | 'device_login' | 'git_check';
  /** Topic word of the target surface — `[data-topic="…"]`. For `git_check`
   *  it is just the act's bus identity (`git_check:<target>`), no DOM anchor. */
  target: string;
  text?: string;
  /** Capability kind for `setup_capability` / `device_login`. */
  capability?: string;
  /** OAuth provider for `oauth_connect` (default "github"). */
  provider?: string;
  /** `run`: the shell command to type + Enter into the step's terminal. */
  command?: string;
  /** `fs_check`: project-relative file that must exist. */
  path?: string;
  /** The assertion: for `fs_check` the file must contain it; for `run` the
   *  command's OUTPUT must contain it (and the command must exit 0) — without
   *  it, `run` only proves the keystrokes reached the terminal. */
  contains?: string;
  /** `git_check`: the repo predicate that must hold. */
  expect?: 'repo' | 'staged' | 'clean' | 'branch' | 'dirty';
  /** `git_check` + `expect:"branch"`: the branch name that must be current. */
  branch?: string;
  /** `git_check`: subfolder of the project working tree holding the repo. */
  dir?: string;
}

/** One guided step, read from the journey folder's `graph.json`. */
export interface JourneyStep {
  node_id: string;
  name: string;
  status_line: string;
  /** Sub-step grouping: consecutive steps sharing a `group` render under one
   *  expandable header in the tray/viewer. Pure presentation — the journal's
   *  cursor/entries machinery is flat and unchanged. */
  group?: string;
  present: { dock?: JourneyPresentDock; highlight?: string };
  act?: JourneyActSpec;
  await: JourneyAwaitSpec;
}

/** A render section: ungrouped steps stand alone; grouped ones share a header. */
export interface JourneyStepGroup {
  group: string | null;
  /** Indices into the flat `steps` array (order preserved). */
  indices: number[];
}

/** Fold the flat step list into consecutive-`group` sections for rendering. */
export function groupSteps(steps: JourneyStep[]): JourneyStepGroup[] {
  const sections: JourneyStepGroup[] = [];
  steps.forEach((step, i) => {
    const group = step.group ?? null;
    const last = sections[sections.length - 1];
    if (last && last.group !== null && last.group === group) last.indices.push(i);
    else sections.push({ group, indices: [i] });
  });
  return sections;
}

export interface UseJourneyResult {
  /** The journey named by `?journeyId=` — null when none is shown. */
  journey: Journey | null;
  /** The caller's journal for it (active, else most recent). */
  journal: JourneyJournal | null;
  steps: JourneyStep[];
  /** Journey-level start dock (graph.json `start`) — where a fresh run begins. */
  start: JourneyPresentDock | null;
  currentStep: JourneyStep | null;
  cursorIndex: number;
  loading: boolean;
  /**
   * Re-read the journals. Call after any mutation: `restart`/`resume` flip the
   * status of TWO rows at once, and the REST response only carries one of them,
   * so the entity subscription alone can render a stale cursor.
   */
  refresh: () => void;
}

/** The parsed authoring surface of a journey's `graph.json`. */
export interface JourneyGraph {
  steps: JourneyStep[];
  /** Journey-level START dock — where the journey begins (presented once, on a
   *  fresh journal, before the entry step's own present). `{kind:"root"}` = the
   *  app home. */
  start: JourneyPresentDock | null;
}

export function parseJourneyGraph(graphText: string): JourneyGraph {
  const doc = JSON.parse(graphText) as { start?: JourneyPresentDock; nodes?: Array<Record<string, never>> };
  return { steps: parseSteps(doc), start: doc.start ?? null };
}

function parseSteps(doc: { nodes?: Array<Record<string, never>> }): JourneyStep[] {
  return (doc.nodes ?? [])
    .filter((n) => (n as { node_type?: string }).node_type === 'guided_step')
    .map((n) => {
      const node = n as unknown as { id: string; name?: string; node_data?: Record<string, unknown> };
      const data = node.node_data ?? {};
      return {
        node_id: node.id,
        name: node.name || node.id,
        status_line: (data.status_line as string) ?? '',
        group: (data.group as string | undefined) || undefined,
        present: (data.present as JourneyStep['present']) ?? {},
        act: (data.act as JourneyStep['act']) ?? undefined,
        await: (data.await as JourneyStep['await']) ?? {},
      };
    });
}

/** Every journey entity (there is normally one shipped "Getting started"). */
function useJourneys(enabled = true) {
  const request = useMemo(
    () => new QueryRequest({ type: Journey.type, scope: [], query: null, name: 'journeys:all' }),
    [],
  );
  return useEntitiesQuery<Journey>(request, { enabled });
}

/** The caller's journals — WS-live, so a REST advance re-emits here. */
function useJournals(enabled = true) {
  const request = useMemo(
    () => new QueryRequest({ type: JourneyJournal.type, scope: [], query: null, name: 'journeyJournals:all' }),
    [],
  );
  return useEntitiesQuery<JourneyJournal>(request, { enabled });
}

/**
 * The in-progress journey, regardless of what the URL shows — the badge's
 * signal. Server state (the journal), so it survives reload and tells the user
 * they have something to resume even after they close the tray.
 */
export function useActiveJournal(): {
  journal: JourneyJournal | null;
  journeyId: string | null;
  refresh: () => void;
} {
  const { data: journals = [], refetch } = useJournals();
  const journal = useMemo(() => journals.find((j) => j.isActive) ?? null, [journals]);
  return { journal, journeyId: journal?.journey_id ?? null, refresh: () => void refetch() };
}

const EMPTY_GRAPH: JourneyGraph = { steps: [], start: null };

/** The journey's guided steps + start dock, read from `graph.json` (disk is truth). */
export function useJourneySteps(journey: Journey | null): {
  steps: JourneyStep[];
  start: JourneyPresentDock | null;
  loading: boolean;
} {
  const [graph, setGraph] = useState<JourneyGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(false);
  const assetRef = journey?.asset_ref ?? null;
  const nodeKey = dataContext.computeNodeTypeId?.toString() ?? null;

  useEffect(() => {
    const computeNodeTypeId = dataContext.computeNodeTypeId;
    if (!assetRef || !computeNodeTypeId) {
      setGraph(EMPTY_GRAPH);
      return;
    }
    let cancelled = false;
    setLoading(true);
    new FSRef(`${assetRef.replace(/^\/+/, '')}/graph.json`, computeNodeTypeId)
      .read()
      .then((text) => {
        if (!cancelled) setGraph(parseJourneyGraph(text));
      })
      .catch((e: unknown) => {
        console.error('[Journey] graph.json read failed', e);
        if (!cancelled) setGraph(EMPTY_GRAPH);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetRef, nodeKey]);

  return { steps: graph.steps, start: graph.start, loading };
}

/**
 * The journey currently SHOWN (`?journeyId=`) plus the caller's progress.
 *
 * Everything is derived — the URL says which journey, the journal entity says
 * where you are, `graph.json` says what the steps are. No in-memory state, so a
 * reload lands exactly where you were.
 */
export function useShownJourney(): UseJourneyResult {
  const shownId = useActiveJourneyId();
  // No journey on the URL ⇒ the feature is idle — don't stand up live queries
  // for it. (The badge's useActiveJournal keeps its own journals query: telling
  // the user they have something to resume is exactly its job.)
  const { data: journeys = [], isLoading: journeysLoading } = useJourneys(!!shownId);
  const { data: journals = [], isLoading: journalsLoading, refetch: refetchJournals } = useJournals(!!shownId);

  const journey = useMemo(
    () => (shownId ? (journeys.find((j) => j.id === shownId) ?? null) : null),
    [journeys, shownId],
  );

  const journal = useMemo(() => {
    if (!shownId) return null;
    const mine = journals.filter((j) => j.journey_id === shownId);
    // Active wins; otherwise the MOST RECENT journal (the one just completed) —
    // never an arbitrary row: an archived `restarted` journal still carries a
    // cursor, and picking it would make the manager re-present a stale step.
    const byRecency = [...mine].sort(
      (a, b) => Date.parse(b.updated_date ?? '') - Date.parse(a.updated_date ?? ''),
    );
    return mine.find((j) => j.isActive) ?? byRecency[0] ?? null;
  }, [journals, shownId]);

  const { steps, start, loading: stepsLoading } = useJourneySteps(journey);

  const cursorIndex = useMemo(
    () => (journal?.cursor ? steps.findIndex((s) => s.node_id === journal.cursor) : -1),
    [steps, journal?.cursor],
  );
  const currentStep = cursorIndex >= 0 ? (steps[cursorIndex] ?? null) : null;

  return {
    journey,
    journal,
    steps,
    start,
    currentStep,
    cursorIndex,
    loading: journeysLoading || journalsLoading || stepsLoading,
    refresh: () => void refetchJournals(),
  };
}
