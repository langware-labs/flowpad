import type { ComputeNode } from '@sdk';
import { AutoLoginField } from '@src/pages/hub-home/AutoLoginField';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { StepList } from '@src/components/ui/step-list';
import type { Step } from '@src/hooks/use-sandboxes';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface LaunchSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The written-down box about to be booted for the first time. */
  sandbox: ComputeNode | null;
  /** Boot it and set up whatever it was created with. Resolves when ready. */
  onLaunch: (node: ComputeNode, opts: { autoLogin: boolean }) => Promise<ComputeNode | null>;
  /** Open a launched box, from this dialog's own click. */
  onOpen: (node: ComputeNode) => void;
  /** Live progress rows for the launch in flight. */
  steps: Step[];
}

/**
 * "Launch this sandbox" — the first boot of a box that was only written down.
 *
 * The card's Launch button opens this rather than starting straight away, for
 * two reasons that are really one: this click is what begins costing money, and
 * auto-login is the single thing that can only be decided before the box signs
 * anyone in. Both belong in front of the user once, here.
 *
 * Opening an already-launched box asks nothing and shows nothing — that path
 * keeps its one click.
 *
 * Same three settled states as the create dialog's second half (idle → launching
 * → launched), and for the same reason: the progress and any failure have to be
 * somewhere the user is still looking.
 */
export function LaunchSandboxDialog({
  open,
  onOpenChange,
  sandbox,
  onLaunch,
  onOpen,
  steps,
}: LaunchSandboxDialogProps) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<'idle' | 'launching' | 'launched'>('idle');
  const [autoLogin, setAutoLogin] = useState(true);
  const [launched, setLaunched] = useState<ComputeNode | null>(null);
  const [error, setError] = useState('');

  // Reset on OPEN. Reopening for another box must not inherit the last one's
  // phase — it would offer "Open sandbox" for a machine that is still a record.
  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setAutoLogin(true);
    setLaunched(null);
    setError('');
  }, [open]);

  const handleLaunch = useCallback(async () => {
    if (!sandbox || phase !== 'idle') return;
    setPhase('launching');
    setError('');
    try {
      const node = await onLaunch(sandbox, { autoLogin });
      if (!node) {
        // The hook refused because a launch was already in flight. Nothing
        // booted, so this is not an error — just offer the button again.
        setPhase('idle');
        return;
      }
      setLaunched(node);
      setPhase('launched');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, [sandbox, phase, autoLogin, onLaunch]);

  const handleOpen = useCallback(() => {
    if (!launched) return;
    onOpen(launched);
    onOpenChange(false);
  }, [launched, onOpen, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="launch-sandbox-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Launch {sandbox?.name || t`sandbox`}?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>This starts the machine and sets up whatever it was created with.</Trans>
          </DialogDescription>
        </DialogHeader>

        {phase === 'idle' && (
          <AutoLoginField checked={autoLogin} onChange={setAutoLogin} testId="launch-auto-login" />
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {phase !== 'idle' && (
          <div data-testid="sandbox-launch-steps">
            <StepList steps={steps} />
          </div>
        )}

        <DialogFooter className="mt-2">
          {phase === 'launched' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="launch-done">
                <Trans>Done</Trans>
              </Button>
              <Button onClick={handleOpen} data-testid="launch-open">
                <Trans>Open sandbox</Trans>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={phase === 'launching'}>
                <Trans>Cancel</Trans>
              </Button>
              <Button onClick={() => void handleLaunch()} disabled={phase === 'launching'} data-testid="launch-confirm">
                {phase === 'launching' && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                <Trans>Launch</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
