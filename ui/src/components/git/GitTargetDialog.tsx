import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { GitRepoPicker, type GitTarget, type GitTargetMode } from '@src/components/git/GitRepoPicker';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';

export type { GitTarget } from '@src/components/git/GitRepoPicker';

export interface GitTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  /** Submit button label. The two flows read differently: one adds a folder,
   *  the other sets a project up. */
  submitLabel: React.ReactNode;
  /** Seeds the new-repo name field (the project being published, usually). */
  nameSeed?: string;
  urlLabel?: string;
  /** Prefix for `data-testid`s, so the two hosts stay separately addressable. */
  testIdPrefix: string;
  /**
   * Await the submit and keep the dialog up (with a spinner) until it settles.
   * For a host whose action starts something the user should see start; the
   * default closes first, for a host that hands off immediately.
   */
  awaitSubmit?: boolean;
  onSubmit: (target: GitTarget) => void | Promise<void>;
  /** Choices offered — see `GitRepoPicker`. */
  modes?: readonly GitTargetMode[];
}

/**
 * Choose the repository a git flow will use: one that already exists — browsed
 * or pasted, with its branch — or a new one the user names.
 *
 * The one dialog behind every "add git" surface. Both halves are the point:
 * without the remote choice a flow invents a repository (Flowpad's did:
 * `gh repo create --public`, publishing a project to a repo nobody named), and
 * without the branch choice it silently lands on `main`.
 */
export function GitTargetDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  nameSeed = '',
  urlLabel,
  testIdPrefix,
  awaitSubmit = false,
  onSubmit,
  modes,
}: GitTargetDialogProps): React.ReactElement {
  const [target, setTarget] = useState<GitTarget | null>(null);
  // The branch step takes over the body and carries its own Back, so the footer
  // would be a second, contradicting set of controls.
  const [inBranchPicker, setInBranchPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInBranchPicker(false);
    setBusy(false);
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!target || busy) return;
    if (!awaitSubmit) {
      onOpenChange(false);
      void onSubmit(target);
      return;
    }
    setBusy(true);
    // No `setBusy(false)`: the dialog closes here, and reopening resets it.
    void Promise.resolve(onSubmit(target)).finally(() => onOpenChange(false));
  }, [awaitSubmit, busy, target, onSubmit, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      {/* Wider than a stock dialog: the existing-repo step hosts a five-column
          repo table and an invitations strip, which are cramped at `max-w-lg`. */}
      <DialogContent className="sm:max-w-2xl" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Keyed on `open` so every opening starts from a clean choice. */}
        {open && (
          <GitRepoPicker
            modes={modes}
            onChange={setTarget}
            onStepChange={setInBranchPicker}
            onEnter={handleSubmit}
            nameSeed={nameSeed}
            urlLabel={urlLabel}
            enabled={open}
            testIdPrefix={testIdPrefix}
          />
        )}

        {!inBranchPicker && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!target || busy}
              data-testid={`${testIdPrefix}-submit`}
            >
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default GitTargetDialog;
