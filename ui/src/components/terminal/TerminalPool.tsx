import { tabKey, tabManager } from '@sdk';
import { useTerminalTabs } from '@src/tabs/use-tab-manager';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { terminalPool, type TerminalPoolSnapshot } from './terminal-pool';
import { TerminalPanel } from './TerminalPanel';

/**
 * Owns every terminal runtime for the life of its TAB (docs/navigation/dock-loading.md,
 * I6). Mounted once, above every layout (RootLayout), so no layout swap can unmount
 * a panel. Each panel renders through a portal into the pool's container for its
 * key; `TabbedTerminal` slots adopt the container they show. Containers no slot
 * shows sit in the parking element below — hidden, still in the document.
 */
export function TerminalPool() {
  const snapshot = useSyncExternalStore(terminalPool.subscribe, terminalPool.getSnapshot, terminalPool.getSnapshot);
  const parkingRef = useCallback((el: HTMLDivElement | null) => terminalPool.setParking(el), []);
  return (
    <>
      <div
        ref={parkingRef}
        data-testid="terminal-pool-parking"
        aria-hidden
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
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
          return createPortal(
            <TerminalPanel tab={tab} isActive={snapshot.shown.has(key)} />,
            terminalPool.container(key),
            key,
          );
        })}
    </>
  );
}
