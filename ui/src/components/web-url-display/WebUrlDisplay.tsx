import PersistentIframe, { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { Button } from '@src/components/ui/button';
import { openExternal } from '@src/lib/open-external';
import { Trans } from '@lingui/react/macro';
import { ExternalLink, Globe, ShieldAlert } from 'lucide-react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { classifyWebpageStatus } from './classify';
import { useWebpageStatus } from './useWebpageStatus';

export interface WebUrlDisplayProps {
  url: string;
  testId?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * An external page in the display, with a warning when it cannot be shown.
 *
 * The frame is always mounted, and the warning sits OVER it rather than
 * replacing it: the check is a best guess from the backend, and if it is wrong
 * the page is still there underneath. When it is right, the user sees why the
 * pane is empty and gets one button that works -- open the page in their real
 * browser.
 */
export const WebUrlDisplay = forwardRef<PersistentIframeHandle, WebUrlDisplayProps>(function WebUrlDisplay(
  { url, testId },
  ref,
) {
  const frameRef = useRef<PersistentIframeHandle>(null);
  const { status, recheck } = useWebpageStatus(url);
  const issue = classifyWebpageStatus(status);
  const host = hostOf(url);

  const refresh = useCallback(() => {
    recheck();
    frameRef.current?.refresh();
  }, [recheck]);

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      postToGuest: (message: unknown) => frameRef.current?.postToGuest(message),
    }),
    [refresh],
  );

  const copy =
    issue === 'frame_blocked'
      ? {
          Icon: ShieldAlert,
          headline: <Trans>{host} can't be shown inside Flowpad.</Trans>,
          body: <Trans>The site doesn't allow being embedded in other apps. Open it in your browser instead.</Trans>,
          detail: status?.frame_block_reason,
          retry: false,
        }
      : {
          Icon: Globe,
          headline: <Trans>Couldn't reach {host}.</Trans>,
          body: <Trans>Check the address, or try opening it in your browser.</Trans>,
          detail: status?.nav_error,
          retry: true,
        };

  return (
    <div className="relative h-full w-full" data-testid="web-url-display">
      <PersistentIframe ref={frameRef} src={url} testId={testId} />
      {issue && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
          data-testid="web-url-warning"
          data-issue={issue}
        >
          <div
            role="alertdialog"
            aria-labelledby="web-url-warning-headline"
            className="flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border bg-popover p-5 text-center shadow-lg"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <copy.Icon className="h-5 w-5 text-muted-foreground" />
            </div>
            <p id="web-url-warning-headline" className="text-sm font-medium text-popover-foreground">
              {copy.headline}
            </p>
            <p className="text-xs text-muted-foreground">{copy.body}</p>
            {copy.detail && (
              <code className="max-w-full truncate text-[11px] text-muted-foreground" title={copy.detail}>
                {copy.detail}
              </code>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={() => openExternal(url)} data-testid="web-url-open-in-browser">
                <ExternalLink className="me-1.5 h-3.5 w-3.5" />
                <Trans>Open in browser</Trans>
              </Button>
              {copy.retry && (
                <Button size="sm" variant="ghost" onClick={refresh} data-testid="web-url-retry">
                  <Trans>Try again</Trans>
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
