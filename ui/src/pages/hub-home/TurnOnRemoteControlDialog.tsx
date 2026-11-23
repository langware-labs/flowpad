import { useEffect, useRef, useState } from 'react';
import { Fingerprint, Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { encodeAssertion, isElectronShell, signWithPasskey, type AccessKey } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { DockPointer, REMOTE_CONTROL_ASSERTION_PARAM, REMOTE_CONTROL_PARAM } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { displayMachineName, useHandOffToApp } from './hand-off-to-app';

/** Where the answer goes: the app's Assets page, asking for the Remote control panel, with the signed answer. */
function handOverDock(encodedAssertion: string | null): DockPointer {
  return new DockPointer(ViewType.ASSETS)
    .withOption(REMOTE_CONTROL_PARAM, 'open')
    .withOption(REMOTE_CONTROL_ASSERTION_PARAM, encodedAssertion);
}

type Failure = 'cancelled' | 'no_key' | 'unsupported';

export interface TurnOnRemoteControlDialogProps {
  /** `DockPointer.remoteControlConfirm`: the machine's request this page was opened with. */
  request: { challenge: string; node: string | null; hours: number } | null;
  /** The signed-in person's access keys; null until read. */
  keys: AccessKey[] | null;
  /** The asking machine's name, when it is one of the listed machines. */
  machineName?: string | null;
}

/**
 * Turn on remote control of a machine — the fingerprint step, on the hub page.
 *
 * The machine opened this page with a challenge (`remote-control-confirm`), for a number of hours.
 * The dialog opens by itself, runs the browser's passkey prompt once (the button runs it again),
 * and hands the signed answer back to the app: through `flowpad://` on the hub, by navigation when
 * the page is served by the desktop's own server — the way "Open Flowpad" already goes. It does
 * that once by itself too, and keeps the button. The hub server takes no part: the machine checks
 * the answer.
 *
 * Only for a real browser: the Electron window is not an origin a passkey may sign for, so it never
 * opens this.
 */
export function TurnOnRemoteControlDialog({ request, keys, machineName }: TurnOnRemoteControlDialogProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const { handOff, noApp } = useHandOffToApp(handOverDock(answer));

  const challenge = request?.challenge ?? null;
  const hours = request?.hours ?? 1;
  const machine = displayMachineName(machineName) || t`your machine`;

  const sign = async () => {
    if (!challenge || !keys) return;
    if (keys.length === 0) {
      setFailure('no_key');
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      setAnswer(encodeAssertion(await signWithPasskey({ challenge, keys })));
    } catch (error) {
      console.error('[TurnOnRemoteControlDialog] sign failed', error);
      const name = (error as { name?: string } | null)?.name;
      setFailure(name === 'NotSupportedError' || name === 'SecurityError' ? 'unsupported' : 'cancelled');
    } finally {
      setBusy(false);
    }
  };

  // Opened by a machine's "Turn on": the person already asked there, so the prompt comes up by itself, once.
  const keysLoaded = keys !== null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!challenge || !keysLoaded || isElectronShell()) return;
    if (askedFor.current === challenge) return;
    askedFor.current = challenge;
    setAnswer(null);
    setOpen(true);
    void sign();
    // On arrival only — `sign` is a new function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge, keysLoaded]);

  const handOver = async () => {
    if (answer) await handOff();
  };

  // Signed: go back to the app by itself, once per answer. The button stays for a hand-off the browser held back.
  const handedOver = useRef<string | null>(null);
  useEffect(() => {
    if (!answer || handedOver.current === answer) return;
    handedOver.current = answer;
    void handOver();
    // Once per answer — `handOver` is a new function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer]);

  const failureText: Record<Failure, string> = {
    cancelled: t`Nothing was turned on.`,
    no_key: t`No matching access key on this account.`,
    unsupported: t`A passkey cannot be used on this page. Open the Flowpad hub in your browser.`,
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogContent className="max-w-md" data-testid="turn-on-remote-control-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Turn on remote control</Trans>
          </DialogTitle>
          <DialogDescription data-testid="turn-on-remote-control-line">
            {hours === 1 ? (
              <Trans>{machine} · for 1 hour · confirm with your passkey</Trans>
            ) : (
              <Trans>
                {machine} · for {hours} hours · confirm with your passkey
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {answer ? (
          <p className="text-sm text-foreground" data-testid="turn-on-remote-control-done">
            <Trans>Fingerprint confirmed. Go back to Flowpad to finish.</Trans>
          </p>
        ) : (
          failure && (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="turn-on-remote-control-error"
              data-reason={failure}
            >
              {failureText[failure]}
            </p>
          )
        )}
        {answer && noApp && (
          <p className="text-xs text-muted-foreground" data-testid="turn-on-remote-control-no-app">
            <Trans>Flowpad did not open. Open Flowpad on {machine}, then press Open Flowpad here again.</Trans>
          </p>
        )}
        <DialogFooter>
          {answer ? (
            <Button type="button" onClick={() => void handOver()} data-testid="turn-on-remote-control-open">
              <Trans>Open Flowpad</Trans>
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                type="button"
                onClick={() => void sign()}
                disabled={busy || !keysLoaded}
                data-testid="turn-on-remote-control-confirm"
              >
                {busy ? (
                  <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Fingerprint className="me-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                <Trans>Confirm with passkey</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
