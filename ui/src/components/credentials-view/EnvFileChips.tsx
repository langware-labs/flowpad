import { Trans, useLingui } from '@lingui/react/macro';
import {
  DEFAULT_CREDENTIAL_ENVIRONMENT,
  credentialEnvFileName,
  type CredentialScopeFile,
  type CredentialsStatus,
  type Project,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { FileKey, Plus, X } from 'lucide-react';
import React, { useState } from 'react';

/** The chip text: the project's own file by name, a declared one by its project path, the
 *  home folder's with `~/` — so two `.env.local` chips never read the same. */
export function envFileLabel(file: CredentialScopeFile): string {
  if (file.extra_path) return file.extra_path;
  const name = credentialEnvFileName(file.environment);
  return file.scope === 'user' ? `~/${name}` : name;
}

/** The chips in reading order: the project's files (its `.env.local`, then the ones it
 *  declares), then the home folder's. A scope's own file shows only when it exists; a
 *  declared one always does, so a missing one can still be removed. */
export function envFileChips(status: CredentialsStatus): CredentialScopeFile[] {
  return status.files
    .filter((file) => !!file.path && (file.exists || !!file.extra_path))
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}

/**
 * The env files the credentials table reads, as chips that open them — and, for a
 * project, the list of more env files it reads (`backend/.env`), kept in the project
 * manifest so it travels with the repo. The root `.env.local` is always read and is the
 * only file values are written to; a declared file is read, never written.
 */
export function EnvFileChips({
  status,
  project,
  onChanged,
}: {
  status: CredentialsStatus;
  project: Project | undefined;
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // Declared files belong to development on this computer; a named environment never reads them.
  const declares = !!project && status.environment === DEFAULT_CREDENTIAL_ENVIRONMENT;
  const declared = status.files.flatMap((file) => (file.extra_path ? [file.extra_path] : []));

  const save = async (paths: string[]) => {
    if (!project) return;
    setBusy(true);
    try {
      await project.setEnvFiles(paths);
      await onChanged();
      return true;
    } catch (err) {
      notify.error({ title: t`Could not save the env files`, message: err instanceof Error ? err.message : undefined });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const path = draft.trim();
    if (!path) return;
    if (await save([...declared, path])) {
      setDraft('');
      setAdding(false);
    }
  };

  return (
    <>
      {envFileChips(status).map((file) => (
        <span key={file.path} className="inline-flex items-center">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-6 gap-1 rounded-full px-2 font-mono text-[11px] font-normal',
              file.extra_path && 'rounded-e-none',
              !file.exists && 'border-dashed text-muted-foreground',
            )}
            title={file.exists ? file.path! : t`${file.path} — not found`}
            disabled={!file.exists}
            onClick={() => navigation.openMachinePath(file.path!, LOCAL_COMPUTE_NODE)}
            data-testid={file.extra_path ? `credentials-env-file-extra-${file.extra_path}` : `credentials-env-file-${file.scope}`}
          >
            <FileKey className="h-3 w-3" />
            {envFileLabel(file)}
          </Button>
          {file.extra_path && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 rounded-s-none rounded-e-full border-s-0 px-1 text-muted-foreground hover:text-foreground"
              title={t`Stop reading ${file.extra_path}`}
              disabled={busy}
              onClick={() => void save(declared.filter((p) => p !== file.extra_path))}
              data-testid={`credentials-env-file-remove-${file.extra_path}`}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </span>
      ))}
      {declares && (
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-full p-0 text-muted-foreground"
              title={t`Read another env file`}
              data-testid="credentials-env-file-add"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 space-y-2 p-3" align="start">
            <div className="text-xs text-muted-foreground">
              <Trans>
                A path inside this project. Credentials read it after the project's .env.local, which stays the
                only file values are written to.
              </Trans>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="backend/.env"
                className="h-7 font-mono text-xs"
                data-testid="credentials-env-file-add-input"
              />
              <Button type="submit" size="sm" className="h-7" disabled={busy || !draft.trim()}>
                <Trans>Add</Trans>
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
