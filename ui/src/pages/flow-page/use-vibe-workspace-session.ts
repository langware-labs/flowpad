import { AgenticProcess, parentOfTab, tabForDockKey, Tab, TypeId } from '@sdk';
import { useEffect, useMemo, useRef } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAllTabs } from '@src/tabs/use-tab-manager';
import { ViewType } from '@src/types/ViewType';
import { useEntity } from '@src/hooks/entity-hooks';
import { setupTabAndAdopt } from '@src/tabs/tab-content-lifecycle';

/**
 * Resolved vibe-workspace session for the current URL.
 *
 * The vibe workspace is a HOST layout — a side chat bound to a process plus a
 * display area — rendered over the process's ONE tab (its shell dock; vibe is a
 * view mode of that tab, not a URL family or a second tab identity). It stays
 * mounted across two kinds of URL:
 *   - the PROCESS url: `/dock/shell/agentic_process-<id>` (`onProcessUrl: true`),
 *     where the display area shows the agent's `flow show` pin;
 *   - a CHILD url: any tab whose `parent_tab_id` is the process tab (opened from
 *     inside the workspace), where the display shows that child's content.
 *
 * Returning the resolved shape from ONE hook keeps the "is this a workspace
 * surface" decision out of `flow-page` inline checks — any future
 * workspace-with-children surface reuses it. Whether the workspace actually
 * RENDERS stays gated on the effective view mode (`flow-page`'s `isVibe`).
 */
export interface VibeWorkspaceSession {
  /** The process's tab (the workspace anchor children parent to). May be null
   *  briefly on the process URL before the row lands in the store — not needed
   *  to render, only to parent new children and drive the strip. */
  processTab: Tab | null;
  /** The process's shell dock — the "Display" chip target + strip home. */
  processDock: DockPointer;
  /** The agentic_process id the side chat binds to. */
  processId: string;
  /** True on the process dock URL itself; false on a child tab's URL. */
  onProcessUrl: boolean;
}

export function useVibeWorkspaceSession(): VibeWorkspaceSession | null {
  const { currentDock } = useDockNavigation();
  const allTabs = useAllTabs();

  return useMemo(() => {
    if (!currentDock) return null;
    const tabByHash = (hash: string | null | undefined) => tabForDockKey(allTabs, hash);

    // One session shape from "a process dock + its tab" — null if the dock isn't
    // a process dock. Both entry cases build through here so the 4 fields never
    // drift apart.
    const build = (
      processTab: Tab | null,
      processDock: DockPointer,
      onProcessUrl: boolean,
    ): VibeWorkspaceSession | null =>
      DockPointer.isAgenticProcessPointer(processDock.pointer)
        ? {
            processTab,
            processDock,
            processId: DockPointer.extractAgenticProcessId(processDock.pointer!),
            onProcessUrl,
          }
        : null;

    // Case 1 — the process URL itself: a SHELL dock with an agentic_process
    // pointer (the single URL family; legacy /dock/display forms redirect here
    // in the main loader's canonicalProcessDockPath).
    //
    // The pointer check is load-bearing: a PLAIN shell dock (a terminal) is
    // also viewType SHELL, but it is workspace CONTENT, not the anchor — it
    // must fall through to the child lookup so a terminal opened inside the
    // workspace keeps rendering in its display pane instead of taking over the
    // whole surface.
    if (currentDock.viewType === ViewType.SHELL && DockPointer.isAgenticProcessPointer(currentDock.pointer)) {
      return build(tabByHash(currentDock.tabHash), currentDock, true);
    }

    // Case 2 — a child URL: the current tab's parent is a live process dock.
    const parent = parentOfTab(allTabs, tabByHash(currentDock.tabHash));
    if (parent?.dockPointer) return build(parent, new DockPointer(parent.dockPointer), false);

    // Case 3 — the URL names the host (`?host=agentic_process-<id>`). Answers
    // when the tab table cannot: the child row is gone (closed — `list_all`
    // lands before the URL moves) or not minted yet (cold open). Without it the
    // surface drops to null for that window and flow-page paints the standard
    // chrome. `build` rejects a non-process host.
    const host = currentDock.hostProcessId;
    if (host) {
      const hostDock = DockPointer.forShell(host);
      return build(tabByHash(hostDock.tabHash), hostDock, false);
    }

    return null;
  }, [currentDock, allTabs]);
}

/**
 * Own the process/session side effects shared by both workspace presentations.
 * The process is resolved by the parent session id, never from the child route's
 * active entity.
 */
export function useVibeWorkspaceSessionHost(
  session: VibeWorkspaceSession | null,
  active = true,
): AgenticProcess | null {
  const processTypeId = useMemo(
    () => (session?.processId ? new TypeId(AgenticProcess.type, session.processId) : null),
    [session?.processId],
  );
  const { data: process } = useEntity<AgenticProcess>(processTypeId, {
    watch: true,
    enabled: !!processTypeId,
  });

  // `processTab` is null in TWO situations that need OPPOSITE answers:
  //   • never had one — a cold open; the row hasn't landed yet. Mint it.
  //   • had one, now gone — ANOTHER WINDOW CLOSED THIS SESSION. Minting here
  //     is what made a closed tab pop back: `setupTabAndAdopt` →
  //     `materializeTab` finds no existing tab, falls through to `ensureDock`
  //     → `new_tab` → `ensure_tab`, which sets `visible=True` again ~400 ms
  //     after the close, so the tab could never be closed while a vibe window
  //     watched it (RCA 2026-09-01).
  // A session that is gone is not damage to repair.
  const hadTab = useRef(false);
  const sessionId = session?.processId ?? null;
  useEffect(() => {
    hadTab.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (!active || !session) return;
    if (session.processTab) {
      hadTab.current = true;
      return;
    }
    if (hadTab.current) return; // closed elsewhere — never rebuild it
    void setupTabAndAdopt(session.processDock);
  }, [active, session, session?.processTab, session?.processDock]);

  return process ?? null;
}
