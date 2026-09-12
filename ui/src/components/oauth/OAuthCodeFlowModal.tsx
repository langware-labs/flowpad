import { dataManager, OAuthEventType, oauthService, type OAuthCodeFlowPayload } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { openExternal } from '@src/lib/open-external';
import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';

/** Provider-hosted code handoff for a browser outside the backend's machine. */
export function OAuthCodeFlowModal() {
  const [flow, setFlow] = useState<OAuthCodeFlowPayload | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const start = (next: OAuthCodeFlowPayload) => {
      setFlow(next);
      setCode('');
      setError('');
    };
    dataManager.on(OAuthEventType.CODE_FLOW_START, start);
    return () => {
      dataManager.off(OAuthEventType.CODE_FLOW_START, start);
    };
  }, []);
  const cancel = async () => {
    if (!flow || busy) return;
    try {
      await oauthService.cancelCodeFlow(flow);
      setFlow(null);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const submit = async () => {
    if (!flow || !code.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await oauthService.submitAuthorizationCode(flow, code);
      setFlow(null);
      setCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={flow !== null}
      onOpenChange={(open) => {
        if (!open) void cancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Authorize connection</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Open the provider, approve access, then paste the authorization code shown there.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Button variant="outline" onClick={() => flow && openExternal(flow.url)}>
          <Trans>Open authorization page</Trans>
        </Button>
        <label htmlFor="oauth-authorization-code">
          <Trans>Authorization code</Trans>
        </label>
        <Input
          id="oauth-authorization-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          disabled={busy}
        />
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={busy || !code.trim()} onClick={() => void submit()}>
            {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
