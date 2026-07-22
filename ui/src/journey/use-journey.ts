import { dataContext, FSRef, Journey, JourneyJournal, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useEffect, useMemo, useState } from 'react';
import { useActiveJourneyId } from './use-active-journey-id';

/** Where a step points the user — a standard dock pointer descriptor. */
export interface JourneyPresentDock {
  kind?: 'asset_editor' | 'home' | 'wiki';
  vfs?: string;
  name?: string;
}

/** The proof side of an await: a store query that must hold (event ≠ proof). */
export interface JourneyConfirmSpec {
  type?: string;
  match?: Record<string, unknown>;
  min?: number;
  scope?: 'project' | 'all';
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
}

/** One guided step, read from the journey folder's `graph.json`. */
export interface JourneyStep {
  node_id: string;
  name: string;
  status_line: string;
  present: { dock?: JourneyPresentDock; highlight?: string };
  await: JourneyAwaitSpec;
}

export interface UseJourneyResult {
  /** The journey named by `?journeyId=` — null when none is shown. */
  journey: Journey | null;
  /** The caller's journal for it (active, else most recent). */
  journal: JourneyJournal | null;
  steps: JourneyStep[];
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

function parseSteps(graphText: string): JourneyStep[] {
  const doc = JSON.parse(graphText) as { nodes?: Array<Record<string, never>> };
  return (doc.nodes ?? [])
    .filter((n) => (n as { node_type?: string }).node_type === 'guided_step')
    .map((n) => {
      const node = n as unknown as { id: string; name?: string; node_data?: Record<string, unknown> };
      const data = node.node_data ?? {};
      return {
        node_id: node.id,
        name: node.name || node.id,
        status_line: (data.status_line as string) ?? '',
        present: (data.present as JourneyStep['present']) ?? {},
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

/** The journey's guided steps, read from its `graph.json` (disk is truth). */
export function useJourneySteps(journey: Journey | null): { steps: JourneyStep[]; loading: boolean } {
  const [steps, setSteps] = useState<JourneyStep[]>([]);
  const [loading, setLoading] = useState(false);
  const assetRef = journey?.asset_ref ?? null;
  const nodeKey = dataContext.computeNodeTypeId?.toString() ?? null;

  useEffect(() => {
    const computeNodeTypeId = dataContext.computeNodeTypeId;
    if (!assetRef || !computeNodeTypeId) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    new FSRef(`${assetRef.replace(/^\/+/, '')}/graph.json`, computeNodeTypeId)
      .read()
      .then((text) => {
        if (!cancelled) setSteps(parseSteps(text));
      })
      .catch((e: unknown) => {
        console.error('[Journey] graph.json read failed', e);
        if (!cancelled) setSteps([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetRef, nodeKey]);

  return { steps, loading };
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

  const { steps, loading: stepsLoading } = useJourneySteps(journey);

  const cursorIndex = useMemo(
    () => (journal?.cursor ? steps.findIndex((s) => s.node_id === journal.cursor) : -1),
    [steps, journal?.cursor],
  );
  const currentStep = cursorIndex >= 0 ? (steps[cursorIndex] ?? null) : null;

  return {
    journey,
    journal,
    steps,
    currentStep,
    cursorIndex,
    loading: journeysLoading || journalsLoading || stepsLoading,
    refresh: () => void refetchJournals(),
  };
}
