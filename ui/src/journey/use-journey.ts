import { dataContext, getMemoryJourney, isHubOnly, Journey, JourneyGraph, JourneyJournal, QueryRequest, type JourneyStep } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useActiveJourneyId, useActiveJourneyStep } from './use-active-journey-id';

/**
 * React bindings for the Journey model — and ONLY the bindings.
 *
 * What a graph is, how it parses, which journal is current, where the cursor
 * sits: all of that lives on `JourneyGraph` / `Journey` / `JourneyJournal` in
 * the SDK, where it can be exercised without mounting a component. This file
 * subscribes, holds lifecycle state, and hands the results back.
 *
 * If you find yourself adding a `useMemo` here that computes something about a
 * journey rather than about React, it belongs in the SDK.
 */

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

export interface UseJourneyResult {
  /** The journey named by `?journeyId=` — null when none is shown. */
  journey: Journey | null;
  /** The caller's journal for it (active, else most recent). */
  journal: JourneyJournal | null;
  /** The journey's steps — never null; an unloaded journey is an empty graph. */
  graph: JourneyGraph;
  currentStep: JourneyStep | null;
  /** Which step, 1-based, exactly as the URL spells it — or null when the URL
   *  names no position. THE cursor; `cursorIndex` is just this minus one. */
  stepNumber: number | null;
  cursorIndex: number;
  loading: boolean;
  /**
   * Re-read the journals. Call after any mutation: `restart`/`resume` flip the
   * status of TWO rows at once, and the REST response only carries one of them,
   * so the entity subscription alone can render a stale cursor.
   */
  refresh: () => void;
}

/** Every journey entity (there is normally one shipped "Getting started"). */
function useJourneys(enabled = true) {
  const request = useMemo(
    () => new QueryRequest({ type: Journey.type, scope: [], query: null, name: 'journeys:all' }),
    [],
  );
  return useEntitiesQuery<Journey>(request, { enabled: enabled && !isHubOnly() });
}

/** The caller's journals — WS-live, so a REST advance re-emits here. */
function useJournals(enabled = true) {
  const request = useMemo(
    () => new QueryRequest({ type: JourneyJournal.type, scope: [], query: null, name: 'journeyJournals:all' }),
    [],
  );
  return useEntitiesQuery<JourneyJournal>(request, { enabled: enabled && !isHubOnly() });
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

const EMPTY_GRAPH = new JourneyGraph();

/**
 * The journey's steps. Pure lifecycle: `journey.loadSteps()` owns the read and
 * the parse, this owns "which result is still wanted".
 */
export function useJourneySteps(journey: Journey | null): { graph: JourneyGraph; loading: boolean } {
  const [graph, setGraph] = useState<JourneyGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(false);
  // `loadSteps` resolves the compute node from dataContext, so a node that
  // arrives AFTER mount has to re-trigger the read — otherwise the journey is
  // stuck on the empty graph it returned before the node was known.
  const nodeKey = dataContext.computeNodeTypeId?.toString() ?? null;

  useEffect(() => {
    if (!journey) {
      setGraph(EMPTY_GRAPH);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void journey
      .loadSteps()
      .then((next) => {
        if (!cancelled) setGraph(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the journey's IDENTITY, not the object: the SDK updates cached
    // entities in place, so the reference is not a reliable change signal and
    // would re-read graph.json on every unrelated field update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journey?.id, journey?.asset_ref, nodeKey]);

  return { graph, loading };
}

/**
 * The journey currently SHOWN (`?journeyId=`) plus where in it you are.
 *
 * Everything is derived from the URL: it names the journey AND the step, and the
 * graph says what that step is. The journal is a RECORD (it keeps the resume
 * badge honest) and is deliberately not consulted for position — when it was,
 * the same step could render two ways depending on the path taken to it, because
 * the screen was composed onto wherever the user already happened to be.
 */
export function useShownJourney(): UseJourneyResult {
  const shownId = useActiveJourneyId();
  // A code-defined journey resolves from the registry, so it stands up NO
  // queries at all — the `enabled` flags below are what make that true rather
  // than merely unused.
  const memory = getMemoryJourney(shownId);
  const live = !!shownId && !memory;
  // No journey on the URL ⇒ the feature is idle — don't stand up live queries
  // for it. (The badge's useActiveJournal keeps its own journals query: telling
  // the user they have something to resume is exactly its job.)
  const { data: journeys = [], isLoading: journeysLoading } = useJourneys(live);
  const { data: journals = [], isLoading: journalsLoading, refetch: refetchJournals } = useJournals(live);

  // A memory journey owns its own run in memory, so nothing arrives over WS to
  // re-render on. `refresh()` — which every mutation already calls — forces the
  // render instead. Unconditional on purpose: an in-place mutation of a SERVER
  // journal has the same problem, so branching here would be asymmetric for no
  // reason.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  const journey = memory ?? (shownId ? (journeys.find((j) => j.id === shownId) ?? null) : null);
  const journal = memory ? memory.currentJournal : JourneyJournal.pick(journals, shownId);

  const { graph, loading: stepsLoading } = useJourneySteps(journey);

  // `?journeyStep=` is 1-based (it is shown to people); the graph is 0-indexed.
  // Out of range — a hand-edited URL, or a graph that shrank under a saved link
  // — reads as "no step", which the tray renders as its Start state rather than
  // crashing on an undefined step.
  const stepNumber = useActiveJourneyStep();
  const cursorIndex = stepNumber !== null && stepNumber <= graph.length ? stepNumber - 1 : -1;

  return {
    journey,
    journal,
    graph,
    currentStep: cursorIndex >= 0 ? (graph.steps[cursorIndex] ?? null) : null,
    stepNumber: cursorIndex >= 0 ? stepNumber : null,
    cursorIndex,
    loading: journeysLoading || journalsLoading || stepsLoading,
    refresh: () => {
      forceRender();
      if (live) void refetchJournals();
    },
  };
}
