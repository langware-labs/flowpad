import { dataContext, Shell, targetOf, TypeId, ViewType } from '@sdk';
import { useOnTag, useProject } from '@sdk/react/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { projectScope } from '@src/lib/scope-filter';
import type { JourneyPresentDock } from '@sdk';
import type { UseJourneyResult } from './use-journey';
import { ACT_FAILED_TAG, actTarget, runAct } from './act';
import { useWaitFor } from './use-wait-for';

/** What the tray needs from the manager to render the step's own buttons. */
export interface JourneyManagerView {
  /** The current step's act has not run yet — offer its button ("Fill text"). */
  actPending: boolean;
  /** Run it (and announce it on the bus, where a condition can see it). */
  doAct: () => void;
  /** The step is waiting on the user: light Next rather than dimming it. */
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
    case 'root':
      // Used to be an early return calling `openHomeRoot`, which skipped the
      // `.withViewMode(Vibe)` and highlight composition every other kind gets —
      // so a `start: {kind:'root'}` step landed on the home OUT of vibe.
      return DockPointer.root();
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
  const { journey, journal, graph, currentStep, refresh } = state;
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();

  const journeyId = journey?.id ?? null;
  const projectId = project?.id ?? null;
  const computeNodeTypeId = dataContext.computeNodeTypeId ?? null;
  const assetRef = journey?.asset_ref ?? '';
  const cursor = journal?.cursor ?? null;

  // ── advance (guarded so a flapping signal can't double-fire a step) ──
  const advancedRef = useRef<string | null>(null);
  // TRANSPARENCY: when a step advances because of the user's OWN UI action
  // (an `app.ui.*` event — they clicked something and are already navigating),
  // the NEXT step must not override their destination with its dock. Consumed
  // once by the present effect: highlight-in-place only for that present.
  const suppressNextDockRef = useRef(false);
  const doAdvance = useCallback(
    (nodeId: string, event: 'done' | 'skipped' = 'done') => {
      if (!journey || advancedRef.current === nodeId) return;
      advancedRef.current = nodeId;
      // Other tabs refresh off the flow.step.done boundary event; the CALLING
      // tab refreshes on the response it already has. The event alone is not
      // enough here: when the journey's parked run has died, the backend
      // advance still lands (and re-parks a fresh run) but emits nothing.
      journey
        .advance(nodeId, event)
        .then(() => refresh())
        .catch((e: unknown) => {
          console.error('[Journey] advance failed', e);
          advancedRef.current = null; // let the signal retry
        });
    },
    [journey, refresh],
  );

  // ── journal invalidation: the flow.step.done boundary event ──
  // The engine emits `flow.step.done` (target = this journey's flow entity)
  // whenever a parked guided step releases — in ANY tab. Event ≠ proof: the
  // handler only wakes the journal refetch; the store stays the truth. This
  // replaces the old post-advance `.then(refresh)` chain and closes the
  // journal-WS-watch gap (updates only reached watch-holding tabs).
  // useOnTag rides the handler on a ref, so refresh's unstable identity
  // cannot churn the subscription (it resubscribes only on target change).
  useOnTag('graph_workflow.step.done', () => {
    if (journeyId) void refresh();
  }, { target: journeyId ? targetOf('graph_workflow', journeyId) : 'graph_workflow:none' });

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
    const fresh = journal?.isFresh ?? true;
    let dock = present.dock ?? (fresh ? (graph.start ?? undefined) : undefined);

    // Consume the transparency flag: this step was reached by the user's own
    // click — they are already navigating; don't override their destination.
    // The highlight still applies, in place.
    if (suppressNextDockRef.current) {
      suppressNextDockRef.current = false;
      dock = undefined;
    }

    // A journey runs in VIBE unless the author says otherwise: every surface it
    // opens carries the mode, and `useDockViewModeOverrideSync` adopts it as the
    // preference — so the skin survives the steps that navigate nowhere. The
    // override exists because a journey ABOUT the vibe boundary must be able to
    // start outside it, or its first step is satisfied before it is shown.
    const pointer = pointerForDock(dock, assetRef, computeNodeTypeId, projectId)?.withViewMode(
      (dock.viewMode as ViewMode | undefined) ?? ViewMode.Vibe,
    );
    if (pointer) {
      navigation.openDock(present.highlight ? pointer.withHighlight(present.highlight) : pointer);
    } else if (present.highlight) {
      // Highlight-only step: light the tag IN PLACE — a pure param update on
      // the live URL. Rebuilding from `currentDock` would race an in-flight
      // navigation (the user's own click) and yank them backwards.
      navigation.applyHighlightInPlace(present.highlight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyId, journal?.id, currentStep?.node_id, assetRef, computeNodeTypeId, projectId]);

  // ── the step's own act ("Fill text") + the manual arm state ──
  // Both are per-step: a cursor move clears them so the next step starts with
  // its own button offered and Next dark again.
  const [actRan, setActRan] = useState(false);
  // Acts that watch for something (a command's output) must not outlive the
  // step that started them — this aborts on every cursor move and on unmount.
  const actAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setActRan(false);
    return () => {
      actAbortRef.current?.abort();
      actAbortRef.current = null;
    };
  }, [journeyId, cursor]);

  const act = currentStep?.act;
  // The terminal the user is looking at — `run` acts type into THIS shell.
  // DockPointer owns the shell-pointer grammar (`shell-<id>` / bare / an
  // agentic process); never re-derive it from the raw path.
  const shellTypeId =
    currentDock?.viewType === ViewType.SHELL && currentDock.pointer
      ? DockPointer.terminalTargetTypeIdForShellPointer(currentDock.pointer)
      : null;
  const shellId = shellTypeId?.type === Shell.type ? shellTypeId.id : undefined;

  // The project the JOURNEY ships in: `<root>/agentic-assets/journey/<name>`. Its
  // try-it steps must run THERE — a tour that says "the repo you're in IS
  // syncmd" was otherwise writing files into whatever project happened to be
  // active (and running `syncmd` outside a git repo, where it cannot work).
  const journeyRoot = journey?.projectRoot ?? null;

  const openTerminal = useCallback(async () => {
    // openNewShell already navigates to the new shell when we don't opt out.
    const result = await navigation.openNewShell({
      viewMode: ViewMode.Vibe,
      ...(journeyRoot ? { cwd: journeyRoot } : {}),
    });
    return result?.shellId ?? null;
  }, [navigation, journeyRoot]);

  const doAct = useCallback(() => {
    if (!act) return;
    setActRan(true);
    actAbortRef.current?.abort();
    const controller = new AbortController();
    actAbortRef.current = controller;
    // Async acts announce their own outcome on the bus; nothing to await here.
    void runAct(act, { shellId, openTerminal, signal: controller.signal, projectRoot: journeyRoot });
  }, [act, shellId, openTerminal, journeyRoot]);

  // A failed act re-offers its button — a `git_check` is MEANT to be retried
  // until the repo actually satisfies it ("not yet — try the command").
  useOnTag(
    ACT_FAILED_TAG,
    () => setActRan(false),
    act ? { target: actTarget(act.kind, act.target) } : undefined,
  );

  // ── what the step waits for ──
  // One list of conditions, in order. The manager does not know how any of them
  // is observed — that is `useWaitFor`'s business.
  const wait = useWaitFor(
    currentStep?.waitFor,
    `${journeyId ?? ''}:${cursor ?? ''}`,
    { dock: currentDock, projectId, label: `journeyWait:${journeyId}:${currentStep?.node_id}` },
    ({ userCaused }) => {
      if (!currentStep) return;
      // A step the user reached by their own click means they are already
      // navigating somewhere of their own choosing — the next step highlights in
      // place rather than overriding their destination. Read from the envelope's
      // attribution, never guessed from a tag name.
      suppressNextDockRef.current = userCaused;
      doAdvance(currentStep.node_id);
    },
  );

  // Reset the per-step advance guard whenever the cursor moves.
  useEffect(() => {
    if (cursor && advancedRef.current && advancedRef.current !== cursor) advancedRef.current = null;
  }, [cursor]);

  return { actPending: !!act && !actRan, doAct, armed: wait.awaitingManual };
}

