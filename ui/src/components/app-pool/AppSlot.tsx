import { appPool } from '@src/components/terminal/terminal-pool';
import type { AppDisplayViewerProps } from '@src/pages/flow-page/app-display-viewer';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Where a pooled app view is SHOWN — the body of an `/dock/app/…` dock. The view itself
 * (`AppDisplayViewer`, its frame, its state) is rendered once by `<AppPool/>` and lives as long as
 * its tab (docs/navigation/dock-loading.md, I6); this slot only lends it a place on screen. A tab
 * switch, a layout swap or a Vibe turn end (a new `reloadKey`) never remounts the view: the epoch
 * reaches it as a prop and its `reloadOnNewEpoch` effect reloads the frame once.
 */
export function AppSlot({
  viewKey,
  tabHash,
  viewer,
}: {
  viewKey: string;
  tabHash: string;
  viewer: AppDisplayViewerProps;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [slot] = useState(() => Symbol('app-slot'));
  // By value: the caller builds a fresh address object every render, and a new props object
  // per render would re-publish the pool (and re-render the view) for nothing.
  const optionsKey = JSON.stringify(viewer.options ?? {});
  const props = useMemo(
    () => ({ viewer, tabHash }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `viewer` compared field by field
    [
      tabHash,
      viewer.artifactId,
      viewer.microAppId,
      viewer.endpointId,
      viewer.route,
      viewer.runtime,
      viewer.reloadKey,
      optionsKey,
    ],
  );

  // Layout effect: the container is in place before the browser paints (the frame is positioned
  // over this host by measuring it).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    appPool.show(slot, viewKey, host, props);
    return () => appPool.hide(slot);
  }, [slot, viewKey, props]);

  return <div ref={hostRef} className="relative h-full w-full" data-testid="app-slot" />;
}
