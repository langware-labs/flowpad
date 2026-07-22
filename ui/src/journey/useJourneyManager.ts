import { dataContext, dataManager, Journey, Project, QueryFilter, QueryRequest, targetOf, TypeId } from '@sdk';
import { useOnTopic, useProject } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { projectScope } from '@src/lib/scope-filter';
import { dockTarget } from '@src/topics/dock-target';
import type { JourneyPresentDock, JourneyStep, UseJourneyResult } from './use-journey';
import { runAct } from './act';

/** What the tray needs from the manager to render the step's own buttons. */
export interface JourneyManagerView {
  /** The current step's act has not run yet — offer its button ("Fill text"). */
  actPending: boolean;
  /** Run it (and announce it on the bus, which arms the await). */
  doAct: () => void;
  /** A `manual` await is satisfied: light Next, wait for the click. */
  armed: boolean;
}

function joinVfs(assetRef: string, vfs: string): string {
  return `${assetRef.replace(/\/+$/, '')}/${vfs.replace(/^\/+/, '')}`;
}

/**
 * The single mapping from a step's `present.dock` descriptor to a URL-first
 * DockPointer. `journeyId` is NOT added here — `openDock` carries it forward
 * automatically (the journey is topmost), which is exactly what keeps the tray
 * alive as the manager walks the user between surfaces.
 */
function pointerForDock(
  dock: JourneyPresentDock | undefined,
  assetRef: string,
  computeNodeTypeId: TypeId | null,
  projectId: string | null,
): DockPointer | null {
  switch (dock?.kind) {
    case 'asset_editor':
      return AssetDocPointer.forVfs(
        AssetEditor.HTML,
        joinVfs(assetRef, dock.vfs ?? ''),
        computeNodeTypeId ?? undefined,
      ).toDockPointer();
    case 'home':
      return projectId ? DockPointer.forAssetProjectHome({ scope: projectScope(projectId) }) : null;
    case 'wiki':
      return DockPointer.forWiki(dock.name ?? '');
    case 'asset_list':
      return DockPointer.forAssetList(dock.name ?? '');
    default:
      return null;
  }
}

/**
 * Drives the SHOWN journey (`?journeyId=`) over the unified EventBus: presents
 * the current step on a standard dock pointer + wiki-word highlight, holds
 * exactly ONE live bus subscription (the current step's await — cursor moves
 * re-key the hook, so the old await unhooks before the new one arms), and
 * advances through the backend (the single writer).
 *
 * Event ≠ proof: an awaited event with a `confirm` predicate only wakes the
 * check — the store query decides. Confirm-gated steps also check once on step
 * mount, so a reload (or work done before the step armed) auto-satisfies.
 *
 * Runs only while a journey is shown — clearing the param stops all of it.
 */
export function useJourneyManager(state: UseJourneyResult): JourneyManagerView {
  const { journey, journal, currentStep, start, refresh } = state;
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();

  const journeyId = journey?.id ?? null;
  const projectId = project?.id ?? null;
  const computeNodeTypeId = dataContext.computeNodeTypeId ?? null;
  const assetRef = journey?.asset_ref ?? '';
  const cursor = journal?.cursor ?? null;
  const stepAwait = currentStep?.await;

  // ── advance (guarded so a flapping signal can't double-fire a step) ──
  const advancedRef = useRef<string | null>(null);
  const doAdvance = useCallback(
    (nodeId: string, event: 'done' | 'skipped' = 'done') => {
      if (!journey || advancedRef.current === nodeId) return;
      advancedRef.current = nodeId;
      // Refresh is EVENT-driven (the flow.step.done subscription below) — the
      // backend's boundary emission reaches every tab via topic_msg, so the
      // cursor re-derivation no longer needs a post-advance refetch chain.
      journey.advance(nodeId, event).catch((e: unknown) => {
        console.error('[Journey] advance failed', e);
        advancedRef.current = null; // let the signal retry
      });
    },
    [journey],
  );

  // ── journal invalidation: the flow.step.done boundary event ──
  // The engine emits `flow.step.done` (target = this journey's flow entity)
  // whenever a parked guided step releases — in ANY tab. Event ≠ proof: the
  // handler only wakes the journal refetch; the store stays the truth. This
  // replaces the old post-advance `.then(refresh)` chain and closes the
  // journal-WS-watch gap (updates only reached watch-holding tabs).
  // useOnTopic rides the handler on a ref, so refresh's unstable identity
  // cannot churn the subscription (it resubscribes only on target change).
  useOnTopic('flow.step.done', () => {
    if (journeyId) void refresh();
  }, { target: journeyId ? targetOf('agentic_flow', journeyId) : 'agentic_flow:none' });

  // ── present the current step (once per cursor PER RUN) ──
  // The key includes the JOURNAL id: a restart mints a fresh journal whose
  // cursor is the same entry node — without the journal in the key, the entry
  // step would count as "already presented" and Restart would leave the user
  // wherever they were instead of re-opening the journey's START dock.
  const presentedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!journeyId || !currentStep) return;
    const key = `${journeyId}:${journal?.id ?? 'nojournal'}:${currentStep.node_id}`;
    if (presentedRef.current === key) return;
    presentedRef.current = key;

    const present = currentStep.present ?? {};
    // A FRESH run begins at the journey's START dock (graph.json `start`): the
    // entry step inherits it as its surface when it doesn't name its own.
    const fresh = (journal?.entries?.length ?? 0) === 0;
    const dock = present.dock ?? (fresh ? (start ?? undefined) : undefined);

    if (dock?.kind === 'root') {
      // The app home `/` is not a dock URL — navigate there directly, carrying
      // the sticky journey param (openHomeRoot does both).
      navigation.openHomeRoot(present.highlight);
      return;
    }
    const pointer = pointerForDock(dock, assetRef, computeNodeTypeId, projectId);
    if (pointer) {
      navigation.openDock(present.highlight ? pointer.withHighlight(present.highlight) : pointer);
    } else if (present.highlight) {
      // Highlight-only step: light the topic IN PLACE. Only fall back to the
      // home-root highlight when there is no dock to stay on — a step like
      // "click Use agent" must not navigate the user away from the editor.
      if (currentDock) navigation.openDock(currentDock.withHighlight(present.highlight));
      else navigation.highlight(present.highlight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyId, journal?.id, currentStep?.node_id, assetRef, computeNodeTypeId, projectId]);

  // ── await: the step's bus target filter ──
  // Route awaits may be authored as a journey-relative `vfs` (or `home: true`)
  // instead of a literal target; resolve them through the SAME dockTarget
  // helper the route emitter stamps, so identities can never drift apart.
  const filterTarget = useMemo(() => {
    if (!stepAwait) return undefined;
    if (stepAwait.target) return stepAwait.target;
    if (stepAwait.home) return 'dock:home';
    if (stepAwait.vfs) {
      const p = pointerForDock({ kind: 'asset_editor', vfs: stepAwait.vfs }, assetRef, computeNodeTypeId, null);
      return p ? dockTarget(p) : undefined;
    }
    return undefined;
  }, [stepAwait, assetRef, computeNodeTypeId]);

  // ── the step's own act ("Fill text") + the manual arm state ──
  // Both are per-step: a cursor move clears them so the next step starts with
  // its own button offered and Next dark again.
  const [actRan, setActRan] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setActRan(false);
    setArmed(false);
  }, [journeyId, cursor]);

  const act = currentStep?.act;
  const doAct = useCallback(() => {
    if (!act) return;
    setActRan(true);
    runAct(act);
  }, [act]);

  // ── await: confirm predicate (the proof) ──
  const busyRef = useRef(false);
  const tryComplete = useCallback(async (event?: { data?: Record<string, unknown> }) => {
    if (!currentStep || busyRef.current || advancedRef.current === currentStep.node_id) return;
    // matchEvent: the row that JUST changed must itself satisfy the match —
    // "you just did X", immune to ambient churn on other rows of the type.
    const matchEvent = currentStep.await?.matchEvent;
    if (matchEvent) {
      const entity = event?.data?.entity;
      if (!entity || !new QueryFilter({ match: matchEvent }).validate(entity)) return;
    }
    busyRef.current = true;
    try {
      const confirm = currentStep.await?.confirm;
      if (confirm) {
        const scope = projectId && confirm.scope !== 'all' ? [new TypeId(Project.type, projectId)] : [];
        const filter = confirm.match ? new QueryFilter({ match: confirm.match }) : null;
        const request = new QueryRequest({
          type: confirm.type ?? '',
          scope,
          name: `journeyConfirm:${journeyId}:${currentStep.node_id}`,
          // `local` confirms match client-side (QueryFilter.validate) — for
          // serialization-derived fields the server query can't see.
          query: confirm.local ? null : filter,
        });
        let rows = await dataManager.query(request, true);
        if (confirm.local && filter) rows = rows.filter((r) => filter.validate(r));
        if (rows.length < (confirm.min ?? 1)) return;
      }
      // `manual`: the signal ARMS the step — the user clicks Next to move on,
      // so they can see what just happened (e.g. the text an act filled in).
      if (currentStep.await?.manual) setArmed(true);
      else doAdvance(currentStep.node_id);
    } catch (e) {
      console.error('[Journey] confirm query failed', e);
    } finally {
      busyRef.current = false;
    }
  }, [currentStep, journeyId, projectId, doAdvance]);

  // ── await: ONE live subscription — the current step's ──
  useOnTopic(
    stepAwait?.topic || 'journey.idle',
    (event) => void tryComplete(event),
    filterTarget !== undefined ? { target: filterTarget } : undefined,
  );

  // Confirm-gated steps auto-satisfy if already true (reload / pre-done work) —
  // unless the await is `fresh` or `matchEvent` (about a NEW occurrence), where
  // pre-existing state must not count and only the event may wake the check.
  useEffect(() => {
    if (currentStep?.await?.confirm && !currentStep.await.fresh && !currentStep.await.matchEvent) {
      void tryComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyId, currentStep?.node_id]);

  // Reset the per-step advance guard whenever the cursor moves.
  useEffect(() => {
    if (cursor && advancedRef.current && advancedRef.current !== cursor) advancedRef.current = null;
  }, [cursor]);

  return { actPending: !!act && !actRan, doAct, armed };
}

export type { JourneyStep };
export { Journey };
