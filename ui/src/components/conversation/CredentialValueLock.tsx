import { useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Info, Lock } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Credential, type CredentialTestState, credentialsService, dataContext, type SealedCard, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useTestVerdict } from '@src/components/credentials/credential-test-verdict';
import { useCredentialsStatus, useRefreshCredentials } from '@src/components/credentials/use-credentials';
import { buildDockPointer } from '@src/navigation/entity-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { describeApiError } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';

/**
 * The lock beside a shared credential's chip: the share carried the VALUE too, not only the definition.
 * Two ways a value travels, both read from what already exists — no new message field:
 *  - secured transfer: a sealed card for this credential in this conversation;
 *  - secret manager: the credential's variables point at a project vault (`secret_ref`).
 * Neither → no lock: the receiver brings their own value. The popover is the short answer and one action;
 * ⓘ opens the security details. Names only — a value never reaches the page.
 */

const sealedKey = (conversationId: string) => ['sealed-incoming', conversationId] as const;

/** This conversation's incoming sealed cards — one read shared by every chip in it. */
function useSealedIncoming(conversationId: string) {
  return useQuery({
    queryKey: sealedKey(conversationId),
    queryFn: () => credentialsService.sealedIncoming(conversationId).catch(() => [] as SealedCard[]),
    // Sealed values live in this machine's store.
    enabled: !!conversationId && dataContext.caps.localFiles,
  });
}

export function CredentialValueLock({
  typeId,
  name: sharedName,
  conversationId,
}: {
  typeId: TypeId;
  /** The name the share carried; the credential row's name otherwise. */
  name?: string | null;
  conversationId: string;
}) {
  const { data: credential } = useEntity<Credential>(typeId);
  const { data: cards } = useSealedIncoming(conversationId);
  const name = sharedName || credential?.name || '';
  const card = cards?.find((c) => c.credential_name === name);
  const refs = Object.entries(credential?.vars ?? {}).filter(([, v]) => v.secret_ref?.vault);
  const projectId = credential?.project_id ?? null;
  if (card)
    return (
      <LockShell kind="sealed">
        <SealedBody card={card} name={name} conversationId={conversationId} />
      </LockShell>
    );
  if (refs.length && projectId)
    return (
      <LockShell kind="vault">
        <VaultBody
          typeId={typeId}
          name={name}
          projectId={projectId}
          vault={refs[0][1].secret_ref!.vault}
          vars={refs.map(([k]) => k)}
          conversationId={conversationId}
        />
      </LockShell>
    );
  return null;
}

/** The lock button and its popover; the body is mounted only while open, so its reads wait for a click. */
function LockShell({ kind, children }: { kind: 'sealed' | 'vault'; children: ReactNode }) {
  const { t } = useLingui();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`The value was shared too — click for details`}
          aria-label={t`Value shared`}
          data-testid="credential-lock"
          data-route={kind}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted/30 text-emerald-500 transition-colors hover:bg-muted"
        >
          <Lock className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start" data-testid="credential-lock-popover">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Header with ⓘ, one line, the details behind ⓘ, the actions. */
function LockBody({
  title,
  line,
  rows,
  children,
}: {
  title: string;
  line: string;
  rows: [string, string][];
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const [details, setDetails] = useState(false);
  return (
    <>
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Lock className="h-3.5 w-3.5 text-emerald-500" />
        <span className="flex-1">{title}</span>
        <button
          type="button"
          title={t`Security details`}
          aria-pressed={details}
          data-testid="credential-lock-details"
          onClick={() => setDetails((d) => !d)}
          className={cn('text-muted-foreground hover:text-foreground', details && 'text-foreground')}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{line}</p>
      {details && (
        <div className="mb-3 text-xs" data-testid="credential-lock-detail-rows">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2 py-0.5">
              <span className="w-24 shrink-0 text-muted-foreground">{k}</span>
              <span className="min-w-0 flex-1 break-words">{v}</span>
            </div>
          ))}
        </div>
      )}
      {children && <div className="flex flex-wrap items-center gap-1.5 [&>button]:h-7">{children}</div>}
    </>
  );
}

/** Run one action with a busy flag and an error toast. */
function useAct() {
  const [busy, setBusy] = useState(false);
  const act = async (what: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await what();
    } catch (error) {
      notify.error({ title: failTitle, message: describeApiError(error, '').message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

function SealedBody({ card, name, conversationId }: { card: SealedCard; name: string; conversationId: string }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const refresh = useRefreshCredentials();
  const { busy, act } = useAct();
  const verdict = useTestVerdict();
  const sender = card.sender_name || t`Someone`;
  const [title, line] = {
    pending: [t`${sender} sent you the key`, t`Fill it in and ${name} is ready on this machine.`],
    filled: [t`Key filled in`, card.test ? verdict(card.test, 'self').text : t`Ready on this machine.`],
    declined: [t`Key not available`, t`You declined it.`],
  }[card.state] ?? [t`Key not available`, card.error || card.state];
  const after = async (what: Promise<unknown>) => {
    await what;
    await Promise.all([qc.invalidateQueries({ queryKey: sealedKey(conversationId) }), refresh()]);
  };
  return (
    <LockBody
      title={title}
      line={line}
      rows={[
        [t`Method`, t`End-to-end encrypted transfer`],
        [t`Values`, (card.variables ?? []).join(', ') || '—'],
        [t`Can decrypt`, t`Only this device`],
        [t`Hub sees`, t`Names only, never values`],
        [t`Expires`, card.expires_at ? new Date(card.expires_at).toLocaleString() : '—'],
      ]}
    >
      {card.state === 'pending' && (
        <>
          <Button
            size="sm"
            disabled={busy}
            data-testid="credential-lock-fill"
            onClick={() =>
              void act(
                () => after(credentialsService.sealedFill(conversationId, card.message_id)),
                t`Could not fill in ${name}`,
              )
            }
          >
            <Trans>Fill in</Trans>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(
                () => after(credentialsService.sealedDecline(conversationId, card.message_id)),
                t`Could not decline ${name}`,
              )
            }
          >
            <Trans>Decline</Trans>
          </Button>
        </>
      )}
    </LockBody>
  );
}

function VaultBody({
  typeId,
  name,
  projectId,
  vault,
  vars,
  conversationId,
}: {
  typeId: TypeId;
  name: string;
  projectId: string;
  vault: string;
  vars: string[];
  conversationId: string;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const refresh = useRefreshCredentials();
  const { busy, act } = useAct();
  const [access, setAccess] = useState<'ok' | 'denied' | 'requested'>('ok');
  const [tested, setTested] = useState<CredentialTestState | null>(null);
  const verdict = useTestVerdict();
  // Read on open only: whether the values are here, and which manager holds the vault.
  const { data: status } = useCredentialsStatus(projectId);
  const { data: where } = useQuery({
    queryKey: ['secret-vault-label', projectId, vault],
    queryFn: async () => {
      const [vaults, managers] = await Promise.all([
        credentialsService.vaults(projectId),
        credentialsService.listManagers(),
      ]);
      const spec = vaults[vault];
      const configured = spec?.config?.vault;
      return {
        manager: managers.find((m) => m.name === spec?.manager)?.title || spec?.manager || '',
        vault: typeof configured === 'string' && configured ? configured : vault,
      };
    },
  });
  const manager = where?.manager || t`your secret manager`;
  const vaultLabel = where?.vault ?? vault;
  const row = status?.credentials.find((c) => c.name === name);
  const here = !!row && row.vars.filter((v) => vars.includes(v.env_var)).every((v) => v.present);

  const fetch = () =>
    act(
      async () => {
        try {
          const res = await credentialsService.fetch(name, projectId, conversationId);
          if (res.denied.length) setAccess('denied');
          setTested(res.test ?? null);
        } catch (error) {
          if (describeApiError(error, '').code !== 'denied') throw error;
          setAccess('denied');
        }
        await refresh();
      },
      t`Could not fetch ${name}`,
    );
  const request = () =>
    act(
      async () => {
        await new Credential({ id: typeId.id } as never).requestSecretAccess(vault);
        setAccess('requested');
      },
      t`Could not request access`,
    );
  const open = () => {
    const pointer = buildDockPointer(
      { type: typeId.type, id: typeId.id },
      { type: 'conversation', id: conversationId },
    );
    if (pointer) navigation.openDock(pointer);
  };

  const line =
    access === 'requested'
      ? t`Access to the ${vaultLabel} vault requested.`
      : access === 'denied'
        ? t`You need access to the ${vaultLabel} vault.`
        : tested
          ? verdict(tested, 'self').text
          : here
            ? t`Ready on this machine.`
            : t`Get it from the ${vaultLabel} vault.`;
  return (
    <LockBody
      title={t`Key is in ${manager}`}
      line={line}
      rows={[
        [t`Secret manager`, manager],
        [t`Vault`, vaultLabel],
        [t`Values`, vars.join(', ')],
        [t`Who can read`, t`Members of the vault`],
        [t`On this machine`, here ? t`Yes` : t`Not yet`],
      ]}
    >
      {access !== 'ok' ? (
        <Button
          size="sm"
          disabled={busy || access === 'requested'}
          onClick={() => void request()}
          data-testid="credential-lock-request"
        >
          <Trans>Request access</Trans>
        </Button>
      ) : here ? (
        <Button size="sm" onClick={open} data-testid="credential-lock-open">
          <Trans>Open credential</Trans>
        </Button>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void fetch()} data-testid="credential-lock-fetch">
          <Trans>Fetch</Trans>
        </Button>
      )}
    </LockBody>
  );
}
