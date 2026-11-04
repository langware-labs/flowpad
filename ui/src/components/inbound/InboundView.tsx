import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type Agent,
  type ChannelRouteTarget,
  type InboundApi,
  PageId,
  ViewType,
  type InboundClaim,
  type InboundNumber,
  InboundWebhooks,
  isHubOnly,
} from '@sdk';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { CopyButton } from '@src/components/ui/copy-button';
import { notify } from '@src/notifications';
import { errorMessage } from '@src/lib/error-message';
import { AddRuleDialog } from './AddRuleDialog';
import { ConnectNumberDialog } from './ConnectNumberDialog';
import { Chip } from './Chip';
import { AllowedSendersEditor } from '@src/components/agents/AllowedSendersEditor';
import { RouteCheck } from './RouteCheck';
import {
  type DestinationOption,
  INBOUND_PROVIDERS,
  PROVIDER_TITLE,
  claimTitle,
  destinationOptions,
  optionFor,
} from './inbound-model';
import { useDestinationLabels, useInboundChannels, useInboundClaims } from './use-inbound';
import { mailboxPointer, parseRoutingPointer, type InboundMailbox, useInboundMailboxes } from './use-inbound-mailboxes';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

type RuleEdit = { number: InboundClaim; rule: InboundClaim | null };

/**
 * Inbound — every number, bot and app that sends the signed-in person messages, and where each message goes.
 * One screen for the hub page and the desktop: it reads and writes only the hub's `webhook` chain; on a desktop
 * "This computer" is one more place to point a claim at.
 */
export function InboundView({ api = InboundWebhooks, pointer }: { api?: InboundApi; pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { agents, mailboxes, refresh: refreshMailboxes, patch: patchMailbox } = useInboundMailboxes();
  const page = isHubOnly() ? PageId.HUB : PageId.DESK;
  // Click → URL only: the Routing page is the pointer (`<claim id>` or `mailbox-<agent id>`).
  const openRouting = (id: string | null) => navigation.openPage(page, ViewType.INBOUND, id ?? undefined);
  const { numbers, error, loading, refresh } = useInboundClaims(api);
  const channels = useInboundChannels(!isHubOnly());
  const here = channels.find((c) => c.instanceId)?.instanceId ?? null;
  const labels = useDestinationLabels();
  const [vendor, setVendor] = useState<string>('all');
  const [connectOpen, setConnectOpen] = useState(false);
  const [ruleEdit, setRuleEdit] = useState<RuleEdit | null>(null);
  const [checking, setChecking] = useState<InboundNumber | null>(null);
  const [removing, setRemoving] = useState<{ claim: InboundClaim; rules: number; isRule: boolean } | null>(null);

  // Built once per vendor and default flag, not per row on every render.
  const optionsFor = useMemo(() => {
    const cache = new Map<string, DestinationOption[]>();
    return (provider: string, withDefault = true): DestinationOption[] => {
      const key = `${provider}:${withDefault}`;
      if (!cache.has(key)) cache.set(key, destinationOptions(provider, channels, labels, { withDefault }));
      return cache.get(key)!;
    };
  }, [channels, labels]);
  const numberOptionsFor = useCallback((provider: string) => optionsFor(provider, false), [optionsFor]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const n of numbers) by[n.claim.provider] = (by[n.claim.provider] ?? 0) + 1;
    return by;
  }, [numbers]);
  const shown = vendor === 'all' ? numbers : numbers.filter((n) => n.claim.provider === vendor);
  const shownMailboxes = vendor === 'all' || vendor === 'email' ? mailboxes : [];

  const placeOf = (target: ChannelRouteTarget | undefined, provider: string, isRule: boolean) => {
    const listed = optionFor(target, optionsFor(provider, isRule));
    if (listed) return { label: listed.label, detail: listed.detail };
    const kind = target?.kind ?? 'none';
    if (kind === 'none') {
      return isRule
        ? { label: labels.defaultLabel, detail: labels.defaultDetail }
        : { label: t`Ignore`, detail: t`Default — dropped unless a rule matches` };
    }
    const channel = labels.channel(target?.data_source_id ?? '');
    if (kind === 'desktop') {
      const where = target?.instance_id && target.instance_id === here ? labels.thisComputer : t`Another computer`;
      return { label: where, detail: `${target?.instance_id ?? ''} · ${channel}` };
    }
    return { label: t`Machine`, detail: `${target?.node_typeid ?? ''} · ${channel}` };
  };

  const remove = async (claim: InboundClaim) => {
    try {
      await api.remove(claim.id);
      await refresh();
    } catch (e) {
      notify.error({ title: errorMessage(e, String(e)) });
    }
  };

  const editingIsFallback = !!ruleEdit?.rule && ruleEdit.rule.id === ruleEdit.number.id;

  const routed = parseRoutingPointer(pointer);
  const routedNumber = routed?.kind === 'number' ? (numbers.find((n) => n.claim.id === routed.id) ?? null) : null;
  const routedMailbox =
    routed?.kind === 'mailbox' ? (mailboxes.find((m) => m.agentId === routed.agentId) ?? null) : null;

  const routing = pointer ? (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight" data-testid="inbound-routing-title">
            <Trans>Routing</Trans>
            {routedNumber &&
              ` · ${PROVIDER_TITLE[routedNumber.claim.provider] ?? routedNumber.claim.provider} · ${claimTitle(routedNumber.claim) || t`waiting for the code`}`}
            {routedMailbox && ` · ${t`Email`} · ${routedMailbox.address}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {routedMailbox ? (
              <Trans>Flowpad mailbox · only allowed senders reach {routedMailbox.agentName}</Trans>
            ) : (
              <Trans>The most specific rule wins: in a group the group, else the sender, else everything else</Trans>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {routedNumber && (
            <>
              <Button
                size="sm"
                variant="ghost"
                data-testid="inbound-check-route"
                onClick={() => setChecking(routedNumber)}
              >
                <Trans>Check route</Trans>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="inbound-remove"
                onClick={() =>
                  setRemoving({ claim: routedNumber.claim, rules: routedNumber.rules.length, isRule: false })
                }
              >
                <Trans>Remove</Trans>
              </Button>
            </>
          )}
          <Button size="sm" variant="outline" data-testid="inbound-routing-back" onClick={() => openRouting(null)}>
            <Trans>← Channels</Trans>
          </Button>
        </div>
      </div>
      {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      {!loading && !routedNumber && !routedMailbox && (
        <p className="text-sm text-muted-foreground" data-testid="inbound-routing-missing">
          <Trans>This channel is not yours, or it is gone.</Trans>
        </p>
      )}
      {routedNumber && (
        <NumberRouting
          number={routedNumber}
          placeOf={placeOf}
          onAddRule={() => setRuleEdit({ number: routedNumber.claim, rule: null })}
          onEditRule={(rule) => setRuleEdit({ number: routedNumber.claim, rule })}
          onRemoveRule={(rule) => setRemoving({ claim: rule, rules: 0, isRule: true })}
        />
      )}
      {routedMailbox && (
        <MailboxRouting
          mailbox={routedMailbox}
          agent={agents.find((a) => String(a.id) === routedMailbox.agentId) ?? null}
          onSaved={(allowedSenders) => patchMailbox(routedMailbox.agentId, { allowedSenders })}
        />
      )}
    </>
  ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10" data-testid="inbound-view">
      {routing ?? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-bold tracking-tight">
                <Trans>Channels</Trans>
              </h1>
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Every number, bot and app that sends you messages — and where each message goes. Agents and
                  deployments only receive.
                </Trans>
              </p>
            </div>
            <Button data-testid="inbound-connect" onClick={() => setConnectOpen(true)}>
              <Plus className="size-4" />
              <Trans>Add channel</Trans>
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 text-sm">
            <Chip active={vendor === 'all'} testId="inbound-filter-all" onClick={() => setVendor('all')}>
              <Trans>All {numbers.length + mailboxes.length}</Trans>
            </Chip>
            {INBOUND_PROVIDERS.map((p) => (
              <Chip key={p} active={vendor === p} testId={`inbound-filter-${p}`} onClick={() => setVendor(p)}>
                {PROVIDER_TITLE[p]} {counts[p] ?? 0}
              </Chip>
            ))}
            <Chip active={vendor === 'email'} testId="inbound-filter-email" onClick={() => setVendor('email')}>
              <Trans>Email {mailboxes.length}</Trans>
            </Chip>
          </div>

          {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
          {error && (
            <p className="text-sm text-destructive" data-testid="inbound-error">
              {error}
            </p>
          )}
          {!loading && !error && shown.length === 0 && shownMailboxes.length === 0 && (
            <div
              className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground"
              data-testid="inbound-empty"
            >
              <Trans>
                No channels yet. Add one: messages arrive at the hub and go where its rules say — anything else is
                ignored.
              </Trans>
            </div>
          )}

          {!loading && !error && (shown.length > 0 || shownMailboxes.length > 0) && (
            <div className="divide-y rounded-xl border border-border bg-card" data-testid="inbound-channel-list">
              {shown.map((n) => (
                <ChannelRow
                  key={n.claim.id}
                  testId={`inbound-channel-${n.claim.id}`}
                  name={`${PROVIDER_TITLE[n.claim.provider] ?? n.claim.provider} · ${claimTitle(n.claim) || t`waiting for the code`}`}
                  info={`${n.claim.claim?.kind === 'account' ? t`Your own number` : t`Flowpad's number · linked sender`} · ${
                    n.rules.length === 1 ? t`1 rule` : t`${n.rules.length} rules`
                  }`}
                  onRouting={() => openRouting(n.claim.id)}
                />
              ))}
              {shownMailboxes.map((m) => (
                <ChannelRow
                  key={m.agentId}
                  testId={`inbound-channel-mailbox-${m.agentId}`}
                  name={`${t`Email`} · ${m.address}`}
                  info={`${t`Flowpad mailbox`} · ${t`answered by ${m.agentName}`} · ${
                    m.allowedSenders.length === 1 ? t`1 allowed sender` : t`${m.allowedSenders.length} allowed senders`
                  }`}
                  onRouting={() => openRouting(mailboxPointer(m.agentId))}
                />
              ))}
            </div>
          )}

          {!isHubOnly() && (
            <p className="text-xs text-muted-foreground">
              <Trans>
                The same screen as on the hub: it lists the hub's claims you own; "This computer" is just one of the
                places.
              </Trans>
            </p>
          )}
        </>
      )}
      <ConnectNumberDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        optionsFor={numberOptionsFor}
        // One mailbox per agent: only an agent without one can be given one.
        agents={agents.filter((a) => !mailboxes.some((m) => m.agentId === String(a.id)))}
        onDone={() => {
          void refresh();
          void refreshMailboxes();
        }}
        api={api}
      />
      {ruleEdit && (
        <AddRuleDialog
          open
          onOpenChange={(open) => !open && setRuleEdit(null)}
          number={ruleEdit.number}
          rule={ruleEdit.rule}
          options={optionsFor(ruleEdit.number.provider, !editingIsFallback)}
          onDone={() => void refresh()}
          api={api}
        />
      )}
      {checking && (
        <RouteCheck
          open
          onOpenChange={(open) => !open && setChecking(null)}
          number={checking}
          api={api}
          onChangeDestination={(claimId) => {
            const rule = [...checking.rules, checking.claim].find((c) => c.id === claimId) ?? null;
            setChecking(null);
            setRuleEdit({ number: checking.claim, rule });
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        testId="inbound-remove-confirm"
        variant="destructive"
        title={removing?.isRule ? t`Remove rule` : t`Remove number`}
        description={
          removing && removing.rules > 0
            ? t`Remove this number and its ${removing.rules} rules? The hub stops taking its traffic now; your server will get 404 until you point it elsewhere. The agents and their channels stay.`
            : t`Remove this? The hub stops routing its messages now. The agents and their channels stay.`
        }
        confirmLabel={t`Remove`}
        cancelLabel={t`Cancel`}
        onConfirm={() => removing && void remove(removing.claim)}
      />
    </div>
  );
}

/** The rules grid: "when the message is from" · "goes to" · actions — one layout for every channel kind. */
const RULE_COLUMNS = { gridTemplateColumns: '1fr 1fr auto' };

function RuleTable({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="divide-y rounded-xl border border-border bg-card" data-testid={testId}>
      <div className="grid gap-3 px-4 py-2 text-xs text-muted-foreground" style={RULE_COLUMNS}>
        <span>
          <Trans>When the message is from</Trans>
        </span>
        <span>
          <Trans>Goes to</Trans>
        </span>
        <span />
      </div>
      {children}
    </div>
  );
}

/** One channel in the list: its name, one line about it, and the way into its routing. */
function ChannelRow({
  name,
  info,
  onRouting,
  testId,
}: {
  name: string;
  info: string;
  onRouting: () => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" data-testid={testId}>
      <div className="min-w-0">
        <div className="truncate font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">{info}</div>
      </div>
      <Button size="sm" variant="outline" data-testid="inbound-routing" onClick={onRouting}>
        <Trans>Routing</Trans>
      </Button>
    </div>
  );
}

/** A number's routing: its rules, then "anyone else" (the number's own place — Ignore until set). */
function NumberRouting({
  number,
  placeOf,
  onAddRule,
  onEditRule,
  onRemoveRule,
}: {
  number: InboundNumber;
  placeOf: (
    target: ChannelRouteTarget | undefined,
    provider: string,
    isRule: boolean,
  ) => { label: string; detail: string };
  onAddRule: () => void;
  onEditRule: (rule: InboundClaim) => void;
  onRemoveRule: (rule: InboundClaim) => void;
}) {
  const { t } = useLingui();
  const { claim, rules } = number;
  const isOwn = claim.claim?.kind === 'account';
  return (
    <>
      {claim.status === 'pending' && claim.code && (
        <p className="text-sm text-muted-foreground">
          <Trans>Send this code from your phone to link it:</Trans>{' '}
          <code className="font-mono text-foreground">{claim.code}</code>
        </p>
      )}
      <RuleTable testId={`inbound-number-${claim.id}`}>
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            testId={`inbound-rule-row-${rule.claim?.key ?? rule.id}`}
            from={rule.claim?.kind === 'group' ? `${t`Group`} · ${claimTitle(rule)}` : claimTitle(rule)}
            place={placeOf(rule.target, claim.provider, true)}
            onEdit={() => onEditRule(rule)}
            onRemove={() => onRemoveRule(rule)}
          />
        ))}
        <RuleRow
          testId="inbound-rule-row-fallback"
          from={t`Anyone else`}
          place={placeOf(number.fallback, claim.provider, false)}
          onEdit={() => onEditRule(claim)}
        />
      </RuleTable>
      {isOwn && (
        <div>
          <Button size="sm" variant="outline" data-testid="inbound-add-rule" onClick={onAddRule}>
            <Trans>+ Add rule</Trans>
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          <Trans>Webhook URL</Trans>
        </span>
        <code className="truncate font-mono" data-testid="inbound-url">
          {claim.url}
        </code>
        <CopyButton value={claim.url} testId="inbound-url-copy" />
      </div>
    </>
  );
}

/** A mailbox's routing: its agent answers the allowed senders; anyone else is ignored (empty list = nobody). */
function MailboxRouting({
  mailbox,
  agent,
  onSaved,
}: {
  mailbox: InboundMailbox;
  agent: Agent | null;
  onSaved: (allowedSenders: string[]) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <RuleTable testId={`inbound-mailbox-${mailbox.agentId}`}>
        <RuleRow
          testId="inbound-mailbox-allowed"
          from={t`An allowed sender`}
          place={{ label: mailbox.agentName, detail: '' }}
        />
        <RuleRow testId="inbound-mailbox-else" from={t`Anyone else`} place={{ label: t`Ignore`, detail: '' }} />
      </RuleTable>
      <AllowedSendersEditor
        agent={agent}
        allowedSenders={mailbox.allowedSenders}
        onSaved={onSaved}
        testId="inbound-mailbox"
      />
    </>
  );
}

function RuleRow({
  from,
  place,
  onEdit,
  onRemove,
  testId,
}: {
  from: string;
  place: { label: string; detail: string };
  onEdit?: () => void;
  onRemove?: () => void;
  testId: string;
}) {
  return (
    <div className="grid items-center gap-3 px-4 py-3 text-sm" style={RULE_COLUMNS} data-testid={testId}>
      <span className="truncate">{from}</span>
      <span className="min-w-0">
        <span className="font-medium" data-testid="inbound-rule-destination">
          {place.label}
        </span>
        {place.detail && <span className="block truncate text-xs text-muted-foreground">{place.detail}</span>}
      </span>
      <span className="ms-auto flex items-center gap-2">
        {onEdit && (
          <Button size="sm" variant="ghost" className="h-7" data-testid="inbound-rule-edit" onClick={onEdit}>
            <Trans>Change</Trans>
          </Button>
        )}
        {onRemove && (
          <Button size="sm" variant="ghost" className="h-7" data-testid="inbound-rule-remove" onClick={onRemove}>
            <Trans>Remove</Trans>
          </Button>
        )}
      </span>
    </div>
  );
}
