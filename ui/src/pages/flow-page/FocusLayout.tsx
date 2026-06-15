/**
 * FocusLayout — the chrome-less host for the `win/` focus-window layout
 * (docs/tab-management.md Part 3 §7). Every dock/<viewType>/<pointer> has a
 * mirror win/<viewType>/<pointer> that renders here: same loaders, same view
 * component, but the tab content is the entire window — no sidebars, no
 * footer, no unified tab strip, no app chrome.
 *
 * Panel rendering is reused from ContentPanel, which derives its chrome-less
 * mode from the URL (`windowMode`) itself — this file deliberately
 * duplicates nothing.
 *
 * On mount (i.e. after the route loader completed) it announces readiness on
 * the popout-handoff channel (§8) so the origin window can detach. Deep-linked
 * win/ windows have no listener — the announce is a no-op by construction.
 *
 * No teardown handlers (§7, non-negotiable): window close relies on
 * disconnect-driven PTY detach. Never add a beforeunload shell-kill here —
 * it would tear down a shell the main window still shows.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { announceWinReady } from '@src/tabs/popout-handoff';
import { ViewType } from '@src/types/ViewType';
import { useEffect, useMemo } from 'react';
import { ContentPanel } from './content-panel/content-panel';

/**
 * Canonical handoff key for the routed dock pointer. For terminal views this
 * is the strip's `terminalTargetKey` shape (`agentic_process-<id>` /
 * `shell-<id>`) — the same key the origin's popout path waits on. Other view
 * types key on `<viewType>/<pointer>`; today nothing waits on those, so a
 * deep-linked announce is a no-op either way.
 */
export function winReadyKeyForDock(
  dock: { viewType?: string; pointer?: string } | null,
): string | null {
  if (!dock?.viewType) return null;
  const { viewType, pointer } = dock;
  if (viewType === ViewType.SHELL && pointer) {
    return DockPointer.terminalTargetTypeIdForShellPointer(pointer).toString();
  }
  return pointer ? `${viewType}/${pointer}` : viewType;
}

export default function FocusLayout() {
  const { currentDock } = useDockNavigation();

  const readyKey = useMemo(
    () => winReadyKeyForDock(currentDock ? { viewType: currentDock.viewType, pointer: currentDock.pointer } : null),
    [currentDock?.viewType, currentDock?.pointer],
  );

  // Announce after mount — the router only mounts this element once the
  // route loader has resolved, so "mounted" ⇒ "loader completed" (§8).
  useEffect(() => {
    if (readyKey) announceWinReady(readyKey);
  }, [readyKey]);

  return (
    <div data-testid="focus-layout" className="h-full w-full overflow-hidden bg-background">
      <ContentPanel />
    </div>
  );
}
