/**
 * One LLM endpoint, as a READ-ONLY asset: what this person may spend, what it lets
 * through, and whether a call down it actually works.
 *
 * Deliberately not the hub's `LlmEndpointDetail`. That screen administers an endpoint —
 * edit, delete, share, the chain tree, per-child usage — and every one of those answers
 * belongs to whoever owns the pool. This one answers a single question for the person
 * holding the budget, so it shows their own row and nothing above it: no chain, no
 * consumers, no `member_default_limits` (the template an org hands its members is the
 * org's business, not a fact about this wallet).
 *
 * The Test button is the SAME component the org page puts on every budget row — one
 * minimal completion down the resolved chain, which is the only honest way to say
 * "this works", since the credential and the limits live on hops this view cannot see.
 */
import { type LLMEndpointOffer, type LLMEndpointTestResult } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { KeyRound, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { FundingProvenance } from '@src/components/llm-endpoints/FundingProvenance';
import { ProviderBadge } from '@src/components/llm-endpoints/LlmEndpointsList';
import { TestEndpointButton } from '@src/components/llm-endpoints/TestEndpointButton';
import { LIMIT_LABELS } from '@src/components/llm-endpoints/LimitsEditor';
import { LIMIT_KEYS } from '@src/components/llm-endpoints/filters-limits-forms';
import { useMyEndpoint } from '@src/components/llm-endpoints/my-endpoints';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatAmount } from '@src/components/llm-endpoints/usage-math';
import { Badge } from '@src/components/ui/badge';

/** One label/value row. `mono` for ids, slugs and numbers. */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-44 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A glob list as chips; nothing at all when the list is empty (the caller says what that means). */
function Globs({ values, testId }: { values: readonly string[]; testId: string }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {values.map((v) => (
        <Badge key={v} variant="secondary" className="font-mono text-[11px]">
          {v}
        </Badge>
      ))}
    </div>
  );
}

/** The budget: every ceiling this endpoint actually carries. An unset limit is not
 *  rendered as "—" — `null` means the ceiling is somebody else's, further up the chain,
 *  and printing a blank row for it invites the reading "unlimited". */
function Budget({ limits }: { limits: LLMEndpointOffer['limits'] }) {
  const { t } = useLingui();
  const set = LIMIT_KEYS.filter((key) => limits?.[key] != null);
  if (set.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="llm-asset-no-limits">
        <Trans>No ceiling of its own — what you may spend is whatever the budget above this one allows.</Trans>
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="llm-asset-limits">
      {set.map((key) => (
        <Field key={key} label={t(LIMIT_LABELS[key])} mono>
          <span data-testid={`llm-asset-limit-${key}`}>{formatAmount(key, limits[key] as number)}</span>
        </Field>
      ))}
    </dl>
  );
}

/** What passes: the model lists, the redirects a narrow wallet uses, and the ceilings
 *  that are not budgets. */
function Models({ filters, models }: { filters: LLMEndpointOffer['filters']; models: Record<string, string> }) {
  const { t } = useLingui();
  const allow = filters?.models_allow ?? [];
  const deny = filters?.models_deny ?? [];
  const aliases = Object.entries(filters?.model_map ?? {}).concat(Object.entries(filters?.aliases ?? {}));
  const tiers = Object.entries(models ?? {});
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm" data-testid="llm-asset-models">
      <Field label={t`Models allowed`}>
        {allow.length > 0 ? (
          <Globs values={allow} testId="llm-asset-models-allow" />
        ) : (
          <span className="text-muted-foreground">
            <Trans>Everything the budget above allows</Trans>
          </span>
        )}
      </Field>
      {deny.length > 0 && (
        <Field label={t`Models denied`}>
          <Globs values={deny} testId="llm-asset-models-deny" />
        </Field>
      )}
      {aliases.length > 0 && (
        <Field label={t`Redirected to`} mono>
          <div className="space-y-0.5" data-testid="llm-asset-aliases">
            {aliases.map(([from, to]) => (
              <div key={`${from}->${to}`}>
                {from} → {to}
              </div>
            ))}
          </div>
        </Field>
      )}
      {tiers.length > 0 && (
        <Field label={t`Model per tier`} mono>
          <div className="space-y-0.5" data-testid="llm-asset-tiers">
            {tiers.map(([tier, slug]) => (
              <div key={tier}>
                {tier}: {slug}
              </div>
            ))}
          </div>
        </Field>
      )}
      {filters?.max_tokens_ceiling != null && (
        <Field label={t`Max tokens per call`} mono>
          {filters.max_tokens_ceiling}
        </Field>
      )}
      {filters?.max_input_chars != null && (
        <Field label={t`Max input characters`} mono>
          {filters.max_input_chars}
        </Field>
      )}
      {filters?.streaming && filters.streaming !== 'allow' && (
        <Field label={t`Streaming`} mono>
          {filters.streaming}
        </Field>
      )}
    </dl>
  );
}

export interface LlmEndpointAssetViewProps {
  /** The endpoint's typeid (`llm_endpoint-<uuid>`) or its bare uuid. */
  value: string;
}

export function LlmEndpointAssetView({ value }: LlmEndpointAssetViewProps) {
  const { t } = useLingui();
  const { endpoint, isLoading } = useMyEndpoint(value);
  // Mirrored out of the Test button so the provenance below can name what the run spent. A
  // tick on its own says a call worked, not whose key worked — see `FundingProvenance`.
  const [verdict, setVerdict] = useState<LLMEndpointTestResult | null>(null);
  // The type's glyph comes from the backend registry, never a literal (CLAUDE.md's icon law).
  const EndpointIcon = iconForType('llm_endpoint');

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  if (!endpoint) {
    // Not an error: the listing is what the hub says this person may spend, so an id that
    // is not in it is a budget that was revoked, was never theirs, or belongs to a hub
    // this box is signed out of.
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="llm-asset-missing">
        <div className="max-w-sm space-y-2 text-center">
          <EndpointIcon className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            <Trans>This budget is not available to you</Trans>
          </p>
          <p className="text-sm text-muted-foreground">
            <Trans>
              It is no longer one of the endpoints the hub lists for you — or this machine is signed out of the hub.
            </Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4" data-testid="llm-endpoint-asset-view">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <EndpointIcon className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold" data-testid="llm-asset-name">
            {endpoint.name || endpoint.id}
          </h2>
          <ProviderBadge provider={endpoint.provider} />
          {!endpoint.enabled && (
            <Badge variant="outline" className={TONE.amber} data-testid="llm-asset-disabled">
              <Trans>disabled</Trans>
            </Badge>
          )}
          <Badge variant="outline" className="gap-1" title={t`Budgets are administered on the hub`}>
            <Lock className="h-3 w-3" />
            <Trans>read only</Trans>
          </Badge>
          <span className="flex-1" />
          <TestEndpointButton endpointId={endpoint.id} onVerdict={setVerdict} />
        </div>

        <FundingProvenance endpoint={endpoint} verdict={verdict} />

        <Section title={<Trans>Budget</Trans>}>
          <Budget limits={endpoint.limits} />
        </Section>

        <Section title={<Trans>Models</Trans>}>
          <Models filters={endpoint.filters} models={endpoint.models} />
        </Section>

        <Section title={<Trans>Details</Trans>}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Field label={t`Provider`} mono>
              {endpoint.provider || '—'}
            </Field>
            <Field label={t`Endpoint id`} mono>
              {endpoint.id}
            </Field>
            {endpoint.credential_hint && (
              <Field label={t`Key`} mono>
                <span className="inline-flex items-center gap-1" data-testid="llm-asset-credential">
                  <KeyRound className="h-3 w-3" />
                  {endpoint.credential_hint}
                </span>
              </Field>
            )}
            {endpoint.system_default && (
              <Field label={t`Origin`}>
                <Trans>Given to you by the hub</Trans>
              </Field>
            )}
          </dl>
        </Section>
      </div>
    </div>
  );
}
