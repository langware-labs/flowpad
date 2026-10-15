import PersistentIframe, { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { Button } from '@src/components/ui/button';
import { openExternal } from '@src/lib/open-external';
import { Trans } from '@lingui/react/macro';
import { ExternalLink, Globe } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { classifyWebpageStatus } from './classify';
import { useReshowRefresh } from './useReshowRefresh';
import { useWebpageStatus } from './useWebpageStatus';

export interface WebUrlDisplayProps {
  url: string;
  testId?: string;
  /** Called after the page was handed to the real browser -- the pane is stale from then on. */
  onOpenedInBrowser?: () => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * An external page in the display: a refused frame goes to the browser, an
 * unreachable one gets a warning over the frame.
 *
 * A site that refuses to be framed can never show here, so it is handed to the
 * real browser as soon as the check says so, with no card to click through; the
 * host then closes the now-stale tab. An unreachable page keeps its warning
 * OVER the frame rather than replacing it: that check is a best guess from the
 * backend, and if it is wrong the page is still there underneath.
 */
export const WebUrlDisplay = forwardRef<PersistentIframeHandle, WebUrlDisplayProps>(function WebUrlDisplay(
  { url, testId, onOpenedInBrowser },
  ref,
) {
  const frameRef = useRef<PersistentIframeHandle>(null);
  const { status, recheck } = useWebpageStatus(url);
  const issue = classifyWebpageStatus(status);
  const host = hostOf(url);

  const openInBrowser = useCallback(() => {
    openExternal(url);
    onOpenedInBrowser?.();
  }, [url, onOpenedInBrowser]);

  // A refused frame goes straight to the browser: nothing here will ever show it.
  const handedOff = useRef(false);
  useEffect(() => {
    if (issue !== 'frame_blocked' || handedOff.current) return;
    handedOff.current = true;
    openInBrowser();
  }, [issue, openInBrowser]);

  const refresh = useCallback(() => {
    recheck();
    frameRef.current?.refresh();
  }, [recheck]);
  // A repair that brought the server back shows this page again: look again.
  useReshowRefresh(url, refresh);

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      postToGuest: (message: unknown) => frameRef.current?.postToGuest(message),
      isGuest: (source: MessageEventSource | null) => frameRef.current?.isGuest(source) ?? false,
    }),
    [refresh],
  );

  return (
    <div className="relative h-full w-full" data-testid="web-url-display">
      {issue !== 'frame_blocked' && <PersistentIframe ref={frameRef} src={url} testId={testId} />}
      {issue === 'unreachable' && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
          data-testid="web-url-warning"
        >
          <div
            role="alertdialog"
            aria-labelledby="web-url-warning-headline"
            className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border bg-popover p-5 text-center shadow-lg"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <Globe className="h-5 w-5 text-muted-foreground" />
            </div>
            <p id="web-url-warning-headline" className="text-sm font-medium text-popover-foreground">
              <Trans>Couldn't reach {host}.</Trans>
            </p>
            <p className="text-xs text-muted-foreground">
              <Trans>Check the address, or try opening it in your browser.</Trans>
            </p>
            {status?.nav_error && (
              <code className="max-w-full truncate text-[11px] text-muted-foreground" title={status.nav_error}>
                {status.nav_error}
              </code>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={openInBrowser} data-testid="web-url-open-in-browser">
                <ExternalLink className="me-1.5 h-3.5 w-3.5" />
                <Trans>Open in browser</Trans>
              </Button>
              <Button size="sm" variant="ghost" onClick={refresh} data-testid="web-url-retry">
                <Trans>Try again</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
