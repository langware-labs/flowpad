import React, { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus } from 'lucide-react';
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
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

/** What the user chose in the form — handed to the git-context-folder wizard. */
export type GitFolderInput = { mode: 'existing'; url: string } | { mode: 'new'; name: string };

interface AddGitFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Launch the wizard with the collected input. Owned by the host. */
  onSubmit: (input: GitFolderInput) => void | Promise<void>;
}

/**
 * AddGitFolderDialog — the small form in front of the git-context-folder
 * wizard. The user either pastes an EXISTING repo URL (set up as the git
 * context folder) or names a NEW repo to create; only then does the wizard
 * open, seeded with that input, to do the actual clone/init + registration.
 */
export function AddGitFolderDialog({ open, onOpenChange, onSubmit }: AddGitFolderDialogProps): React.ReactElement {
  const { t } = useLingui();
  const [mode, setMode] = useState<GitFolderInput['mode']>('existing');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setUrl('');
    setName('');
  }, [open]);

  const value = mode === 'existing' ? url.trim() : name.trim();

  const handleSubmit = useCallback(() => {
    if (!value) return;
    onOpenChange(false);
    void onSubmit(mode === 'existing' ? { mode, url: value } : { mode, name: value });
  }, [mode, value, onOpenChange, onSubmit]);

  const modeOptions: { value: GitFolderInput['mode']; icon: React.ReactNode; label: React.ReactNode; title: string }[] =
    [
      {
        value: 'existing',
        icon: <GitBranch className="h-3 w-3" />,
        label: <Trans>Existing repo</Trans>,
        title: t`Set up an existing git repository as the context folder`,
      },
      {
        value: 'new',
        icon: <Plus className="h-3 w-3" />,
        label: <Trans>New repo</Trans>,
        title: t`Create a brand-new repository`,
      },
    ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="add-git-folder-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add Git folder</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Set up a git-backed context folder for this project.</Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-1" role="radiogroup">
          {modeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={mode === opt.value}
              title={opt.title}
              onClick={() => setMode(opt.value)}
              data-testid={`add-git-folder-mode-${opt.value}`}
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

        <div className="grid gap-1.5 py-1">
          {mode === 'existing' ? (
            <>
              <Label htmlFor="add-git-folder-url">
                <Trans>Repository URL</Trans>
              </Label>
              <Input
                id="add-git-folder-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit();
                }}
                data-testid="add-git-folder-url"
              />
            </>
          ) : (
            <>
              <Label htmlFor="add-git-folder-name">
                <Trans>Repository name</Trans>
              </Label>
              <Input
                id="add-git-folder-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`my-context`}
                autoComplete="off"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit();
                }}
                data-testid="add-git-folder-name"
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!value} data-testid="add-git-folder-submit">
            {mode === 'existing' ? <Trans>Add</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
