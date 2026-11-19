import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, SecretScope, type ActiveVault } from '@sdk';
import { SecretVaultPicker } from '@src/components/credentials/SecretVaultPicker';
import { useRefreshSecretManager, useSecretManager } from '@src/components/credentials/use-secret-manager';
import { Row, smallBtn } from '@src/components/footer/BrowserChip';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { describeApiError } from '@src/lib/error-message';
import { openExternal } from '@src/lib/open-external';
import { cn } from '@src/lib/utils';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';

/** What a click learned about one vault. Asking a manager can raise its own unlock prompt, so only a
 *  click does; until then a vault this computer can use shows no state. */
type Asked = { state: 'checking' | 'ready' | 'not_ready'; reason: string };

/** Footer chip: the secret manager in use here — the project's default vault, else this instance's —
 *  with the project's vaults and the global one. It renders `useSecretManager` and calls actions. */
export function SecretManagerChip() {
  const { t } = useLingui();
  const { project } = useProjectLocation();
  const projectId = project?.id ? String(project.id) : null;
  const { data, isSuccess } = useSecretManager(projectId);
  const refresh = useRefreshSecretManager();
  const [asked, setAsked] = useState<Partial<Record<string, Asked>>>({});
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<'project' | 'global' | null>(null);

  if (!projectId || !isSuccess) return null;

  const { rows, active } = data;
  const mark = (name: string, state: Asked['state'], reason = '') => setAsked((a) => ({ ...a, [name]: { state, reason } }));
  const warn = (active && !active.usable) || rows.some((r) => !r.usable || asked[r.name]?.state === 'not_ready');
  const scopeWord = active?.scope === SecretScope.GLOBAL ? t`global` : t`this project`;
  const label = active ? t`Secret manager: ${active.manager_title} · ${active.name} (${scopeWord})` : t`No secret manager`;

  const run = async (name: string, action: 'check' | 'setup') => {
    mark(name, 'checking');
    try {
      const res = action === 'setup' ? await credentialsService.vaultSetup(projectId, name) : await credentialsService.checkVault(projectId, name);
      mark(name, res.ready ? 'ready' : 'not_ready', res.ready ? '' : res.reason);
    } catch (err) {
      mark(name, 'not_ready', describeApiError(err, t`Could not reach the vault.`).message);
    }
    if (action === 'setup') await refresh(); // a setup can install the manager; a check changes nothing listed
  };
  const openVault = async (row: ActiveVault) => {
    try {
      const url = await credentialsService.vaultOpenUrl(projectId, row.name);
      if (url) openExternal(url);
      else mark(row.name, asked[row.name]?.state ?? 'ready', t`${row.manager_title} has no link to a vault — open it in the app.`);
    } catch (err) {
      mark(row.name, 'not_ready', describeApiError(err, t`Could not open the vault.`).message);
    }
  };
  const change = async (write: Promise<unknown>) => {
    await write;
    await refresh();
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="footer-secret-manager-chip"
            data-state={active ? (warn ? 'unavailable' : 'set') : 'none'}
            data-scope={active?.scope}
            aria-label={label}
            title={label}
            className={cn(
              'relative flex shrink-0 items-center rounded-sm border border-transparent px-1.5 text-[10px] hover:bg-accent',
              !active && 'text-muted-foreground',
            )}
          >
            <span className="relative inline-flex">
              <KeyRound className="h-3 w-3" />
              {warn && <span className="absolute -end-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-0" data-testid="secret-manager-picker">
          <div className="px-3 py-2 text-xs font-semibold">
            <Trans>Secret manager</Trans>
          </div>
          {rows.map((row) => {
            const state = row.usable ? (asked[row.name]?.state ?? 'unchecked') : 'not_installed';
            const reason = row.usable ? asked[row.name]?.reason : t`${row.missing_tool} is not installed on this computer.`;
            return (
              <div key={row.name} data-state={state}>
                <Row
                  testId={`secret-manager-row-${row.name}`}
                  icon={<KeyRound className="h-3.5 w-3.5 shrink-0" />}
                  name={row.name}
                  note={
                    state === 'not_installed' ? (
                      <Trans>{row.manager_title} · not installed here</Trans>
                    ) : state === 'not_ready' ? (
                      <Trans>{row.manager_title} · not ready</Trans>
                    ) : state === 'ready' ? (
                      <Trans>{row.manager_title} · ready</Trans>
                    ) : (
                      row.manager_title
                    )
                  }
                  tone={state === 'ready' ? 'ok' : state === 'unchecked' || state === 'checking' ? 'muted' : 'warn'}
                  selected={row.is_default}
                  onSelect={() => void openVault(row)}
                  action={
                    <>
                      {!row.is_default && (
                        <button
                          type="button"
                          className={smallBtn}
                          onClick={() => void change(credentialsService.setDefaultVault(projectId, row.name))}
                          data-testid={`secret-manager-make-default-${row.name}`}
                        >
                          <Trans>Make default</Trans>
                        </button>
                      )}
                      {state === 'checking' ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      ) : state === 'unchecked' ? (
                        <button type="button" className={smallBtn} onClick={() => void run(row.name, 'check')}>
                          <Trans>Check</Trans>
                        </button>
                      ) : state !== 'ready' ? (
                        <button type="button" className={smallBtn} onClick={() => void run(row.name, 'setup')} data-testid={`secret-manager-setup-${row.name}`}>
                          <Trans>Set up</Trans>
                        </button>
                      ) : null}
                    </>
                  }
                />
                {reason && <div className="px-3 pb-1.5 text-[11px] text-muted-foreground">{reason}</div>}
              </div>
            );
          })}
          <Row
            testId="secret-manager-row-global"
            icon={<KeyRound className="h-3.5 w-3.5 shrink-0" />}
            name={<Trans>Global</Trans>}
            note={data.global ? data.global.manager_title : <Trans>none</Trans>}
            tone="muted"
            selected={active?.scope === SecretScope.GLOBAL}
            action={
              <>
                {data.global && (
                  <button type="button" className={smallBtn} onClick={() => void change(credentialsService.setGlobalVault(null))}>
                    <Trans>Remove</Trans>
                  </button>
                )}
                <button
                  type="button"
                  className={smallBtn}
                  data-testid="secret-manager-global-set"
                  onClick={() => {
                    setOpen(false);
                    setAdding('global');
                  }}
                >
                  {data.global ? <Trans>Change</Trans> : <Trans>Set</Trans>}
                </button>
              </>
            }
          />
          <button
            type="button"
            data-testid="secret-manager-add"
            onClick={() => {
              setOpen(false);
              setAdding('project');
            }}
            className="flex w-full border-t px-3 py-1.5 text-xs text-primary hover:bg-accent"
          >
            <Trans>+ Add vault</Trans>
          </button>
        </PopoverContent>
      </Popover>
      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent className="w-[440px] p-4" data-testid="secret-manager-add-dialog">
          <DialogTitle className="sr-only">
            <Trans>Secret manager</Trans>
          </DialogTitle>
          <SecretVaultPicker
            projectId={projectId}
            onSave={adding === 'global' ? async (vault) => void (await credentialsService.setGlobalVault(vault)) : undefined}
            onCancel={() => setAdding(null)}
            onDone={() => {
              setAdding(null);
              void refresh();
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
