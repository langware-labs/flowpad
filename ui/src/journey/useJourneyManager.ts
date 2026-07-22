import { dataContext, dataManager, Journey, Project, QueryFilter, QueryRequest, TypeId } from '@sdk';
import { useOnTopic, useProject } from '@sdk/react/hooks';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { projectScope } from '@src/lib/scope-filter';
import { dockTarget } from '@src/topics/dock-target';
import type { JourneyPresentDock, JourneyStep, UseJourneyResult } from './use-journey';

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
export function useJourneyManager(state: UseJourneyResult): void {
  const { journey, journal, currentStep, refresh } = state;
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
      journey
        .advance(nodeId, event)
        // The mutation→refresh contract (same as Tray/Viewer): the WS journal
        // update only reaches tabs holding a watch on the row, so the cursor
        // re-derivation must not depend on it — refetch after every advance.
        .then(() => refresh())
        .catch((e: unknown) => {
          console.error('[Journey] advance failed', e);
          advancedRef.current = null; // let the signal retry
        });
    },
    [journey, refresh],
  );

  // ── present the current step (once per cursor) ──
  const presentedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!journeyId || !currentStep) return;
    const key = `${journeyId}:${currentStep.node_id}`;
    if (presentedRef.current === key) return;
    presentedRef.current = key;

    const present = currentStep.present ?? {};
    const pointer = pointerForDock(present.dock, assetRef, computeNodeTypeId, projectId);
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
  }, [journeyId, currentStep?.node_id, assetRef, computeNodeTypeId, projectId]);

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

  // ── await: confirm predicate (the proof) ──
  const busyRef = useRef(false);
  const tryComplete = useCallback(async () => {
    if (!currentStep || busyRef.current || advancedRef.current === currentStep.node_id) return;
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
      doAdvance(currentStep.node_id);
    } catch (e) {
      console.error('[Journey] confirm query failed', e);
    } finally {
      busyRef.current = false;
    }
  }, [currentStep, journeyId, projectId, doAdvance]);

  // ── await: ONE live subscription — the current step's ──
  useOnTopic(
    stepAwait?.topic || 'journey.idle',
    () => void tryComplete(),
    filterTarget !== undefined ? { target: filterTarget } : undefined,
  );

  // Confirm-gated steps auto-satisfy if already true (reload / pre-done work) —
  // unless the await is `fresh` (about a NEW occurrence), where pre-existing
  // state must not count and only the event may wake the check.
  useEffect(() => {
    if (currentStep?.await?.confirm && !currentStep.await.fresh) void tryComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyId, currentStep?.node_id]);

  // Reset the per-step advance guard whenever the cursor moves.
  useEffect(() => {
    if (cursor && advancedRef.current && advancedRef.current !== cursor) advancedRef.current = null;
  }, [cursor]);
}

export type { JourneyStep };
export { Journey };
