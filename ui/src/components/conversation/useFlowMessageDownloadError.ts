import { cloudManager, HubClientErrorInfo } from '@sdk';
import { useCallback, useEffect, useState } from 'react';
import { createKeyedDispatch } from './keyed-event-dispatch';

// Pull the FlowMessage id out of a hub path like
// `/flow_message/<id>/download_body` or `/flow_message/<id>/fs/download/...`.
const FLOW_MESSAGE_PATH_RE = /\/flow_message\/([^/]+)\//;

// One shared `hub_client_error` listener on the cloudManager singleton, routed
// by the FlowMessage id parsed from the error's path. Only download-class
// errors carry a key; everything else is dropped at the dispatcher.
const hubErrorByMessageId = createKeyedDispatch<[Record<string, unknown>]>(
  (handler) => {
    cloudManager.on('hub_client_error', handler);
    return () => cloudManager.off('hub_client_error', handler);
  },
  (msg) => {
    const path = String(msg?.path ?? '');
    const id = FLOW_MESSAGE_PATH_RE.exec(path)?.[1];
    if (!id) return null;
    const tag = `/flow_message/${id}/`;
    const isDownload =
      path.includes(`${tag}fs/download/`)
      || path.includes(`${tag}download_body`)
      || path.includes(`${tag}create-and-download-local-flowmsg`);
    return isDownload ? id : null;
  },
);

/**
 * Per-message download error signal. Subscribes to the SDK-wide
 * `hub_client_error` stream and keeps the most recent error whose hub path
 * targets *this* FlowMessage — either the body fetch
 * (`/flow_message/<id>/download_body`) or any FS download under the message
 * (`/flow_message/<id>/fs/download/...`).
 *
 * Why a per-message slot (in addition to the global warnings popover):
 * a 404 on a specific FM's bundle is a property of *that* message, not of the
 * cloud connection. Surfacing it inline lets the user see which bubble is
 * affected without correlating timestamps from the popover.
 *
 * The slot is local React state — clears on dismiss (the bubble exposes a ×
 * affordance) or on page refresh. We deliberately do NOT auto-clear on the
 * next entity UPDATE: an unrelated update (e.g. mark_delivered) shouldn't
 * mask a still-failing download.
 */
export function useFlowMessageDownloadError(messageId: string | null | undefined): {
  error: HubClientErrorInfo | null;
  dismiss: () => void;
} {
  const [error, setError] = useState<HubClientErrorInfo | null>(null);

  useEffect(() => {
    if (!messageId) return;
    // The dispatcher already filtered to download-class errors for this id.
    return hubErrorByMessageId(messageId, (msg) => {
      setError({
        method: String(msg.method ?? ''),
        path: String(msg.path ?? ''),
        statusCode: Number(msg.status_code ?? 0),
        message: String(msg.message ?? ''),
        ts: Date.now(),
      });
    });
  }, [messageId]);

  const dismiss = useCallback(() => setError(null), []);
  return { error, dismiss };
}
