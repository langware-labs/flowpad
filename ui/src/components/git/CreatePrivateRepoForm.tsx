import type { RepoSummary } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { useCreateGitRepo } from '@src/hooks/use-git-providers';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, Loader2, Lock } from 'lucide-react';
import { useState } from 'react';

interface CreatePrivateRepoFormProps {
  onBack: () => void;
  onCreated: (repo: RepoSummary) => void;
}

export function CreatePrivateRepoForm({ onBack, onCreated }: CreatePrivateRepoFormProps) {
  const { t } = useLingui();
  const [name, setName] = useState('');
  const createRepo = useCreateGitRepo('github');
  const submit = () => {
    const value = name.trim();
    if (!value || createRepo.isPending) return;
    createRepo.mutate(value, { onSuccess: onCreated });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="install-create-repo">
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={onBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> <Trans>Back to repositories</Trans>
      </button>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Lock className="h-4 w-4" /> <Trans>Create a private GitHub repository</Trans>
        </div>
        <p className="text-xs text-muted-foreground">
          <Trans>Flowpad initializes the repository, then proposes the install on a separate review branch.</Trans>
        </p>
      </div>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
        }}
        placeholder={t`Repository name`}
        autoFocus
        spellCheck={false}
        data-testid="install-create-repo-name"
      />
      {createRepo.error && (
        <p className="text-xs text-destructive">
          {createRepo.error instanceof Error ? createRepo.error.message : String(createRepo.error)}
        </p>
      )}
      <Button onClick={submit} disabled={!name.trim() || createRepo.isPending} data-testid="install-create-repo-submit">
        {createRepo.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        <Trans>Create private repo</Trans>
      </Button>
    </div>
  );
}
