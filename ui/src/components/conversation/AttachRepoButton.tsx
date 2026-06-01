import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import {
  type BranchSummary,
  type GitProvider,
  materializeRepo,
  type RepoSummary,
} from '@sdk';
import { BranchPicker } from '@src/components/git/BranchPicker';
import { RepoPicker } from '@src/components/git/RepoPicker';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { notify } from '@src/notifications';

interface AttachRepoButtonProps {
  /** Called with the freshly-materialized ``git_repo-<uuid>`` TypeId. */
  onAttach: (typeId: string, label: string) => void;
  disabled?: boolean;
}

/**
 * Composer-side affordance: opens a dialog hosting RepoPicker → BranchPicker
 * → ``repo/materialize`` → emits a fresh ``git_repo-<uuid>`` TypeId for the
 * draft to attach via ``sendReply({assetReferences: [...]})``.
 *
 * Reuses the existing pickers verbatim. The recipient never sees the picker
 * UI — they receive the rendered chip and open ``GitRepoAcceptModal``.
 */
export function AttachRepoButton({ onAttach, disabled }: AttachRepoButtonProps) {
  const [open, setOpen] = useState(false);
  const [provider] = useState<GitProvider>('github');
  const [pickedRepo, setPickedRepo] = useState<RepoSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeAndReset = () => {
    setOpen(false);
    setPickedRepo(null);
    setSubmitting(false);
  };

  const handleBranch = async (branch: BranchSummary) => {
    if (!pickedRepo) return;
    setSubmitting(true);
    try {
      const result = await materializeRepo({
        provider,
        full_name: pickedRepo.full_name,
        branch: branch.name,
        owner: pickedRepo.owner,
        name: pickedRepo.name,
      });
      const label = `${result.full_name} · ${result.branch}`;
      onAttach(result.typeid, label);
      closeAndReset();
    } catch (err) {
      console.error('[AttachRepoButton] materialize failed', err);
      notify.error({ title: err instanceof Error ? err.message : 'Failed to attach repo' });
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Attach a git repo"
        data-testid="attach-repo-button"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <GitBranch className="h-3.5 w-3.5" />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeAndReset();
          else setOpen(true);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {pickedRepo
                ? `Pick a branch on ${pickedRepo.full_name}`
                : 'Attach a git repo'}
            </DialogTitle>
          </DialogHeader>
          {!pickedRepo ? (
            <RepoPicker
              provider={provider}
              onSelect={(repo) => setPickedRepo(repo)}
              enabled={open}
            />
          ) : submitting ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Materializing…
            </div>
          ) : (
            <BranchPicker
              repo={{
                provider,
                owner: pickedRepo.owner,
                name: pickedRepo.name,
                default_branch: pickedRepo.default_branch,
                full_name: pickedRepo.full_name,
              }}
              onSelect={handleBranch}
              onBack={() => setPickedRepo(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
