import React, { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, Plus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GitRemoteField, type GitRemoteValue } from '@src/components/git/GitRemoteField';
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

/**
 * Which repository a git flow should use.
 *
 * `branch` rides along on the existing-repo path: without it a flow clones (or
 * pushes to) whatever the remote's HEAD points at, so work that lives on a
 * release or feature branch silently becomes `main`. Absent means "the remote's
 * default branch" — a choice the user made, not one we guessed.
 */
export type GitTarget =
  | { mode: 'existing'; url: string; branch?: string }
  | { mode: 'new'; name: string };

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
}: GitTargetDialogProps): React.ReactElement {
  const { t } = useLingui();
  const [mode, setMode] = useState<GitTarget['mode']>('existing');
  const [remote, setRemote] = useState<GitRemoteValue>({ url: '', branch: null });
  const [name, setName] = useState(nameSeed);
  // The branch step takes over the dialog body and carries its own Back, so the
  // mode chips and the footer would be a second, contradicting set of controls.
  const [inBranchPicker, setInBranchPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setRemote({ url: '', branch: null });
    setName(nameSeed);
    setInBranchPicker(false);
    setBusy(false);
  }, [open, nameSeed]);

  const value = mode === 'existing' ? remote.url.trim() : name.trim();

  const handleSubmit = useCallback(() => {
    if (!value || busy) return;
    const target: GitTarget =
      mode === 'existing' ? { mode, url: value, branch: remote.branch ?? undefined } : { mode, name: value };
    if (!awaitSubmit) {
      onOpenChange(false);
      void onSubmit(target);
      return;
    }
    setBusy(true);
    // No `setBusy(false)`: the dialog closes here, and reopening resets it.
    void Promise.resolve(onSubmit(target)).finally(() => onOpenChange(false));
  }, [awaitSubmit, busy, mode, value, remote.branch, onSubmit, onOpenChange]);

  const modeOptions: { value: GitTarget['mode']; icon: React.ReactNode; label: React.ReactNode; title: string }[] = [
    {
      value: 'existing',
      icon: <GitBranch className="h-3 w-3" />,
      label: <Trans>Existing repo</Trans>,
      title: t`Use a repository that already exists`,
    },
    {
      value: 'new',
      icon: <Plus className="h-3 w-3" />,
      label: <Trans>New repo</Trans>,
      title: t`Create a brand-new repository`,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      {/* Wider than a stock dialog: the existing-repo step hosts a five-column
          repo table and an invitations strip, which are cramped at `max-w-lg`. */}
      <DialogContent className="sm:max-w-2xl" data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {!inBranchPicker && (
          <div className="flex items-center justify-center gap-1" role="radiogroup">
            {modeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={mode === opt.value}
                title={opt.title}
                onClick={() => setMode(opt.value)}
                data-testid={`${testIdPrefix}-mode-${opt.value}`}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                  mode === opt.value
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid min-w-0 gap-1.5 py-1">
          {mode === 'existing' ? (
            <GitRemoteField value={remote} onChange={setRemote} onStepChange={setInBranchPicker} urlLabel={urlLabel} />
          ) : (
            <>
              <Label htmlFor={`${testIdPrefix}-name`}>
                <Trans>Repository name</Trans>
              </Label>
              <Input
                id={`${testIdPrefix}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={nameSeed || t`my-context`}
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit();
                }}
                data-testid={`${testIdPrefix}-name`}
              />
            </>
          )}
        </div>

        {!inBranchPicker && (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!value || busy}
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
