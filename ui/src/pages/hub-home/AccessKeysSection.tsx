import { useCallback, useEffect, useRef, useState } from 'react';
import { Cast, KeyRound } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  formatAccessKeyCode,
  isElectronShell,
  listAccessKeys,
  remoteControlService,
  removeAccessKey,
  renameAccessKey,
  type AccessKey,
} from '@sdk';
import { DesktopTile } from '@src/components/quick-create/QuickCreatePanel';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { openExternal } from '@src/lib/open-external';
import { DockPointer, REMOTE_CONTROL_PARAM } from '@src/navigation/DockPointer';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { notify } from '@src/notifications';
import { ViewType } from '@src/types/ViewType';
import { AddAccessKeyDialog } from './AddAccessKeyDialog';
import { displayMachineName, useHandOffToApp } from './hand-off-to-app';

/** Where "Open Flowpad" lands: the app's Assets page, asking for the Remote control panel (the top bar's menu). */
const REMOTE_CONTROL_DOCK = new DockPointer(ViewType.ASSETS).withOption(REMOTE_CONTROL_PARAM, 'open');
/** `/dock/assets?remote-control=open` — the same address, for the `flowpad://` hand-off. */
export const REMOTE_CONTROL_PATH = REMOTE_CONTROL_DOCK.toUrl();

/** The signed-in person's access keys: null until first read. `reload` reads them again. */
export function useAccessKeys(enabled: boolean): { keys: AccessKey[] | null; reload: () => Promise<void> } {
  const [keys, setKeys] = useState<AccessKey[] | null>(null);
  const reload = useCallback(async () => {
    try {
      setKeys(await listAccessKeys());
    } catch (error) {
      console.error('[useAccessKeys] list failed', error);
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { keys, reload };
}

function KeyCard({ accessKey, onChanged }: { accessKey: AccessKey; onChanged: () => Promise<void> }) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const code = (
    <span className="tabular-nums" data-testid="access-key-code">
      {formatAccessKeyCode(accessKey.code)}
    </span>
  );

  const rename = async () => {
    const label = (draft ?? '').trim();
    setDraft(null);
    if (!label || label === accessKey.label) return;
    try {
      await renameAccessKey(accessKey.id, label);
      await onChanged();
    } catch (error) {
      notify.error({ title: t`Could not rename the access key`, error });
    }
  };

  const remove = async () => {
    try {
      await removeAccessKey(accessKey.id);
      await onChanged();
    } catch (error) {
      notify.error({ title: t`Could not remove the access key`, error });
    }
  };

  return (
    <div
      className="flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
      data-testid="access-key-card"
      data-key-id={accessKey.id}
    >
      <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        {draft === null ? (
          <span className="block truncate text-sm font-semibold text-foreground" data-testid="access-key-label">
            {accessKey.label}
          </span>
        ) : (
          <input
            autoFocus
            value={draft}
            maxLength={64}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') setDraft(null);
            }}
            aria-label={t`Access key name`}
            data-testid="access-key-label-input"
            className="w-full border-b border-border bg-transparent text-sm outline-none"
          />
        )}
        <span className="block truncate text-xs text-muted-foreground">
          {accessKey.backup_eligible ? (
            <Trans>Passkey · synced · code {code}</Trans>
          ) : (
            <Trans>Passkey · this device · code {code}</Trans>
          )}
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={() => setDraft(accessKey.label)}
        data-testid="access-key-rename"
      >
        <Trans>Rename</Trans>
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={() => setRemoving(true)}
        data-testid="access-key-remove"
      >
        <Trans>Remove</Trans>
      </Button>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t`Remove this access key?`}
        description={t`Machines that accepted “${accessKey.label}” stop accepting it. A machine left with no key turns remote control off.`}
        confirmLabel={t`Remove`}
        variant="destructive"
        onConfirm={() => void remove()}
        testId="access-key-remove-confirm"
      />
    </div>
  );
}

/** "One more step": the key is added, remote control on the machine is still off. */
function FinishNotice({ machineName }: { machineName: string }) {
  const { handOff, noApp } = useHandOffToApp(REMOTE_CONTROL_DOCK);

  return (
    <div
      className="flex w-full max-w-xl flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2"
      data-testid="access-key-finish"
    >
      <div className="flex items-center gap-3">
        <Cast className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-foreground">
          <Trans>
            <span className="font-medium text-amber-600 dark:text-amber-400">One more step</span> · Turn on remote
            control on {machineName}.
          </Trans>
        </p>
        <Button size="sm" className="shrink-0" onClick={() => void handOff()} data-testid="access-key-open-flowpad">
          <Trans>Open Flowpad</Trans>
        </Button>
      </div>
      {noApp && (
        <p className="text-xs text-muted-foreground" data-testid="access-key-no-app">
          <Trans>
            Flowpad did not open. On {machineName}, open Flowpad, then the menu at the top right → Remote control.
          </Trans>
        </p>
      )}
    </div>
  );
}

/**
 * Access keys on the hub's Machines page: the passkeys that open remote control of the person's
 * machines — listed, renamed, removed, added.
 *
 * Adding runs the browser's passkey prompt, which only a hub page in a real browser may do. The
 * Electron window sends the person to the browser instead (through the machine's own request,
 * so the key it gets back is tied to this machine). When the page was opened BY a machine's
 * request (`request`) and a key now exists for it, the section says what is left: turn remote
 * control on, on that machine.
 */
export function AccessKeysSection({
  keys,
  reload,
  email,
  request,
  machineName,
  machineOn = false,
}: {
  keys: AccessKey[] | null;
  reload: () => Promise<void>;
  email: string;
  /** `DockPointer.accessKeyRequest`: the machine request this page was opened with. */
  request: { id: string; node: string } | null;
  /** The asking machine's name, when it is one of the listed machines. */
  machineName?: string | null;
  /** The machine of `request` already reports remote control on: nothing is left to do there. */
  machineOn?: boolean;
}) {
  const { t } = useLingui();
  const [adding, setAdding] = useState(false);
  const requestDone = !!request && !!keys?.some((key) => key.request_id === request.id);

  // Opened by a machine's "Add access key" link: the add dialog opens by itself, once per request. The person
  // already asked on the machine, so this page asks for no second click.
  const requestId = request?.id ?? null;
  const keysLoaded = keys !== null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!requestId || !keysLoaded || requestDone || isElectronShell()) return;
    if (askedFor.current === requestId) return;
    askedFor.current = requestId;
    setAdding(true);
  }, [requestId, keysLoaded, requestDone]);

  const add = async () => {
    if (!isElectronShell()) {
      setAdding(true);
      return;
    }
    try {
      // The desktop app asks its machine for a request; a hub page shown in the shell reopens itself.
      const url = isHubOnly()
        ? `${window.location.origin}${window.location.pathname}`
        : (await remoteControlService.request()).url;
      openExternal(url);
    } catch (error) {
      notify.error({ title: t`Could not open the hub page`, error });
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="access-keys-section">
      <h2 className="text-sm font-medium text-muted-foreground">
        <Trans>Access keys</Trans>
      </h2>
      {requestDone && !machineOn && <FinishNotice machineName={displayMachineName(machineName) || t`your machine`} />}
      {keys?.length === 0 && (
        <p className="-mt-1 text-xs text-muted-foreground" data-testid="access-keys-empty">
          <Trans>No access keys. A passkey lets you open remote control of your machines.</Trans>
        </p>
      )}
      {keys?.map((key) => (
        <KeyCard key={key.id} accessKey={key} onChanged={reload} />
      ))}
      <DesktopTile
        Icon={KeyRound}
        label={t`Add access key`}
        onClick={() => void add()}
        data-testid="add-access-key-open"
      />
      <AddAccessKeyDialog
        open={adding}
        onOpenChange={setAdding}
        email={email}
        firstKey={keys?.length === 0}
        request={request}
        onAdded={() => void reload()}
      />
    </div>
  );
}
