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
    const tabByHash = (hash: string | null | undefined) =>
      hash ? (allTabs.find((t) => t.dockPointer?.tabHash === hash) ?? null) : null;

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
    if (currentDock.viewType === ViewType.SHELL) {
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
