import { Tab } from '@sdk';
import { useMemo } from 'react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useAllTabs } from '@src/tabs/all-tabs-store';
import { ViewType } from '@src/types/ViewType';

/**
 * Resolved vibe-workspace session for the current URL.
 *
 * The vibe workspace is a HOST layout — a side chat bound to a process plus a
 * display area — that stays mounted across two kinds of URL:
 *   - the DISPLAY url: the process's own `/dock/display/agentic_process-<id>` dock
 *     (`onDisplayUrl: true`), where the display shows the agent's `flow show` pin;
 *   - a CHILD url: any tab whose `parent_tab_id` is the display tab (opened from
 *     inside the workspace), where the display shows that child's content.
 *
 * Returning the resolved shape from ONE hook keeps the "is this a workspace
 * surface" decision out of `flow-page` inline checks — any future
 * workspace-with-children surface reuses it.
 */
export interface VibeWorkspaceSession {
  /** The display tab (the process tab). May be null briefly on the display URL
   *  before the tab row lands in the store — not needed to render, only to
   *  parent new children and drive the strip. */
  displayTab: Tab | null;
  /** The display's dock pointer — the "Display" chip target + strip home. */
  displayDock: DockPointer;
  /** The agentic_process id the side chat binds to. */
  processId: string;
  /** True on the process dock URL itself; false on a child tab's URL. */
  onDisplayUrl: boolean;
}

export function useVibeWorkspaceSession(): VibeWorkspaceSession | null {
  const { currentDock } = useDockNavigation();
  const allTabs = useAllTabs();

  return useMemo(() => {
    if (!currentDock) return null;
    const tabByHash = (hash: string | null | undefined) =>
      hash ? (allTabs.find((t) => t.dockPointer?.tabHash === hash) ?? null) : null;

    // One session shape from "a process dock + its tab" — null if the dock isn't
    // a process dock. Both entry cases build through here so the 4 fields never
    // drift apart.
    const build = (
      displayTab: Tab | null,
      displayDock: DockPointer,
      onDisplayUrl: boolean,
    ): VibeWorkspaceSession | null =>
      DockPointer.isAgenticProcessPointer(displayDock.pointer)
        ? {
            displayTab,
            displayDock,
            processId: DockPointer.extractAgenticProcessId(displayDock.pointer!),
            onDisplayUrl,
          }
        : null;

    // FIXME(display-refactor handoff, RCA 2026-07-09): legacy /dock/shell/agentic_process-<id>
    // URLs no longer resolve a session since Case 1 narrowed SHELL→DISPLAY — vibe renders
    // VibeNewChat (home) and asset clicks can't parent into display child tabs. Accept SHELL
    // as an alias here or bridge shell→display in the route loader before landing.
    // Case 1 — the display URL itself: DISPLAY + agentic_process pointer.
    if (currentDock.viewType === ViewType.DISPLAY) {
      return build(tabByHash(currentDock.tabHash), currentDock, true);
    }

    // Case 2 — a child URL: the current tab's parent is a live process dock.
    const currentTab = tabByHash(currentDock.tabHash);
    const parent = currentTab?.parent_tab_id
      ? allTabs.find((t) => t.id === currentTab.parent_tab_id && t.visible !== false)
      : undefined;
    if (parent?.dockPointer) return build(parent, new DockPointer(parent.dockPointer), false);

    return null;
  }, [currentDock, allTabs]);
}
