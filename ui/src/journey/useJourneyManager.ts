import { dataContext, Shell, targetOf, TypeId, ViewType } from '@sdk';
import { useOnTag, useProject } from '@sdk/react/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { DockPointer, JOURNEY_STEP_PARAM } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { projectScope } from '@src/lib/scope-filter';
import type { JourneyPresentDock } from '@sdk';
import type { UseJourneyResult } from './use-journey';
import { ACT_FAILED_TAG, actTarget, runAct } from './act';
import { useWaitGate } from './use-wait-gate';

/** What the tray needs from the manager. Two movers, and nothing else. */
export interface JourneyManagerView {
  /** Open step 1 — what Start and Restart do once the run is recorded. */
  start: () => void;
  /** Load step N+1 — running this step's act first, and waiting for its gate. */
  next: () => void;
  /** Load step N−1. The mirror of next: no act, no gate. */
  back: () => void;
  /** Move on without doing the step: no act, and the gate does not apply. The
   *  escape hatch for a gate that will never open. */
  skip: () => void;
  /** There is a previous step to go back to. */
  canGoBack: boolean;
  /** Next has been pressed and is waiting on this step's gate. */
  waiting: boolean;
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
  dock: JourneyPresentDock,
  assetRef: string,
  computeNodeTypeId: TypeId | null,
  projectId: string | null,
  currentDock: DockPointer | null,
): DockPointer | null {
  return withMode(dockSurface(dock, assetRef, computeNodeTypeId, projectId, currentDock), dock);
}

/** Apply the step's authored view mode, when it names one. `stay` normally does
 *  not — it keeps whatever the surface it stayed on already had. */
function withMode(pointer: DockPointer | null, dock: JourneyPresentDock): DockPointer | null {
  if (!pointer || !dock.viewMode) return pointer;
  return pointer.withViewMode(dock.viewMode as ViewMode);
}

function dockSurface(
  dock: JourneyPresentDock,
  assetRef: string,
  computeNodeTypeId: TypeId | null,
  projectId: string | null,
  currentDock: DockPointer | null,
): DockPointer | null {
  switch (dock.kind) {
    case 'stay':
      // The surface the previous step's act produced — a build whose id the
      // author cannot know. Keeps the dock and only stamps the new step number.
      //
      // `here` rather than the React-state dock: the act navigates, and the gate
      // opens on the RESULT of that navigation, so by the time this resolves the
      // rendered dock can still be the pre-act one. Composing on the stale value
      // sent the step back where it came from. `here` is the pending-aware
      // pointer built for exactly this.
      return currentDock;
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
  const { journey, graph, currentStep, cursorIndex, refresh } = state;
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useProject();

  const journeyId = journey?.id ?? null;
  // What the URL addresses the journey BY. `identifier` is `@uname` for a
  // code-defined journey and the plain id for a server one — writing `id` for a
  // memory journey put a UUID on the URL that the registry could not resolve,
  // and the tray vanished on the first step.
  const journeyAddress = journey?.identifier ?? null;
  const projectId = project?.id ?? null;
  const computeNodeTypeId = dataContext.computeNodeTypeId ?? null;
  const assetRef = journey?.asset_ref ?? '';
  const stepNumber = cursorIndex >= 0 ? cursorIndex + 1 : null;

  // ── loading a step IS a navigation ──
  // The step names its whole destination and the number rides along, so the URL
  // is the position. Nothing is merged onto where the user already was, and no
  // effect "presents" a step behind the navigation's back — the two used to race,
  // and the loser was whichever wrote last.
  const goToStep = useCallback(
    (n: number) => {
      const step = graph.steps[n - 1];
      if (!step) return;
      const pointer = pointerForDock(step.present.dock, assetRef, computeNodeTypeId, projectId, navigation.here);
      if (!pointer) return;
      navigation.openDock(pointer.withJourney(journeyAddress).withJourneyStep(n));
    },
    [graph, assetRef, computeNodeTypeId, projectId, navigation, journeyAddress],
  );

  // ── the journal, as a RECORD ──
  // Written so the badge can offer "resume" and so a server journey's engine
  // sees its step release. Deliberately fire-and-forget: navigation must not
  // wait on an HTTP round trip, and nothing reads this back for position.
  const record = useCallback(
    (nodeId: string, event: 'done' | 'skipped' = 'done') => {
      if (!journey) return;
      journey
        .advance(nodeId, event)
        .then(() => refresh())
        .catch((e: unknown) => console.error('[Journey] advance failed', e));
    },
    [journey, refresh],
  );

  // ── journal invalidation: the flow.step.done boundary event ──
  // The engine emits it whenever a parked guided step releases, in ANY tab.
  // Event ≠ proof: the handler only wakes the journal refetch; the store stays
  // the truth.
  useOnTag('graph_workflow.step.done', () => {
    if (journeyId) void refresh();
  }, { target: journeyId ? targetOf('graph_workflow', journeyId) : 'graph_workflow:none' });

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
  }, [journeyId, stepNumber]);

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

  // ── the gate ──
  // Conditions only decide whether a PRESSED Next may land. They move nothing.
  const gate = useWaitGate(currentStep?.waitFor, `${journeyId ?? ''}:${stepNumber ?? ''}`, {
    dock: currentDock,
    projectId,
    label: `journeyGate:${journeyId}:${currentStep?.node_id}`,
  });

  // ── next: execute, then land ──
  // One press per step. It runs the step's act (the thing that moves the app),
  // then goes to the next step as soon as the gate opens — immediately when the
  // step has no gate. Pressing is the commitment; the gate only decides WHEN the
  // press completes, never whether the journey moves on its own.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => setWaiting(false), [stepNumber]);

  const land = useCallback(
    (event: 'done' | 'skipped' = 'done') => {
      if (!currentStep || stepNumber === null) return;
      setWaiting(false);
      record(currentStep.node_id, event);
      if (stepNumber < graph.length) {
        goToStep(stepNumber + 1);
        return;
      }
      // Past the last step there is no position to be at, so the number comes
      // off the URL — which is exactly what "completed" means here. The journey
      // id stays, so the tray remains to show the finale.
      //
      // `setOption`, not `openDock`: the step number is a STICKY param, and
      // openDock's carry-forward would put straight back the value we are
      // clearing. Same reason `closeJourney` bypasses it.
      navigation.setOption(JOURNEY_STEP_PARAM, null);
    },
    [currentStep, stepNumber, graph.length, record, goToStep, navigation],
  );

  const next = useCallback(() => {
    if (!currentStep) return;
    if (act && !actRan) doAct();
    if (gate.satisfied) land();
    else setWaiting(true);
  }, [currentStep, act, actRan, doAct, gate.satisfied, land]);

  // The pressed-but-gated case: the press already happened, so the moment the
  // gate opens it completes. Still user-driven — without the press nothing here
  // ever fires.
  useEffect(() => {
    if (waiting && gate.satisfied) land();
  }, [waiting, gate.satisfied, land]);

  const back = useCallback(() => {
    if (stepNumber !== null && stepNumber > 1) goToStep(stepNumber - 1);
  }, [stepNumber, goToStep]);

  const skip = useCallback(() => land('skipped'), [land]);
  const start = useCallback(() => goToStep(1), [goToStep]);

  return { start, next, back, skip, canGoBack: (stepNumber ?? 1) > 1, waiting };
}
