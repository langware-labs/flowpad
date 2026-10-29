/**
 * Where a token source's money comes from, as far as the caller may see it: the `chain` report's first
 * path, entry → root. A level the caller may not read arrives narrowed (kind + team/org name only) and
 * is shown that way; deeper levels they may not read are not sent at all, so they are not drawn.
 */
import type { LLMChainRemaining, LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Users } from 'lucide-react';
import { Fragment } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { useLlmEndpointChain } from '@src/components/llm-endpoints/use-llm-endpoints';
import { cn } from '@src/lib/utils';

import {
  fundedBy,
  funderName,
  fundingPath,
  hopCostLeft,
  resetOf,
  tightestLeft,
  type FundingHop,
  type FundingKind,
} from './source-tree';

const PROVIDER_NAME: Record<string, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  vertex: 'Vertex',
};

const CHIP = 'rounded-full border px-2 py-0.5 text-xs font-medium';

/** The caller's view of one endpoint's funding path (empty while the chain loads). */
export function useFunding(endpointId: string | null | undefined) {
  const { data } = useLlmEndpointChain(endpointId ?? undefined);
  const path = fundingPath(data);
  return { path, funder: fundedBy(path) };
}

function useKindLabel() {
  const { t } = useLingui();
  const label: Record<FundingKind, string> = {
    me: t`You`,
    team: t`Team`,
    org: t`Org`,
    global: t`Flowpad`,
    root: t`Root`,
    endpoint: t`Budget`,
  };
  return (kind: FundingKind) => label[kind];
}

/** "per day · resets 00:00 UTC", "lifetime · never resets" — the window a limit is judged over. */
export function useResetLabel() {
  const { t } = useLingui();
  return (r: Pick<LLMChainRemaining, 'window' | 'resets_at'> | null | undefined): string | null => {
    const reset = resetOf(r);
    if (!reset) return null;
    if (!reset.utc) return t`lifetime · never resets`;
    const at = reset.utc;
    switch (reset.window) {
      case 'day':
        return t`per day · resets ${at} UTC`;
      case 'week':
        return t`per week · resets ${at} UTC`;
      case 'month':
        return t`per month · resets ${at} UTC`;
      default:
        return t`resets ${at} UTC`;
    }
  };
}

/** A source's label: its own name, else "<who funds it> allowance", else "Unnamed". */
export function useSourceLabel() {
  const { t } = useLingui();
  return (endpoint: Pick<LLMEndpoint, 'name'>, funder: FundingHop | null): { text: string; fallback: boolean } => {
    if (endpoint.name) return { text: endpoint.name, fallback: false };
    const who = funderName(funder);
    return { text: who ? t`${who} allowance` : t`Unnamed`, fallback: true };
  };
}

/** "Dev Team budget › Langware budget · Vertex": the readable levels above the entry. */
export function chainLine(path: readonly FundingHop[]): string {
  const above = path.slice(1);
  const names = above.map((h) => h.name || h.scopeName || '').filter(Boolean);
  const root = above[above.length - 1];
  const provider =
    root && !root.redacted && root.hop.provider ? PROVIDER_NAME[root.hop.provider] || root.hop.provider : '';
  const joined = names.join(' › ');
  // A root named after its provider ("OpenRouter (global)") does not need the provider again.
  return [joined, provider && !joined.includes(provider) ? provider : ''].filter(Boolean).join(' · ');
}

/** Every level of `path`, nearest first, with its left / limit, bar and reset. */
export function FundingHops({ path, entryLabel }: { path: readonly FundingHop[]; entryLabel?: string }) {
  const kindLabel = useKindLabel();
  const resetLabel = useResetLabel();
  return (
    <div data-testid="funding-hops">
      {path.map((h, i) => {
        const left = hopCostLeft(h.hop);
        const badge = h.scopeName && h.kind !== 'me' ? `${kindLabel(h.kind)} · ${h.scopeName}` : kindLabel(h.kind);
        const name = i === 0 && entryLabel ? entryLabel : h.name;
        const provider = h.hop.is_root && h.hop.provider ? PROVIDER_NAME[h.hop.provider] || h.hop.provider : null;
        const spent = left ? formatUsd(left.used) : null;
        const extra = provider ? (
          <Trans>pays with a {provider} key</Trans>
        ) : spent ? (
          <Trans>spent {spent}</Trans>
        ) : null;
        return (
          <Fragment key={h.id}>
            {i > 0 && (
              <div className="ps-3 text-xs text-muted-foreground">
                <Trans>↑ draws from</Trans>
              </div>
            )}
            <div className="space-y-1 py-2" data-testid={`funding-hop-${h.kind}`}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0 truncate">
                  <span className="me-2 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {badge}
                  </span>
                  {name}
                </div>
                {left && (
                  <div className="whitespace-nowrap tabular-nums">
                    {formatUsd(Math.max(0, left.remaining))}
                    <span className="text-muted-foreground"> / {formatUsd(left.limit)}</span>
                  </div>
                )}
              </div>
              {h.redacted ? (
                <div className="text-xs text-muted-foreground" data-testid="funding-hop-redacted">
                  <Trans>Its budget is not shared with you.</Trans>
                </div>
              ) : (
                <>
                  {left && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-primary/20">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${Math.min(100, (left.used / (left.limit || 1)) * 100)}%` }}
                      />
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {left ? resetLabel(left) : <Trans>no limit</Trans>}
                    {extra && <> · {extra}</>}
                  </div>
                </>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** The "Funded by" cell: who pays, as a chip that opens the whole readable path. */
export function FundedByChip({
  endpointId,
  entryName,
  fallback,
}: {
  endpointId: string;
  /** The source's own name (may be empty — the funder-based fallback is used then). */
  entryName: string;
  /** What to show when the chain names no funder (still loading, or a root). */
  fallback: { label: string; tone: string };
}) {
  const { path, funder } = useFunding(endpointId);
  const entryLabel = useSourceLabel()({ name: entryName }, funder).text;
  const tight = tightestLeft(path);
  const hidden = path.some((h) => h.redacted);
  if (!funder) {
    return (
      <span className={cn(CHIP, fallback.tone)} data-testid={`source-type-${endpointId}`}>
        {fallback.label}
      </span>
    );
  }
  const amount = tight == null ? null : formatUsd(tight);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(CHIP, TONE.sky, 'inline-flex items-center gap-1 hover:bg-sky-500/20')}
          data-testid={`source-type-${endpointId}`}
        >
          {(funder.kind === 'team' || funder.kind === 'org') && <Users className="h-3 w-3" />}
          {funderName(funder)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem]" align="start" data-testid="chain-popover">
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          <Trans>Funded through</Trans>
        </div>
        <FundingHops path={path} entryLabel={entryLabel} />
        {amount && (
          <div className="mt-2 border-t pt-2 text-xs text-muted-foreground" data-testid="chain-tightest">
            {hidden ? (
              <Trans>
                You can spend up to <span className="text-foreground">{amount}</span> of your own limit; the levels
                above may stop you sooner.
              </Trans>
            ) : (
              <Trans>
                You can spend up to <span className="text-foreground">{amount}</span> — the tightest limit on this path.
              </Trans>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The selected row's "Funded through" card. */
export function FundedThroughCard({ endpointId, entryName }: { endpointId: string; entryName: string }) {
  const { path, funder } = useFunding(endpointId);
  const entryLabel = useSourceLabel()({ name: entryName }, funder).text;
  if (path.length < 2) return null;
  return (
    <section className="rounded-xl border bg-card p-5" data-testid="funded-through">
      <div className="mb-1 text-sm font-medium">
        <Trans>Funded through</Trans>
      </div>
      <FundingHops path={path} entryLabel={entryLabel} />
    </section>
  );
}

/** The grey line under a source's name, and its fallback-aware name. */
export function SourceName({
  endpoint,
  label,
  selected,
  onSelect,
}: {
  endpoint: LLMEndpoint;
  /** An override (the Flowpad account) — else the name, or the funder-based fallback. */
  label?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { path, funder } = useFunding(endpoint.id);
  const sourceLabel = useSourceLabel();
  const shown = label ? { text: label, fallback: false } : sourceLabel(endpoint, funder);
  const line = chainLine(path);
  return (
    <div className="min-w-0">
      <button
        type="button"
        className={cn(
          'block max-w-full truncate text-left',
          selected && 'font-medium',
          shown.fallback && 'italic text-muted-foreground',
        )}
        onClick={onSelect}
        data-testid={`source-name-${endpoint.id}`}
      >
        {shown.text}
      </button>
      {line && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground" data-testid={`chain-line-${endpoint.id}`}>
          {line}
        </div>
      )}
    </div>
  );
}
