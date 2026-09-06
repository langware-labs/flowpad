import type { ShowTarget } from '@sdk';
import { AgenticProcess, dataManager, tabForDockKey, tabManager, TypeId, type IEntity } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { useIsVibe } from '@src/components/view-mode';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockForDisplayTarget } from '@src/navigation/display-target-pointer';
import { highlightTab } from '@src/tabs/tab-highlight';

import { useCallback, useEffect, useRef } from 'react';

/**
 * `flow show` outside vibe — mint the target as a tab beside the calling process.
 *
 * The verb is one mode-agnostic address; the PRESENTATION adapts. Vibe pins the
 * target in its Display pane (`vibe-workspace` / `asset-vibe-workspace`, both
 * gated on `isVibe`). Every other mode has no display pane, so the target
 * becomes what it would have been if the user had opened it: a top-level tab,
 * placed immediately after the process that showed it.
 *
 * **It never navigates.** A show is the agent saying "this is ready", not "drop
 * what you are doing" — and unlike vibe's pane repaint, navigating here would
 * yank a user who is mid-task in another tab. The intent is carried instead by
 * a brief glow on the destination tab and `ShownTargetBadge` on the process's
 * own chip. Three problems
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

export function useShowTargetListener(): void {
  const isVibe = useIsVibe();
  // The first live event confirms the durable update. Later live events are
  // new shows, even when their target is identical, and must replay the cue.
  const handledRef = useRef(new Map<string, { key: string; sawLive: boolean }>());
  // Persisted shows older than this are history, not commands (see below).
  const mountedAtRef = useRef(Date.now());

  const showTarget = useCallback(async (processId: string, target: ShowTarget): Promise<void> => {
    const dock = dockForDisplayTarget(target);
    if (!dock) {
      // A real answer, not a failure: an entity type with no editor and no
      // path, or an `app` with no dev server, addresses nothing openable. The
      // target still lives in the process's display history.
      console.debug('[flow show] target has no dock in this mode', target);
      return;
    }

    const tabs = await tabManager.listAll();
    // The anchor is the process's OWN tab. The frontend has no deterministic
    // tab-id helper (`tab_id_for` is uuid5, backend-only; the FE reconciles by
    // the `pointer` natural key), so match on the pointer hash. One canonical
    // process URL family serves every view mode, so this is the same row in
    // Standard, Advanced and Vibe.
    const processHash = DockPointer.forShell(`${AgenticProcess.type}-${processId}`).tabHash;
    const anchor = tabForDockKey(tabs, processHash);

    // Rebase onto the process's project — load-bearing, not cosmetic.
    //
    // A bare ASSETS dock is SCOPE-keyed: `tabHash` folds every sub-pointer of a
    // scope into ONE tab (`DockPointer.ts`, the `scopeKeyed` branch), so showing
    // a document would hijack that scope's existing Assets tab and rename it
    // rather than open its own. The project-rebased form (`/dock/project/<id>/
    // editor/…`) is NOT scope-keyed, so each document keeps its own identity —
    // the same shape a task/doc opened from a conversation chip gets
    // (`EntityChip`, `AssetReviewDialog`, `ConversationContextPanel` all rebase
    // at the call site exactly like this). The project id rides denormalized on
    // the anchor row, so this costs no extra fetch, and the helper passes
    // non-ASSETS pointers through untouched.
    const placed = DockPointer.rebaseAssetsOntoProject(dock, anchor?.project_id ?? null);

    // `tabManager.ensureDock`, not raw `newTab`: because nothing navigates, no
    // route loader will ever fill in the chip's denormalized display fields.
    // This is what resolves the target, icon, name and project scope, so the
    // chip lands complete instead of as an unlabelled stub.
    //
    // Deliberately NOT `setupTab`/`setupTabAndAdopt` — those stamp
    // `tabManager.activate`, which would mark a tab the user never opened as the
    // most-recently-active one and poison both scope-entry and the default
    // placement anchor for the next tab.
    //
    // `parentTabId` only in vibe, and only for a SCREEN. Outside vibe a show is
    // a top-level tab (standard mode registers no workspace parent). In vibe a
    // shown screen belongs to the session that opened it, so it joins the
    // workspace's child strip beside the Display — which keeps the agent's
    // pinned deliverable instead of evicting it, and gives the screen full
    // width when its chip is clicked.
    const parentTabId = isVibe && target.kind === 'dock' ? (anchor?.id ?? null) : null;
    await tabManager.ensureDock(placed, { afterTabId: anchor?.id ?? null, parentTabId });
    // `getFromDockPointer` returns the PROJECT-SCOPED list, which must never be
    // adopted globally (it would erase every other project's tabs). Re-read the
    // unscoped list for adoption, exactly as `materializeTab` does.
    tabManager.adoptGlobal(await tabManager.listAll());
    if (placed.tabHash) highlightTab(placed.tabHash);
  }, [isVibe]);

  const handle = useCallback(
    (processId: string, target: ShowTarget | null | undefined, live = false): void => {
      if (!target || !processId) return;
      // The mode gate lives HERE, not on the subscriptions, because it depends
      // on the target's KIND. Vibe pins a deliverable (file / entity / webapp)
      // in its Display pane, so this listener leaves those alone — but a SCREEN
      // has no place in that pane, so vibe mints it as a workspace child.
      // Every other mode has no pane at all and mints every kind.
      if (isVibe && target.kind !== 'dock') return;
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
      void showTarget(processId, target);
    },
    [showTarget, isVibe],
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
      handle(typeId.id, payload as ShowTarget, true);
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
          context_data?: { last_shown?: ShowTarget; display_stack?: Array<{ shown_at?: string }> };
        }
      ).context_data;
      const shown = context?.last_shown;
      if (!shown) return;
      if (!isFreshShow(context?.display_stack, mountedAtRef.current)) return;
      handle(typeId.id, shown);
    },
    [handle],
  );
  useEntityOps(PROCESS_TYPES, onProcessOp);
}
