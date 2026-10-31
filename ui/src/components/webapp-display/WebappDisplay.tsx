import type { PageError, ServedApp } from '@sdk';
import PersistentIframe, { type PersistentIframeHandle } from '@src/components/persistent-iframe';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AppLifecyclePanel } from './AppLifecyclePanel';
import type { AppLifecycle } from './useAppLifecycle';

/** The message the page-error reporter posts to its parent (`flow_sdk/server/reporter_relay.py`). */
export const PAGE_REPORT = 'flowpad:page-report';
/** Asks the frame's reporter to send its report again (a frame cached from an earlier mount). */
export const PAGE_REPORT_REQUEST = 'flowpad:page-report-request';

export interface WebappDisplayProps {
  /** The endpoint serving what the frame shows — the page's reports are forwarded to it. */
  endpoint: ServedApp | null;
  /** The URL the frame loads: the endpoint's direct address or its service path. */
  src: string;
  testId?: string;
  /** Bumped by the caller to force a reload (re-show, agent turn end). */
  cacheKey?: number;
  /** The app's lifecycle record, when the app is a webapp asset. Absent (a bare port, files served as they
   *  are): nothing to wait for, the frame shows at once. */
  lifecycle?: AppLifecycle | null;
}

/**
 * The one way to put a web app on screen: the frame is shown iff the app's record is showable (`up` or
 * `degraded`); otherwise `AppLifecyclePanel` says what the backend is doing about it. The backend decides and
 * recovers — this only forwards what the page reports (every post, settled or not, with its `load_id`
 * verbatim) and says what the record says.
 */
export const WebappDisplay = forwardRef<PersistentIframeHandle, WebappDisplayProps>(function WebappDisplay(
  { endpoint, src, testId, cacheKey = 0, lifecycle = null },
  ref,
) {
  const frameRef = useRef<PersistentIframeHandle>(null);
  const showFrame = !lifecycle || lifecycle.showable;
  const degraded = lifecycle?.record?.state === 'degraded';

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => frameRef.current?.refresh(),
      postToGuest: (message: unknown) => frameRef.current?.postToGuest(message),
      isGuest: (source: MessageEventSource | null) => frameRef.current?.isGuest(source) ?? false,
    }),
    [],
  );

  // A frame hidden while the app was not showable parked whatever it last showed (the broken page): coming
  // back to showable loads the app again.
  const [returns, setReturns] = useState(0);
  const wasHidden = useRef(!showFrame);
  useEffect(() => {
    if (!showFrame) wasHidden.current = true;
    else if (wasHidden.current) {
      wasHidden.current = false;
      setReturns((n) => n + 1);
    }
  }, [showFrame]);

  // The reporter's posts, forwarded as they come — only from this display's own frame.
  const reportPage = lifecycle?.reportPage;
  const forward = useCallback(
    (event: MessageEvent) => {
      const data = event.data as { type?: string; errors?: PageError[]; settled?: boolean; load_id?: string } | null;
      if (!data || data.type !== PAGE_REPORT || !endpoint || !reportPage) return;
      if (!frameRef.current?.isGuest(event.source)) return;
      void reportPage(endpoint, data.errors ?? [], !!data.settled, data.load_id ?? '');
    },
    [endpoint, reportPage],
  );
  useEffect(() => {
    if (!showFrame || !reportPage) return;
    window.addEventListener('message', forward);
    // A frame this mount did not load reports only when asked.
    frameRef.current?.postToGuest({ type: PAGE_REPORT_REQUEST });
    return () => window.removeEventListener('message', forward);
  }, [showFrame, forward, reportPage]);

  if (!showFrame && lifecycle) return <AppLifecyclePanel lifecycle={lifecycle} />;

  return (
    <div className="flex h-full w-full flex-col" data-testid="webapp-display">
      {degraded && lifecycle ? <AppLifecyclePanel lifecycle={lifecycle} /> : null}
      <div className="relative min-h-0 flex-1">
        <PersistentIframe ref={frameRef} src={src} testId={testId} cacheKey={cacheKey + returns} />
      </div>
    </div>
  );
});
