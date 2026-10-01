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
import { FileKey, X } from 'lucide-react';
import React, { useState } from 'react';

/** A file's name in the list: the project's own by name, a declared one by its project
 *  path, the home folder's with `~/` — so two `.env.local` rows never read the same. */
export function envFileLabel(file: CredentialScopeFile): string {
  if (file.extra_path) return file.extra_path;
  const name = credentialEnvFileName(file.environment);
  return file.scope === 'user' ? `~/${name}` : name;
}

/** The files in reading order: the project's (its `.env.local`, then the ones it
 *  declares), then the home folder's. A scope's own file is listed only when it exists;
 *  a declared one always is, so a missing one can still be removed. */
export function envFileList(status: CredentialsStatus): CredentialScopeFile[] {
  return status.files
    .filter((file) => !!file.path && (file.exists || !!file.extra_path))
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}

/**
 * The env files the credentials table reads, as ONE chip: the first file's name and,
 * when there are more, a count. One file and nothing to manage opens it; otherwise the
 * chip opens the list — each file's name, its full path, its scope — and, for a
 * project, the place to add or remove the env files it declares (`backend/.env`), kept
 * in the project manifest so they travel with the repo. The root `.env.local` is always
 * read and is the only file values are written to; a declared file is read, never written.
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // Declared files belong to development on this computer; a named environment never reads them.
  const declares = !!project && status.environment === DEFAULT_CREDENTIAL_ENVIRONMENT;
  const declared = status.files.flatMap((file) => (file.extra_path ? [file.extra_path] : []));
  const files = envFileList(status);
  if (!files.length && !declares) return null;

  const scopeLabel = (file: CredentialScopeFile) =>
    file.scope === 'user' ? t`User` : file.extra_path ? t`Project · added` : t`Project`;

  const openFile = (file: CredentialScopeFile) => {
    setOpen(false);
    navigation.openMachinePath(file.path!, LOCAL_COMPUTE_NODE);
  };

  const save = async (paths: string[]) => {
    if (!project) return false;
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
    if (path && (await save([...declared, path]))) setDraft('');
  };

  const first = files[0];
  const chip = (
    <Button
      variant="outline"
      size="sm"
      className="h-6 gap-1 rounded-full px-2 font-mono text-[11px] font-normal"
      title={first?.path ?? undefined}
      data-testid="credentials-env-files"
    >
      <FileKey className="h-3 w-3" />
      {first ? envFileLabel(first) : t`Env files`}
      {files.length > 1 && (
        <span
          className="ms-0.5 rounded-full bg-muted px-1.5 font-sans text-[10px] text-muted-foreground"
          data-testid="credentials-env-files-count"
        >
          {files.length}
        </span>
      )}
    </Button>
  );

  // One file and nothing to manage: the chip IS the file.
  if (files.length === 1 && !declares) {
    return React.cloneElement(chip, { onClick: () => openFile(first) });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent className="w-[28rem] p-1" align="start" data-testid="credentials-env-files-list">
        <ul>
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
              <button
                type="button"
                className={cn('min-w-0 flex-1 text-start', !file.exists && 'cursor-default opacity-60')}
                disabled={!file.exists}
                onClick={() => openFile(file)}
                title={file.exists ? undefined : t`Not found`}
                data-testid={`credentials-env-file-${file.extra_path ?? file.scope}`}
              >
                <div className="flex items-center gap-2">
                  <FileKey className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{envFileLabel(file)}</span>
                  <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    {scopeLabel(file)}
                  </span>
                </div>
                <div className="truncate ps-5 font-mono text-[10px] text-muted-foreground">{file.path}</div>
              </button>
              {file.extra_path && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  title={t`Stop reading ${file.extra_path}`}
                  disabled={busy}
                  onClick={() => void save(declared.filter((p) => p !== file.extra_path))}
                  data-testid={`credentials-env-file-remove-${file.extra_path}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {declares && (
          <form
            className="mt-1 space-y-1.5 border-t px-2 pb-1 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="text-[11px] text-muted-foreground">
              <Trans>
                Read another env file — a path inside this project. The project's .env.local stays the only file
                values are written to.
              </Trans>
            </div>
            <div className="flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="backend/.env"
                className="h-7 font-mono text-xs"
                data-testid="credentials-env-file-add-input"
              />
              <Button type="submit" size="sm" className="h-7" disabled={busy || !draft.trim()}>
                <Trans>Add</Trans>
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
