import { tabManager } from '@sdk';
import { appPool, type RuntimePoolSnapshot, type PooledAppProps } from '@src/components/terminal/terminal-pool';
import { releaseFrame } from '@src/components/persistent-iframe';
import { AppDisplayViewer } from '@src/pages/flow-page/app-display-viewer';
import { useOpenTabHashes } from '@src/tabs/use-tab-manager';
import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/**
 * Owns every app view for the life of its TAB (docs/navigation/dock-loading.md, I6) — the app
 * counterpart of `TerminalPool`, mounted beside it above every layout. Each view renders through
 * a portal into the pool's container for its key (`appViewKey`); `AppSlot` lends it a place on
 * screen. When the tab that showed a view closes, the view goes, and so does its frame.
 */
export function AppPool() {
  const snapshot = useSyncExternalStore(appPool.subscribe, appPool.getSnapshot, appPool.getSnapshot);
  const parkingRef = useCallback((el: HTMLDivElement | null) => {
    el?.setAttribute('inert', '');
    appPool.setParking(el);
  }, []);
  return (
    <>
      <div
        ref={parkingRef}
        data-testid="app-pool-parking"
        aria-hidden
        style={{ position: 'fixed', inset: 0, overflow: 'hidden', display: 'none', pointerEvents: 'none' }}
      />
      {snapshot.mounted.size > 0 && <PooledApps snapshot={snapshot} />}
    </>
  );
}

function PooledApps({ snapshot }: { snapshot: RuntimePoolSnapshot<PooledAppProps> }) {
  const openTabs = useOpenTabHashes();
  // The frame each view last showed, so a dropped view frees it.
  const frames = useRef(new Map<string, Set<string>>());

  // A closed tab's views go with it. Only once the store is loaded: an empty list before
  // hydration is not "every tab closed".
  useEffect(() => {
    if (!tabManager.isHydrated()) return;
    const live = new Set([...snapshot.props].filter(([, p]) => openTabs.has(p.tabHash)).map(([key]) => key));
    appPool.retain(live);
  }, [openTabs, snapshot.props]);

  // Free the frames of every view that left the pool.
  useEffect(() => {
    for (const [key, srcs] of frames.current) {
      if (snapshot.mounted.has(key)) continue;
      for (const src of srcs) releaseFrame(src);
      frames.current.delete(key);
    }
  }, [snapshot.mounted]);

  return (
    <>
      {[...snapshot.mounted].map((key) => {
        const props = snapshot.props.get(key);
        if (!props) return null;
        return createPortal(
          <PooledApp key={key} viewKey={key} props={props} active={snapshot.shown.has(key)} frames={frames.current} />,
          appPool.container(key),
          key,
        );
      })}
    </>
  );
}

const PooledApp = memo(function PooledApp({
  viewKey,
  props,
  active,
  frames,
}: {
  viewKey: string;
  props: PooledAppProps;
  active: boolean;
  frames: Map<string, Set<string>>;
}) {
  const onFrameSrc = useCallback(
    (src: string) => {
      const srcs = frames.get(viewKey) ?? new Set<string>();
      srcs.add(src);
      frames.set(viewKey, srcs);
    },
    [frames, viewKey],
  );
  return <AppDisplayViewer {...props.viewer} active={active} onFrameSrc={onFrameSrc} />;
});
