import type { ShowPlacement, ShowTarget } from '@sdk';
import { AgenticProcess, dataManager, tabManager, TypeId, type IEntity } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { presentDockTab } from '@src/navigation/present-dock-tab';

import { useCallback, useEffect, useRef } from 'react';

/**
 * `flow show` from a process NOT open as a host tab — mint the target as a tab
 * beside the calling process.
 *
 * The verb is one address; the PRESENTATION adapts, and the backend decides it
 * (`placement`, from `tab.show_placement`): a process open as a HOST (Vibe) tab
 * pins the target in its own Display pane (`vibe-workspace` /
 * `asset-vibe-workspace`), so this listener leaves it alone — except a SCREEN,
 * which nests as that tab's child. Any other process has no display pane, so the
 * target becomes what it would have been if the user had opened it: a top-level
 * tab, placed immediately after the process's own tab. Two sessions shown two
 * ways each get their own answer — it is no longer one app-wide mode.
 *
 * **It never navigates.** A show is the agent saying "this is ready", not "drop
 * what you are doing" — and unlike vibe's pane repaint, navigating here would
 * yank a user who is mid-task in another tab. The intent is carried instead by
 * a brief glow on the destination tab and the Shown chip on the process's
 * bottom ribbon (beside Open Plan). Three problems
 * fall away with the navigation: a background agent cannot interrupt anyone,
 * `on_show`'s broadcast to EVERY client (browser tabs, `/win` popouts, the
 * desktop shell) becomes idempotent — minting one deterministic row N times is
 * still one row and zero navigations — and there is no race with a route loader.
 */
/** Stable identity — `useEntityOps` re-subscribes when this changes. */
const PROCESS_TYPES = [AgenticProcess.type];

/**
 * Is this persisted show NEWS to a client that mounted at `mountedAt`?
 *
 * A tab is durable, so a show stamped before we mounted is already represented
 * — its tab exists, or the user closed it deliberately — and acting on it would
 * undo that close on every reload. Only a show newer than the mount is news.
 *
 * Pure and exported for the regression test: the first version of this gate
 * used a "first observation sets a baseline" flag, which is correct for the
 * per-process vibe surfaces but WRONG here, because this listener serves every
 * process — whichever unrelated process updated first consumed the baseline and
 * every stale target sailed through. Verified in the browser: a closed tab came
 * back on reload.
 */
export function isFreshShow(
  displayStack: ReadonlyArray<{ shown_at?: string }> | undefined,
  mountedAt: number,
): boolean {
  const newestAt = Date.parse(displayStack?.[displayStack.length - 1]?.shown_at ?? '');
  return Number.isFinite(newestAt) && newestAt >= mountedAt;
}

/** No placement (an older backend): no anchor, not a host — a plain tab at the end. */
const NO_PLACEMENT: ShowPlacement = { tab_id: null, host: false };

/**
 * Where this listener puts a show, from the backend's placement — or null when
 * it is not this listener's to place (a host tab's own Display pane pins it).
 * Pure and exported for the test.
 */
export function showTabSlot(
  target: ShowTarget,
  placement: ShowPlacement,
): { afterTabId: string | null; parentTabId: string | null } | null {
  const screen = target.kind === 'dock';
  if (placement.host && !screen) return null;
  return { afterTabId: placement.tab_id, parentTabId: placement.host && screen ? placement.tab_id : null };
}

export function useShowTargetListener(): void {
  // The first live event confirms the durable update. Later live events are
  // new shows, even when their target is identical, and must replay the cue.
  const handledRef = useRef(new Map<string, { key: string; sawLive: boolean }>());
  // Persisted shows older than this are history, not commands (see below).
  const mountedAtRef = useRef(Date.now());

  const showTarget = useCallback(async (
    target: ShowTarget,
    placement: ShowPlacement,
    slot: { afterTabId: string | null; parentTabId: string | null },
  ): Promise<void> => {
    const dock = dockForDisplayTarget(target);
    if (!dock) {
      // A real answer, not a failure: an entity type with no editor and no
      // path, or an `app` with no dev server, addresses nothing openable. The
      // target still lives in the process's display history.
      console.debug('[flow show] target has no dock in this mode', target);
      return;
    }

    // The anchor is the process's OWN tab, as the backend resolved it.
    const anchor = placement.tab_id ? tabManager.getSnapshot().find((t) => t.id === placement.tab_id) : undefined;

    await presentDockTab(dock, { projectId: anchor?.project_id, ...slot });
  }, []);

  const handle = useCallback(
    (processId: string, target: ShowTarget | null | undefined, placement: ShowPlacement, live = false): void => {
      if (!target || !processId) return;
      // The host gate lives HERE, not on the subscriptions, because it depends
      // on the target's KIND. A host tab pins a deliverable (file / entity /
      // webapp) in its Display pane, so this listener leaves those alone — but a
      // SCREEN has no place in that pane, so it is minted as the host's child.
      // A process not open as a host has no pane at all and mints every kind.
      const slot = showTabSlot(target, placement);
      if (!slot) return;
      const key = JSON.stringify(target);
      const previous = handledRef.current.get(processId);
      if (previous?.key === key) {
        if (!live) return;
        if (!previous.sawLive) {
          previous.sawLive = true;
          return;
        }
      }
      handledRef.current.set(processId, { key, sawLive: live });
      void showTarget(target, placement, slot);
    },
    [showTarget],
  );

  // Live channel — the transient `on_show` entity event. Manager-level rather
  // than bound to one process instance: outside vibe there is no "session", and
  // since nothing steals focus it is safe to serve every process at once.
  useEffect(() => {
    // No mode gate here — `handle` decides per target (see `mintsTab`).
    // The `dataManager` SINGLETON is the emitter (`FlowSync/store.ts` surfaces
    // every entity event at manager level). Note `dataContext.dataManager` is
    // NOT it — that property does not exist, so reading the manager from the
    // context yields undefined and silently kills the subscription.
    const onEntityEvent = (typeId: TypeId, event: string, payload: Record<string, unknown>): void => {
      if (event !== 'on_show' || typeId.type !== AgenticProcess.type) return;
      // The live event is the target plus the backend's `placement`; split them,
      // so the dedupe key matches the durable copy (a bare `last_shown`).
      const { placement, ...target } = payload as ShowTarget & { placement?: ShowPlacement };
      handle(typeId.id, target, placement ?? NO_PLACEMENT, true);
    };
    dataManager.on('on_entity_event', onEntityEvent);
    return () => {
      dataManager.off('on_entity_event', onEntityEvent);
    };
  }, [handle]);

  // Durable channel — `on_show` persists `context_data.last_shown` BEFORE it
  // emits the transient event, so any process update carries the newest target
  // and covers a client that attached while a show was in flight.
  //
  // The timestamp gate is what stops it from resurrecting the dead: a tab is
  // durable, so a show that predates this client is ALREADY represented (its
  // tab exists, or the user closed it on purpose) and re-minting it would undo
  // that close on every reload. Only a show stamped after we mounted is news.
  //
  // Compared per event, deliberately NOT via a "first observation establishes a
  // baseline" flag: this listener serves EVERY process, so a single flag gets
  // consumed by whichever unrelated process updates first and then waves every
  // stale target through. (The per-process vibe surfaces can use that shape
  // because each instance watches exactly one process; this one cannot.)
  const onProcessOp = useCallback(
    (typeId: TypeId, op: 'create' | 'update' | 'delete', data: IEntity | undefined): void => {
      // A `delete` frame has no payload at all, so there is nothing to read and
      // nothing a deletion could ever be showing. Returning early here is not
      // defensive noise: dereferencing the absent payload threw a TypeError that
      // aborted the bus's `forEach`, so the delete never reached the entity cache,
      // the tab manager, or any other listener registered after this one.
      if (op === 'delete' || !data) return;
      const context = (
        data as IEntity & {
          context_data?: {
            last_shown?: ShowTarget;
            show_placement?: ShowPlacement;
            display_stack?: Array<{ shown_at?: string }>;
          };
        }
      ).context_data;
      const shown = context?.last_shown;
      if (!shown) return;
      if (!isFreshShow(context?.display_stack, mountedAtRef.current)) return;
      handle(typeId.id, shown, context?.show_placement ?? NO_PLACEMENT);
    },
    [handle],
  );
  useEntityOps(PROCESS_TYPES, onProcessOp);
}
