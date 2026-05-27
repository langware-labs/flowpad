import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { GitRepo, type TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { GitRepoAcceptModal } from './GitRepoAcceptModal';
import { cn } from '@src/lib/utils';

interface GitRepoChipProps {
  typeId: TypeId;
}

/**
 * Conversation-bubble chip for a ``git_repo`` TYPE_ID attachment. Click →
 * opens the ``GitRepoAcceptModal`` — the recipient's accept-and-work flow.
 *
 * Kept as a wrapper around the inline render rather than going through
 * ``ContextEntityChip`` because the latter routes to the entity's dock view
 * (``/dock/git_repo/<id>``) and we want clicks to land directly on the
 * modal instead.
 */
export function GitRepoChip({ typeId }: GitRepoChipProps) {
  const { data: repo } = useEntity<GitRepo>(typeId);
  const [open, setOpen] = useState(false);

  const label = repo
    ? `${repo.full_name || repo.name || typeId.id}${repo.branch ? ` · ${repo.branch}` : ''}`
    : typeId.id;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open repo"
        data-testid="git-repo-chip"
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
          'border-slate-500/40 bg-slate-500/10 text-slate-700 hover:bg-slate-500/20 dark:text-slate-300',
        )}
      >
        <GitBranch className="h-3 w-3" />
        <span className="max-w-[18ch] truncate">{label}</span>
      </button>
      <GitRepoAcceptModal
        gitRepoTypeId={typeId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
