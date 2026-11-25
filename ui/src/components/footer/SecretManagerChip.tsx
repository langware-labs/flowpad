import { Trans, useLingui } from '@lingui/react/macro';
import { credentialsService, SecretScope, VaultAccess, type ActiveVault } from '@sdk';
import { SecretVaultPicker } from '@src/components/credentials/SecretVaultPicker';
import { useRefreshSecretManager, useSecretManager, useVaultAccess } from '@src/components/credentials/use-secret-manager';
import { Row, smallBtn } from '@src/components/footer/BrowserChip';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { describeApiError } from '@src/lib/error-message';
import { openExternal } from '@src/lib/open-external';
import { cn } from '@src/lib/utils';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';

/** One vault: its access on this computer (open / sealed), Open or Close, and a click on its name opens
 *  it in the manager's own screen. */
function VaultRow({ projectId, row, selected, children }: { projectId: string; row: ActiveVault; selected: boolean; children?: React.ReactNode }) {
  const { t } = useLingui();
  const { access, loading, change } = useVaultAccess(projectId, row);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const state = access?.state;
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setSaid('');
    try {
      await work();
    } catch (err) {
      setSaid(describeApiError(err, t`Could not reach the vault.`).message);
    } finally {
      setBusy(false);
    }
  };
  const link = () =>
    act(async () => {
      const url = await credentialsService.vaultLink(projectId, row);
      if (url) openExternal(url);
      else setSaid(t`${row.manager_title} has no link to a vault — open it in the app.`);
    });
  const testId = row.scope === SecretScope.GLOBAL ? 'secret-manager-row-global' : `secret-manager-row-${row.name}`;
  const reason = said || access?.detail || (state === VaultAccess.NOT_INSTALLED ? t`${row.missing_tool || row.manager_title} is not installed on this computer.` : '');
  return (
    <div data-state={state ?? 'loading'} data-testid={`${testId}-state`}>
      <Row
        testId={testId}
        icon={<KeyRound className="h-3.5 w-3.5 shrink-0" />}
        name={row.scope === SecretScope.GLOBAL ? <Trans>Global</Trans> : row.name}
        note={
          state === VaultAccess.OPEN ? (
            <Trans>open · {row.manager_title}</Trans>
          ) : state === VaultAccess.SEALED ? (
            <Trans>sealed · {row.manager_title}</Trans>
          ) : state === VaultAccess.NOT_INSTALLED ? (
            <Trans>not installed here · {row.manager_title}</Trans>
          ) : (
            row.manager_title
          )
        }
        tone={state === VaultAccess.OPEN ? 'ok' : state === VaultAccess.SEALED || state === VaultAccess.NOT_INSTALLED ? 'warn' : 'muted'}
        selected={selected}
        onSelect={() => void link()}
        action={
          <>
            {children}
            {busy || (loading && !access) ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            ) : access?.can_close ? (
              <button type="button" className={smallBtn} onClick={() => void act(() => change('close'))} data-testid={`${testId}-close`}>
                <Trans>Close</Trans>
              </button>
            ) : access?.can_open ? (
              <button type="button" className={smallBtn} onClick={() => void act(() => change('open'))} data-testid={`${testId}-open`}>
                <Trans>Open</Trans>
              </button>
            ) : state === VaultAccess.NOT_INSTALLED && row.scope === SecretScope.PROJECT ? (
              <button
                type="button"
                className={smallBtn}
                onClick={() => void act(async () => void (await credentialsService.vaultSetup(projectId, row.name)))}
                data-testid={`${testId}-setup`}
              >
                <Trans>Set up</Trans>
              </button>
            ) : null}
          </>
        }
      />
      {reason && <div className="px-3 pb-1.5 text-[11px] text-muted-foreground">{reason}</div>}
    </div>
  );
}

/** Footer chip: the secret manager in use here — the person's pick, else the project's default vault, else
 *  this instance's — with the project's vaults and the global one. The check mark is the one in use; "Use
 *  here" picks another for this computer only. It renders `useSecretManager` and calls actions. */
export function SecretManagerChip() {
  const { t } = useLingui();
  const { project } = useProjectLocation();
  const projectId = project?.id ? String(project.id) : null;
  const { data, isSuccess } = useSecretManager(projectId);
  const refresh = useRefreshSecretManager();
  const { access } = useVaultAccess(projectId, data.active);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<'project' | 'global' | null>(null);

  if (!projectId || !isSuccess) return null;

  const { rows, active } = data;
  const sealed = access?.state === VaultAccess.SEALED;
  const warn = sealed || access?.state === VaultAccess.NOT_INSTALLED || (!!active && !active.usable);
  const scopeWord = active?.scope === SecretScope.GLOBAL ? t`global` : t`this project`;
  const label = !active
    ? t`No secret manager`
    : sealed
      ? t`Secret manager: ${active.manager_title} · ${active.name} (${scopeWord}) · sealed`
      : t`Secret manager: ${active.manager_title} · ${active.name} (${scopeWord})`;
  const change = async (write: Promise<unknown>) => {
    await write;
    await refresh();
  };
  const globalActive = active?.scope === SecretScope.GLOBAL;
  /** Pick `name` for this computer, or — on the picked row — go back to the project's own choice. */
  const pickButton = (name: string, isActive: boolean) =>
    isActive && !active?.picked ? null : (
      <button
        type="button"
        className={smallBtn}
        onClick={() => void change(credentialsService.setVaultPick(projectId, isActive ? '' : name))}
        title={isActive ? t`Go back to the project's default` : t`Use this vault on this computer`}
        data-testid={isActive ? 'secret-manager-unpick' : `secret-manager-pick-${name}`}
      >
        {isActive ? <Trans>Reset</Trans> : <Trans>Use here</Trans>}
      </button>
    );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="footer-secret-manager-chip"
            data-state={active ? (warn ? 'unavailable' : 'set') : 'none'}
            data-access={access?.state}
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
          {rows.map((row) => (
            <VaultRow key={row.name} projectId={projectId} row={row} selected={!globalActive && active?.name === row.name}>
              {pickButton(row.name, !globalActive && active?.name === row.name)}
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
            </VaultRow>
          ))}
          {data.global ? (
            <VaultRow projectId={projectId} row={data.global} selected={globalActive}>
              {pickButton('global', globalActive)}
              <button type="button" className={smallBtn} onClick={() => void change(credentialsService.setGlobalVault(null))}>
                <Trans>Remove</Trans>
              </button>
            </VaultRow>
          ) : (
            <Row
              testId="secret-manager-row-global"
              icon={<KeyRound className="h-3.5 w-3.5 shrink-0" />}
              name={<Trans>Global</Trans>}
              note={<Trans>none</Trans>}
              tone="muted"
              action={
                <button
                  type="button"
                  className={smallBtn}
                  data-testid="secret-manager-global-set"
                  onClick={() => {
                    setOpen(false);
                    setAdding('global');
                  }}
                >
                  <Trans>Set</Trans>
                </button>
              }
            />
          )}
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
        <DialogContent className="w-[480px] p-5" data-testid="secret-manager-add-dialog">
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
