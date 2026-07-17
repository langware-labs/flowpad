import {
  connectionManager,
  copyToClipboard,
  dataManager,
  OAuthEventType,
  oauthService,
  type OAuthDeviceFlowPayload,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { notify } from '@src/notifications';
import { openExternal } from '@src/lib/open-external';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface LlmConfigMsg {
  message_type?: string;
  is_configured?: boolean;
  auth_method?: string;
  oauth_request_id?: string;
  status?: string;
}

/**
 * Single global mount in App.tsx. Listens for `OAuthEventType.DEVICE_FLOW_START`
 * (currently fired only for GitHub) and renders a modal showing the user_code +
 * a single button that copies the code and opens `verification_uri`. The dialog
 * does NOT open the URL until the user clicks — that way the copy happens
 * inside a user-gesture (so paste works on the GitHub page). Self-closes on
 * `on_llm_config_msg` SUCCESS for the matching `oauth_request_id`, or when the
 * user hits Cancel.
 */
export function GitHubDeviceFlowModal() {
  const { t } = useLingui();
  const [payload, setPayload] = useState<OAuthDeviceFlowPayload | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // Listen for device-flow start events.
  useEffect(() => {
    const onStart = (p: OAuthDeviceFlowPayload) => {
      setPayload(p);
      setError(null);
      setRemaining(p.expires_in);
    };
    dataManager.on(OAuthEventType.DEVICE_FLOW_START, onStart);
    return () => {
      dataManager.off(OAuthEventType.DEVICE_FLOW_START, onStart);
    };
  }, []);

  // Countdown to expiry.
  useEffect(() => {
    if (!payload) return;
    const tick = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(tick);
  }, [payload]);

  // Listen for the backend's broadcast — close on SUCCESS, surface ERROR.
  useEffect(() => {
    if (!payload) return;
    const handler = (msg: LlmConfigMsg) => {
      if (msg.auth_method !== 'github') return;
      if (msg.oauth_request_id && msg.oauth_request_id !== payload.state) return;
      if (msg.status === 'success') {
        notify.success({ title: t`GitHub connected`, durationMs: 3000 });
        setPayload(null);
      } else if (msg.status === 'error') {
        setError(t`Authorization failed or was denied. Click Retry to try again.`);
      }
    };
    connectionManager.on('on_llm_config_msg', handler);
    return () => {
      connectionManager.off('on_llm_config_msg', handler);
    };
  }, [payload]);

  // Single combined action: copy first (inside the user-gesture click handler,
  // so the clipboard write is allowed and paste will work on the GitHub page),
  // then open the verification URL. If the copy fails we still open the page —
  // the user can read the code from the dialog and type it manually.
  const handleCopyAndOpen = useCallback(async () => {
    if (!payload) return;
    try {
      await copyToClipboard(payload.user_code);
      notify.success({ title: t`Code copied — paste it on the GitHub page`, durationMs: 2500 });
    } catch {
      notify.error({
        title: t`Could not copy the code`,
        message: t`Type it manually on the GitHub page.`,
        durationMs: 4000,
      });
    }
    openExternal(payload.verification_uri);
  }, [payload, t]);

  const handleClose = useCallback(() => {
    // Tell the backend to stop polling so it doesn't keep talking to GitHub
    // for the rest of the device-code's lifetime (~15 min). Best-effort; the
    // session will time out naturally if this RPC fails.
    if (payload?.state) {
      void oauthService.cancelDeviceFlow(payload.provider, payload.state);
    }
    setPayload(null);
    setError(null);
  }, [payload]);

  if (!payload) return null;

  const expired = remaining <= 0;
  const mm = Math.floor(remaining / 60);
  const ss = (remaining % 60).toString().padStart(2, '0');

  return (
    <Dialog open onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle><Trans>Connect GitHub</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Your one-time code is below. Click <span className="font-medium">Copy code &amp; open GitHub</span> — we'll copy it to your clipboard and open the GitHub activation page so you can paste it there.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-center rounded-md border border-border bg-muted/40 px-4 py-3">
            <span className="select-all font-mono text-2xl tracking-widest">{payload.user_code}</span>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void handleCopyAndOpen()}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              <Trans>Copy code &amp; open GitHub</Trans>
            </Button>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : expired ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <Trans>Code expired. Close and click Connect again to get a fresh code.</Trans>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <Trans>Waiting for authorization… (expires in {mm}:{ss})</Trans>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default GitHubDeviceFlowModal;
