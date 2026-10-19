import { type ReactNode, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type ChannelRouteTarget,
  type InboundApi,
  type InboundClaim,
  type InboundNumber,
  InboundWebhooks,
  isHubOnly,
  receivedSince,
} from '@sdk';
import { Info, Loader2, Plus } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { CopyButton } from '@src/components/ui/copy-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { AddRuleDialog } from './AddRuleDialog';
import { ConnectNumberDialog } from './ConnectNumberDialog';
import { RouteCheck } from './RouteCheck';
import {
  type DestinationOption,
  INBOUND_PROVIDERS,
  PROVIDER_TITLE,
  claimTitle,
  clockTime,
  destinationOptions,
  optionFor,
} from './inbound-model';
import { errorText, useDestinationLabels, useHereInstance, useInboundChannels, useInboundClaims } from './use-inbound';

type RuleEdit = { number: InboundClaim; rule: InboundClaim | null };

/**
 * Inbound — every number, bot and app that sends the signed-in person messages, and where each message goes.
 * One screen for the hub page and the desktop: it reads and writes only the hub's `webhook` chain; on a desktop
 * "This computer" is one more place to point a claim at.
 */
export function InboundView({ api = InboundWebhooks }: { api?: InboundApi }) {
  const { t } = useLingui();
  const { numbers, error, loading, refresh, openedAt } = useInboundClaims(api);
  const here = useHereInstance(api);
  const channels = useInboundChannels(!isHubOnly());
  const labels = useDestinationLabels();
  const [vendor, setVendor] = useState<string>('all');
  const [connectOpen, setConnectOpen] = useState(false);
  const [ruleEdit, setRuleEdit] = useState<RuleEdit | null>(null);
  const [checking, setChecking] = useState<InboundNumber | null>(null);
  const [removing, setRemoving] = useState<{ claim: InboundClaim; rules: number; isRule: boolean } | null>(null);

  const optionsFor = useMemo(
    () =>
      (provider: string, withDefault: boolean): DestinationOption[] =>
        destinationOptions(provider, channels, here, labels, { withDefault }),
    [channels, here, labels],
  );
  const numberOptionsFor = useMemo(() => (provider: string) => optionsFor(provider, false), [optionsFor]);

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const n of numbers) by[n.claim.provider] = (by[n.claim.provider] ?? 0) + 1;
    return by;
  }, [numbers]);
  const shown = vendor === 'all' ? numbers : numbers.filter((n) => n.claim.provider === vendor);

  const placeOf = (target: ChannelRouteTarget | undefined, provider: string, isRule: boolean) => {
    const listed = optionFor(target, optionsFor(provider, isRule));
    if (listed) return { label: listed.label, detail: listed.detail };
    const kind = target?.kind ?? 'none';
    if (kind === 'none') {
      return isRule
        ? { label: labels.defaultLabel, detail: labels.defaultDetail }
        : { label: t`Nowhere yet`, detail: t`Pick a fallback — until then nothing no rule matches is delivered` };
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
      notify.error({ title: errorText(e) });
    }
  };

  const editing = ruleEdit;
  const editingIsFallback = !!editing?.rule && editing.rule.id === editing.number.id;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10" data-testid="inbound-view">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">
            <Trans>Inbound</Trans>
          </h1>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Every number, bot and app that sends you messages — and where each message goes. Agents and deployments
              only receive.
            </Trans>
          </p>
        </div>
        <Button data-testid="inbound-connect" onClick={() => setConnectOpen(true)}>
          <Plus className="size-4" />
          <Trans>Connect a number</Trans>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Chip active={vendor === 'all'} testId="inbound-filter-all" onClick={() => setVendor('all')}>
          <Trans>All {numbers.length}</Trans>
        </Chip>
        {INBOUND_PROVIDERS.map((p) => (
          <Chip key={p} active={vendor === p} testId={`inbound-filter-${p}`} onClick={() => setVendor(p)}>
            {PROVIDER_TITLE[p]} {counts[p] ?? 0}
          </Chip>
        ))}
      </div>

      {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      {error && (
        <p className="text-sm text-destructive" data-testid="inbound-error">
          {error}
        </p>
      )}
      {!loading && !error && shown.length === 0 && (
        <div
          className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground"
          data-testid="inbound-empty"
        >
          <Trans>
            No numbers yet. Connect one: messages arrive at the hub and go where its rules — or its fallback — say.
          </Trans>
        </div>
      )}

      {shown.map((n) => (
        <NumberCard
          key={n.claim.id}
          number={n}
          openedAt={openedAt}
          placeOf={placeOf}
          onAddRule={() => setRuleEdit({ number: n.claim, rule: null })}
          onEditRule={(rule) => setRuleEdit({ number: n.claim, rule })}
          onRemoveRule={(rule) => setRemoving({ claim: rule, rules: 0, isRule: true })}
          onCheck={() => setChecking(n)}
          onRemove={() => setRemoving({ claim: n.claim, rules: n.rules.length, isRule: false })}
        />
      ))}

      {!isHubOnly() && (
        <p className="text-xs text-muted-foreground">
          <Trans>
            The same screen as on the hub: it lists the hub's claims you own; "This computer" is just one of the places.
          </Trans>
        </p>
      )}

      <ConnectNumberDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        optionsFor={numberOptionsFor}
        onDone={() => void refresh()}
        api={api}
      />
      {editing && (
        <AddRuleDialog
          open
          onOpenChange={(open) => !open && setRuleEdit(null)}
          number={editing.number}
          rule={editing.rule}
          options={optionsFor(editing.number.provider, !editingIsFallback)}
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

function NumberCard({
  number,
  openedAt,
  placeOf,
  onAddRule,
  onEditRule,
  onRemoveRule,
  onCheck,
  onRemove,
}: {
  number: InboundNumber;
  openedAt: number;
  placeOf: (
    target: ChannelRouteTarget | undefined,
    provider: string,
    isRule: boolean,
  ) => { label: string; detail: string };
  onAddRule: () => void;
  onEditRule: (rule: InboundClaim) => void;
  onRemoveRule: (rule: InboundClaim) => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const { claim, rules } = number;
  const provider = PROVIDER_TITLE[claim.provider] ?? claim.provider;
  const isOwn = claim.claim?.kind === 'account';
  const all = [claim, ...rules];
  const received = receivedSince(all, openedAt);
  const last = all.flatMap((c) => c.recent ?? []).reduce((max, r) => Math.max(max, r.at), 0);
  const misroutes = all.reduce((n, c) => n + (c.misroutes ?? 0), 0);
  const fallback = placeOf(number.fallback, claim.provider, false);
  const since = clockTime(openedAt);
  const name = claimTitle(claim) || t`waiting for the code`;

  return (
    <div className="rounded-xl border border-border bg-card" data-testid={`inbound-number-${claim.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="font-semibold">
            {provider} · {name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {isOwn ? <Trans>Your own number</Trans> : <Trans>Flowpad's number · linked sender</Trans>} ·{' '}
            <StatusText status={claim.status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500"
            data-testid={`inbound-counter-${claim.id}`}
            data-count={received}
          >
            <Trans>
              live · {received} received since {since}
            </Trans>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Counted live while this page is open — not stored</Trans>
            </TooltipContent>
          </Tooltip>
          <Button size="sm" variant="outline" data-testid="inbound-check-route" onClick={onCheck}>
            <Trans>Check route</Trans>
          </Button>
          <Button size="sm" variant="outline" data-testid="inbound-remove" onClick={onRemove}>
            <Trans>Remove</Trans>
          </Button>
        </div>
      </div>
      {claim.status === 'pending' && claim.code && (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <Trans>Send this code from your phone to link it:</Trans>{' '}
          <code className="font-mono text-foreground">{claim.code}</code>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span>
          <Trans>Webhook URL</Trans>
        </span>
        <code className="truncate font-mono text-foreground" data-testid="inbound-url">
          {claim.url}
        </code>
        <CopyButton value={claim.url} testId="inbound-url-copy" />
        <span className="ms-auto">
          {last ? <Trans>last delivery {clockTime(last)}</Trans> : <Trans>no delivery yet</Trans>} ·{' '}
          <Trans>{misroutes} misroutes</Trans>
        </span>
      </div>
      <div className="border-t border-border">
        <div className="flex items-center justify-between px-4 py-2 text-xs text-muted-foreground">
          <span>
            <Trans>Rules — the most specific wins: sender › group › everything else</Trans>
          </span>
          {isOwn && (
            <Button size="sm" variant="outline" className="h-7" data-testid="inbound-add-rule" onClick={onAddRule}>
              <Trans>+ Add rule</Trans>
            </Button>
          )}
        </div>
        <div className="divide-y border-t border-border">
          {rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              testId={`inbound-rule-row-${rule.claim?.key ?? rule.id}`}
              n={String(i + 1)}
              kind={rule.claim?.kind === 'group' ? t`group` : t`sender`}
              match={claimTitle(rule)}
              place={placeOf(rule.target, claim.provider, true)}
              claim={rule}
              openedAt={openedAt}
              onEdit={() => onEditRule(rule)}
              onRemove={() => onRemoveRule(rule)}
            />
          ))}
          <RuleRow
            testId="inbound-rule-row-fallback"
            n="*"
            kind={t`fallback`}
            match={t`Everything else to this number`}
            place={fallback}
            claim={claim}
            openedAt={openedAt}
            onEdit={() => onEditRule(claim)}
          />
        </div>
      </div>
    </div>
  );
}

function RuleRow({
  n,
  kind,
  match,
  place,
  claim,
  openedAt,
  onEdit,
  onRemove,
  testId,
}: {
  n: string;
  kind: string;
  match: string;
  place: { label: string; detail: string };
  claim: InboundClaim;
  openedAt: number;
  onEdit: () => void;
  onRemove?: () => void;
  testId: string;
}) {
  const own = receivedSince(claim, openedAt);
  return (
    <div
      className="grid items-center gap-3 px-4 py-3 text-sm"
      style={{ gridTemplateColumns: '2rem 5rem 1fr 1.4fr auto' }}
      data-testid={testId}
    >
      <span className="font-mono text-muted-foreground">{n}</span>
      <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{kind}</span>
      <span className="truncate">{match}</span>
      <span className="min-w-0">
        <span className="font-medium" data-testid="inbound-rule-destination">
          {place.label}
        </span>
        <br />
        <span className="text-xs text-muted-foreground">{place.detail}</span>
      </span>
      <span className="ms-auto flex items-center gap-2">
        {onRemove && (
          <span className="text-xs text-muted-foreground" data-testid={`inbound-counter-${claim.id}`} data-count={own}>
            {own}
          </span>
        )}
        <Button size="sm" variant="ghost" className="h-7" data-testid="inbound-rule-edit" onClick={onEdit}>
          <Trans>Change</Trans>
        </Button>
        {onRemove && (
          <Button size="sm" variant="ghost" className="h-7" data-testid="inbound-rule-remove" onClick={onRemove}>
            <Trans>Remove</Trans>
          </Button>
        )}
      </span>
    </div>
  );
}

function StatusText({ status }: { status: InboundClaim['status'] }) {
  if (status === 'pending') return <Trans>waiting to be proven</Trans>;
  if (status === 'lapsed') return <Trans>lapsed</Trans>;
  return <Trans>proven</Trans>;
}

function Chip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}
