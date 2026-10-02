import { Trans, useLingui } from '@lingui/react/macro';
import { DEFAULT_CREDENTIAL_ENVIRONMENT, type CredentialsStatus, type Project } from '@sdk';
import { useRefreshCredentials } from '@src/components/credentials/use-credentials';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { cn } from '@src/lib/utils';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { FileKey, X } from 'lucide-react';
import React, { useState } from 'react';

import { envFilesOf, type EnvFileEntry } from './credential-rows';

/** A file's name in the list: `~/` marks the home folder's, so two `.env.local` never read the same. */
export function envFileLabel(entry: EnvFileEntry): string {
  return entry.scope === 'user' && !entry.extraPath ? `~/${entry.name}` : entry.name;
}

/** The files in reading order: the project's (its `.env.local`, then the ones it declares),
 *  then the home folder's. A scope's own file is listed only when it exists; a declared one
 *  always is, so a missing one can still be removed. */
export function envFileList(status: CredentialsStatus): EnvFileEntry[] {
  return status.files
    .flatMap(envFilesOf)
    .filter((entry) => !!entry.path && (entry.exists || !!entry.extraPath))
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}

/**
 * The env files the credentials table reads, as ONE chip: the first file and a count.
 * A lone file with nothing to manage opens on click; otherwise the chip opens the list —
 * name, full path, scope — where a project adds and removes the env files it declares
 * (rules: `ProjectManifestSpec.env_files`).
 */
export function EnvFilesChip({ status, project }: { status: CredentialsStatus; project: Project | undefined }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const refresh = useRefreshCredentials();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // A named environment never reads declared files, so it has none to manage.
  const declares = !!project && status.environment === DEFAULT_CREDENTIAL_ENVIRONMENT;
  const files = envFileList(status);
  const declared = files.flatMap((entry) => (entry.extraPath ? [entry.extraPath] : []));
  if (!files.length && !declares) return null;

  const first = files[0];
  const lone = files.length === 1 && !declares;
  const scopeLabel = (entry: EnvFileEntry) =>
    entry.scope === 'user' ? t`User` : entry.extraPath ? t`Project · added` : t`Project`;

  const openFile = (entry: EnvFileEntry) => {
    setOpen(false);
    navigation.openMachinePath(entry.path!, LOCAL_COMPUTE_NODE);
  };

  const save = async (paths: string[]) => {
    if (!project) return false;
    setBusy(true);
    try {
      await project.setEnvFiles(paths);
      await refresh();
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

  const chip = (
    <Button
      variant="outline"
      size="sm"
      className="h-6 gap-1 rounded-full px-2 font-mono text-[11px] font-normal"
      title={first?.path ?? undefined}
      onClick={lone ? () => openFile(first) : undefined}
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
  if (lone) return chip;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent className="w-[28rem] p-1" align="start" data-testid="credentials-env-files-list">
        <ul>
          {files.map((entry) => (
            <li key={entry.path} className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
              <button
                type="button"
                className={cn('min-w-0 flex-1 text-start', !entry.exists && 'cursor-default opacity-60')}
                disabled={!entry.exists}
                onClick={() => openFile(entry)}
                title={entry.exists ? undefined : t`Not found`}
                data-testid={`credentials-env-file-${entry.extraPath ?? entry.scope}`}
              >
                <div className="flex items-center gap-2">
                  <FileKey className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{envFileLabel(entry)}</span>
                  <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    {scopeLabel(entry)}
                  </span>
                </div>
                <div className="truncate ps-5 font-mono text-[10px] text-muted-foreground">{entry.path}</div>
              </button>
              {entry.extraPath && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  title={t`Stop reading ${entry.extraPath}`}
                  disabled={busy}
                  onClick={() => void save(declared.filter((p) => p !== entry.extraPath))}
                  data-testid={`credentials-env-file-remove-${entry.extraPath}`}
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
