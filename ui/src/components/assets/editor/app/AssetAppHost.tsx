/**
 * Hosts an asset's editor APP — an SDK-based static page the asset ships
 * (`<asset>/editors/<name>/index.html`) or the type provides as a builtin.
 *
 * This is the MicroApp display path reused from the asset-editor dock: the
 * backend serves the page at `entity.editorAppUrl(app)` (same origin, API
 * origin injected, `<base>` set), and `PersistentIframe` hosts it with the
 * powers a `flow app serve` app has. The app resolves its host entity from its
 * own URL and talks to the backend through the SDK — this host passes nothing
 * but the dock's other options as the app's query string.
 *
 * Guest → host: the page may `postMessage({ kind: 'open-link', url })` — the
 * same intent `AppHost` serves MCP apps through `onOpenLink`, handled by the
 * same `openGuestLink`; a plain page has no MCP bridge, so it posts.
 */
import type { APIEntity } from '@sdk';
import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import PersistentIframe from '@src/components/persistent-iframe';
import { openGuestLink } from '@src/components/app-host/dock-url-helpers';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

interface Props {
  entity: APIEntity<APIEntity<any>>;
}

const HOST_OPTION = 'app';

export function AssetAppHost({ entity }: Props) {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();

  const { [HOST_OPTION]: app = '', ...appOptions } = currentDock?.options ?? {};
  const src = app ? entity.editorAppUrl(app, appOptions) : '';

  useEffect(() => {
    if (!src) return;
    const origin = new URL(src).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const msg = event.data as { kind?: string; url?: string } | null;
      if (msg?.kind !== 'open-link' || typeof msg.url !== 'string') return;
      openGuestLink(msg.url, navigation);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, navigation]);

  const problem = !app ? t`No editor app named on this dock.` : !entity.hasEditor(app) ? t`This asset has no editor "${app}".` : null;
  if (problem) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{problem}</div>;
  }

  // The asset's updated_date changes on every re-index of its folder, so an
  // edited app is refreshed without keying the frame on the URL twice.
  const cacheKey = Date.parse(String(entity.updated_date ?? '')) || 0;
  return <PersistentIframe src={src} cacheKey={cacheKey} testId={`asset-app-${app}`} />;
}
