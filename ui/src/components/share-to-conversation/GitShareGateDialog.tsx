import React from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import type { GitShareGate } from '@src/hooks/use-git-share-gate';
import type { GitShareGateState } from '@src/components/share-to-conversation/git-share-gate-state';

interface GitShareGateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder being shared — named in every face's copy. */
  folderName: string;
  gate: GitShareGate;
}

interface Face {
  title: string;
  body: React.ReactNode;
  /** The one thing the user can do about this state. Async — remediations are
   *  round-trips; the button fires them and re-checks on completion. */
  action?: { label: string; run: () => Promise<void>; testId: string };
}

/**
 * The gate in FRONT of the share dialog. Files always travel over Git, so a
 * folder that isn't ready gets one actionable fix instead of a disabled control.
 *
 * One face per gate state, keyed — so a new state is a new key the compiler
 * demands, not a branch to slot into an if-chain in the right order.
 */
export function GitShareGateDialog({
  open,
  onOpenChange,
  folderName,
  gate,
}: GitShareGateDialogProps): React.ReactElement {
  const { t } = useLingui();

  const FACES: Record<GitShareGateState, Face> = {
    checking: {
      title: t`Checking Git…`,
      body: <Trans>Checking whether {folderName} is ready to share.</Trans>,
    },
    setup: {
      title: t`Git is required to share files`,
      body: (
        <Trans>
          Sharing sends files over Git, so the receiver can pull them. {folderName} isn't set up with
          Git yet.
        </Trans>
      ),
      action: { label: t`Setup git`, run: gate.runSetup, testId: 'git-share-gate-setup' },
    },
    commit: {
      title: t`Commit your changes to share them`,
      body: (
        <Trans>
          {folderName} has changes that haven't been pushed yet. The receiver can only pull what's on
          the remote.
        </Trans>
      ),
      action: { label: t`Commit & continue`, run: gate.runCommit, testId: 'git-share-gate-commit' },
    },
    blocked: {
      title: t`This folder can't be shared yet`,
      body: <>{gate.reason ?? t`Couldn't read this folder's Git status.`}</>,
    },
    // Never rendered: the host hands a ready folder straight to the share dialog.
    ready: { title: t`Ready to share`, body: null },
  };

  const face = FACES[gate.state];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="git-share-gate">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            {face.title}
          </DialogTitle>
          <DialogDescription>{face.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          {face.action && (
            <Button
              onClick={() => void face.action!.run()}
              disabled={gate.busy}
              className="gap-1.5"
              data-testid={face.action.testId}
            >
              {gate.busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {face.action.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
