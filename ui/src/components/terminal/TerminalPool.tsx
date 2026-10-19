import { AgenticProcess, isProcessEnded, tabKey, tabManager, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTerminalTabs } from '@src/tabs/use-tab-manager';
import { Fragment, memo, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { terminalPool, type TerminalPoolSnapshot } from './terminal-pool';
import { TerminalPanel } from './TerminalPanel';

/**
 * Owns every terminal runtime for the life of its TAB (docs/navigation/dock-loading.md,
 * I6) — except an ENDED agent's, which is given back once its tab is not the one shown
 * (`ReleaseWhenEnded`). Mounted once, above every layout (RootLayout), so no layout swap
 * can unmount a panel. Each panel renders through a portal into the pool's container for its
 * key; all containers share one stack, which sits in whichever `TabbedTerminal`
 * slot showed last — or, with none on screen, in the parking element below.
 *
 * The parking is the viewport's size, not 0×0: a panel parked at zero width is
 * re-laid-out a character per line, which for a long chat took seconds each time
 * the user left its tab (FLOWPAD-2193). `inert` keeps anything parked out of the
 * focus order and away from clicks.
 */
export function TerminalPool() {
  const snapshot = useSyncExternalStore(terminalPool.subscribe, terminalPool.getSnapshot, terminalPool.getSnapshot);
  const parkingRef = useCallback((el: HTMLDivElement | null) => {
    // React 18 has no `inert` prop; the attribute is what the browser reads.
    el?.setAttribute('inert', '');
    terminalPool.setParking(el);
  }, []);
  return (
    <>
      <div
        ref={parkingRef}
        data-testid="terminal-pool-parking"
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'hidden',
          visibility: 'hidden',
          pointerEvents: 'none',
        }}
      />
      {/* Nothing is subscribed to the tab store until a slot has shown a terminal:
          pages that never show one (hub, discover, landings) start nothing. */}
      {snapshot.mounted.size > 0 && <PooledPanels snapshot={snapshot} />}
    </>
  );
}

function PooledPanels({ snapshot }: { snapshot: TerminalPoolSnapshot }) {
  const tabs = useTerminalTabs('all');
  // The tab the URL shows, read in the SAME render the URL changed. `snapshot.shown` only
  // follows one commit later (a slot publishes from a layout effect), and in that commit the
  // tab being LEFT still looked active while the view mode had already moved to the new
  // tab's: the panel just left ran its mode reconcile against the new surface and remounted
  // its chat pane (a 400-row chat: 3.6 s to draw again on the way back). A panel is active
  // only while both agree.
  const { currentDock } = useDockNavigation();
  const urlKey = currentDock?.tabHash ?? '';
  const liveKeys = useMemo(() => new Set(tabs.map(tabKey)), [tabs]);

  // A closed tab's runtime goes with it. Only once the store is loaded: an empty
  // list before hydration is not "every tab closed".
  useEffect(() => {
    if (tabManager.isHydrated()) terminalPool.retain(liveKeys);
  }, [liveKeys]);

  return (
    <>
      {tabs
        .filter((tab) => snapshot.mounted.has(tabKey(tab)))
        .map((tab) => {
          const key = tabKey(tab);
          return (
            <Fragment key={key}>
              {tab.target_type === AgenticProcess.type && !!tab.target_id && (
                <ReleaseWhenEnded
                  tabHash={key}
                  processId={tab.target_id}
                  shown={snapshot.shown.has(key) || key === urlKey}
                />
              )}
              {createPortal(
                <TerminalPanel tab={tab} isActive={snapshot.shown.has(key) && key === urlKey} />,
                terminalPool.container(key),
              )}
            </Fragment>
          );
        })}
    </>
  );
}

/**
 * The narrowing of I6: an agent whose process has ENDED (stopped / failed) has no PTY left to
 * follow, so its pooled terminal — xterm, sync session, the panel's whole tree — is given back
 * as soon as its tab is not the one shown: the process ends behind another tab, or the user
 * leaves a tab whose process already ended. The tab, its URL and its chip stay; the next visit
 * mounts the panel cold, which starts the agent again and replays its recording, exactly as a
 * reopened tab does.
 *
 * Never given back: the panel a slot shows or the URL names, a running (or not yet started)
 * process, a plain shell (no process), and a headless chat — it holds no terminal, and
 * remounting a long chat is the seconds-long redraw the pool exists to avoid.
 *
 * Lives beside the panel, not inside it: the decision must not depend on the tree it unmounts.
 */
const ReleaseWhenEnded = memo(function ReleaseWhenEnded({
  tabHash,
  processId,
  shown,
}: {
  tabHash: string;
  processId: string;
  shown: boolean;
}) {
  const { data: process } = useEntity<AgenticProcess>(new TypeId(AgenticProcess.type, processId));
  const ended = !!process?.status && isProcessEnded(process.status) && !process.isHeadless;
  useEffect(() => {
    if (ended && !shown) terminalPool.release(tabHash);
  }, [ended, shown, tabHash]);
  return null;
});
