import { approveMachine, denyMachine, formatMachineCode, lookupMachineCode, type MachineEnrollmentView } from '@sdk';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { notify } from '@src/notifications';
import { Loader2, Monitor } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * Approve a machine that ran `flow connect` without being logged in.
 *
 * Two steps, and the second is never skipped: (1) the code — typed here or
 * prefilled from a `?connect_code=` deep link — is looked up on the hub, (2) the
 * hub's description of the machine (hostname, OS, IP, when) is shown and the
 * human clicks **Approve** or **Deny**. A prefilled code only saves typing; it
 * never approves by itself — that click is the whole phishing defence
 * (RFC 8628 §5.4). On approval the hub creates the `user_machine` node under the
 * caller's account and the machine picks up its key on its next poll.
 */
export interface AddMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Code carried by the deep link, if any. Prefills and auto-looks-up; never auto-approves. */
  initialCode?: string | null;
  /** Fired after the hub confirmed the approval so the caller can refresh its list. */
  onApproved?: (nodeId: string) => void;
}

const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function AddMachineDialog({ open, onOpenChange, initialCode, onApproved }: AddMachineDialogProps) {
  const { t } = useLingui();
  const [code, setCode] = useState('');
  const [machine, setMachine] = useState<MachineEnrollmentView | null>(null);
  const [nodeName, setNodeName] = useState('');
  const [busy, setBusy] = useState<'lookup' | 'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  const reset = useCallback(() => {
    setCode('');
    setMachine(null);
    setNodeName('');
    setBusy(null);
    setError(null);
    setRemaining(0);
  }, []);

  const lookup = useCallback(
    async (raw: string) => {
      const formatted = formatMachineCode(raw);
      if (!CODE_PATTERN.test(formatted)) {
        setError(t`Enter the 8-character code shown by flow connect.`);
        return;
      }
      setBusy('lookup');
      setError(null);
      try {
        const view = await lookupMachineCode(formatted);
        setMachine(view);
        setNodeName(view.suggested_name);
        setRemaining(view.expires_in);
      } catch (e) {
        setMachine(null);
        const message = e instanceof Error ? e.message : '';
        setError(
          /401|403|409|sign in|unauthori/i.test(message)
            ? t`Sign in to FlowPad Hub first — approving a machine binds it to your account.`
            : /429|too many/i.test(message)
              ? t`Too many attempts. Wait a few minutes and try again.`
              : t`No machine is waiting on that code. Check the code, or run flow connect again — codes expire after 15 minutes.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  // Deep link: prefill + look up. Approval still needs the click below.
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    if (initialCode) {
      const formatted = formatMachineCode(initialCode);
      setCode(formatted);
      void lookup(formatted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialCode]);

  // Countdown so the human sees the code aging out.
  useEffect(() => {
    if (!machine) return;
    const tick = setInterval(() => setRemaining((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(tick);
  }, [machine]);

  const approve = async () => {
    setBusy('approve');
    setError(null);
    try {
      const result = await approveMachine(code, nodeName.trim() || undefined);
      notify.success({ title: t`Machine ${result.node_name} added — it is connecting now.`, durationMs: 4000 });
      onApproved?.(result.node_id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Approval failed`);
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    setBusy('deny');
    try {
      await denyMachine(code);
      notify.info({ title: t`Machine denied`, durationMs: 3000 });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Could not deny`);
    } finally {
      setBusy(null);
    }
  };

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="add-machine-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            <Trans>Add a machine</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              On the machine run <code className="rounded bg-muted px-1">flow connect</code>. If it is not signed in it
              shows a code — enter it here and confirm it is your machine.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        {!machine ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
          >
            <Label htmlFor="machine-code">
              <Trans>Code</Trans>
            </Label>
            <Input
              id="machine-code"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="WDJB-MJHT"
              className="font-mono text-lg tracking-widest"
              value={code}
              onChange={(e) => setCode(formatMachineCode(e.target.value))}
              data-testid="machine-code-input"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={busy !== null || code.length < 9} data-testid="machine-code-lookup">
                {busy === 'lookup' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Trans>Find machine</Trans>
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="machine-details">
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <span className="text-muted-foreground">
                  <Trans>Machine</Trans>
                </span>
                <span className="font-medium">{machine.hostname || '—'}</span>
                <span className="text-muted-foreground">
                  <Trans>System</Trans>
                </span>
                <span>
                  {machine.os_type || '—'}
                  {machine.flow_version ? ` · flow ${machine.flow_version}` : ''}
                </span>
                <span className="text-muted-foreground">
                  <Trans>From</Trans>
                </span>
                <span>{machine.client_ip || '—'}</span>
                <span className="text-muted-foreground">
                  <Trans>Requested</Trans>
                </span>
                <span>{new Date(machine.requested_at).toLocaleTimeString()}</span>
                <span className="text-muted-foreground">
                  <Trans>Code expires</Trans>
                </span>
                <span className="font-mono">
                  {mm}:{ss}
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              <Trans>
                Approving lets this machine act as you on FlowPad. Only approve a code you generated yourself.
              </Trans>
            </p>
            <Label htmlFor="machine-name">
              <Trans>Name</Trans>
            </Label>
            <Input id="machine-name" value={nodeName} onChange={(e) => setNodeName(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="outline" onClick={() => void deny()} disabled={busy !== null} data-testid="machine-deny">
                {busy === 'deny' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Trans>Deny</Trans>
              </Button>
              <Button
                onClick={() => void approve()}
                disabled={busy !== null || remaining === 0}
                data-testid="machine-approve"
              >
                {busy === 'approve' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Trans>Approve</Trans>
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
