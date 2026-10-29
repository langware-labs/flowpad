/**
 * Token sources: only where the caller's money comes from -- the API keys they stored and the
 * budgets they were given (`sourceRows`). Each row says which, with its own left / limit, Allocate
 * where the caller may carve from it, and ⚙ to configure it. What was allocated FROM a source is
 * not a source; the centre lists it under the selected one.
 */
import type { LLMEndpoint } from '@sdk';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronDown, ChevronRight, Plus, Settings } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';

import { FlowIcon } from '@sdk/react/FlowIcon';

import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { cn } from '@src/lib/utils';

import { FundedByChip, SourceName, useResetLabel } from './FundingChain';
import { RenameButton } from './RenameButton';
import { childrenOf, costLeft, sourceRows } from './source-tree';

const PROVIDER_NAME: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' };

const CHIP = 'rounded-full border px-2 py-0.5 text-xs font-medium';
const ALLOCATION_TONE = 'border-foreground/25 bg-foreground/5 text-foreground/80';
const ACTION_CHIP = 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20';

export function TokenSourcesTree({
  endpoints,
  selectedId,
  hiddenTeams,
  onSelect,
  onAllocate,
  onConfigure,
  onAdd,
  onAllEndpoints,
  onRenamed,
}: {
  endpoints: readonly LLMEndpoint[];
  selectedId: string | null;
  /** Teams the caller is in that have no budget — not sources, so only counted. */
  hiddenTeams: number;
  onSelect: (endpoint: LLMEndpoint) => void;
  onAllocate: (endpoint: LLMEndpoint) => void;
  onConfigure: (endpoint: LLMEndpoint) => void;
  onAdd: () => void;
  onAllEndpoints: () => void;
  /** A row was renamed: reload what shows names. */
  onRenamed?: () => void;
}) {
  const { t } = useLingui();
  const resetLabel = useResetLabel();
  const rows = useMemo(() => sourceRows(endpoints), [endpoints]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const kidsOf = (e: LLMEndpoint) => childrenOf(e, endpoints).filter((k) => k.enabled !== false);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** One row, then -- when its allocations are open -- the next level beneath it, indented. */
  const renderRow = (
    e: LLMEndpoint,
    depth: number,
    o: {
      chip: { label: string; tone: string };
      mark: string | null;
      name: string;
      canAllocate: boolean;
      /** A top-level source: its name carries the funding line and its chip names who pays. */
      source?: { label?: string; funded: boolean };
    },
  ): ReactNode => {
    const left = costLeft(e);
    const selected = e.id === selectedId;
    const kids = kidsOf(e);
    const isOpen = open.has(e.id);
    return (
      <Fragment key={e.id}>
        <tr
          data-testid={`source-row-${e.id}`}
          className={cn(
            'border-b last:border-0 hover:bg-accent/40',
            selected && 'bg-accent/30',
            depth > 0 && 'bg-muted/20',
          )}
        >
          <td className="w-full max-w-0 px-2 py-2" title={e.name}>
            <div className="flex min-w-0 items-center" style={{ paddingInlineStart: depth * 20 }}>
              {depth > 0 && <span className="me-1.5 text-muted-foreground">└</span>}
              {o.mark && (o.mark === 'flowpad' || PROVIDER_NAME[o.mark]) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="me-1.5 inline-flex shrink-0" data-testid={`provider-mark-${e.id}`}>
                      <FlowIcon icon={o.mark === 'flowpad' ? 'flowpad.flowpad' : `brands.${o.mark}`} size={16} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {o.mark === 'flowpad' ? (
                      <Trans>Paid by your Flowpad account</Trans>
                    ) : (
                      <Trans>Your {PROVIDER_NAME[o.mark]} API key</Trans>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
              {o.source ? (
                <SourceName endpoint={e} label={o.source.label} selected={selected} onSelect={() => onSelect(e)} />
              ) : (
                <button
                  type="button"
                  className={cn('truncate text-left', selected && 'font-medium')}
                  onClick={() => onSelect(e)}
                >
                  {o.name}
                </button>
              )}
              <RenameButton endpoint={e} onRenamed={onRenamed ?? (() => {})} />
              {kids.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggle(e.id)}
                  aria-expanded={isOpen}
                  className={cn(
                    CHIP,
                    'ms-2 inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    isOpen && 'bg-accent text-foreground',
                  )}
                  data-testid={`allocated-count-${e.id}`}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <Plural value={kids.length} one="# allocation" other="# allocations" />
                </button>
              )}
            </div>
          </td>
          <td className="whitespace-nowrap px-2 py-2">
            {o.source?.funded ? (
              <FundedByChip endpointId={e.id} entryName={e.name} fallback={o.chip} />
            ) : (
              <span className={cn(CHIP, o.chip.tone)} data-testid={`source-type-${e.id}`}>
                {o.chip.label}
              </span>
            )}
          </td>
          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
            {left ? (
              <>
                {formatUsd(Math.max(0, left.remaining))}
                <span className="text-muted-foreground"> / {formatUsd(left.limit)}</span>
                {o.source && resetLabel(left) && (
                  <div className="text-xs font-normal text-muted-foreground" data-testid={`reset-${e.id}`}>
                    {resetLabel(left)}
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                <Trans>no limit</Trans>
              </span>
            )}
          </td>
          <td className="whitespace-nowrap px-2 py-2">
            <div className="flex items-center justify-end gap-2">
              {o.canAllocate && (
                <button
                  type="button"
                  className={cn(CHIP, ACTION_CHIP)}
                  onClick={() => onAllocate(e)}
                  data-testid={`allocate-${e.id}`}
                >
                  <Trans>+ Allocate</Trans>
                </button>
              )}
              <button
                type="button"
                title={t`Configure`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onConfigure(e)}
                data-testid={`configure-${e.id}`}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          </td>
        </tr>
        {isOpen &&
          kids.map((k) =>
            renderRow(k, depth + 1, {
              chip: { label: t`Allocation`, tone: ALLOCATION_TONE },
              mark: null,
              // An unnamed allocation is labelled by the budget it is carved from.
              name: k.name || t`${o.name} allocation`,
              canAllocate: k.canAllocate,
            }),
          )}
      </Fragment>
    );
  };

  return (
    <section className="flex min-h-0 flex-col gap-3" data-testid="token-sources">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="whitespace-nowrap text-sm font-medium">
          <Trans>Token sources</Trans>
        </h2>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onAllEndpoints} data-testid="all-endpoints">
            <Trans>All endpoints</Trans>
            <ArrowUpRight className="h-3 w-3" />
          </Button>
          <Button size="sm" onClick={onAdd} data-testid="add-token-source">
            <Plus className="h-3.5 w-3.5" />
            <Trans>Add new token source</Trans>
          </Button>
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-2 text-left font-medium">
                <Trans>Source</Trans>
              </th>
              <th className="px-2 py-2 text-left font-medium">
                <Trans>Funded by</Trans>
              </th>
              <th className="whitespace-nowrap px-2 py-2 text-right font-medium">
                <Trans>Left / limit</Trans>
              </th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-6 text-center text-xs text-muted-foreground">
                  <Trans>No token sources yet. Add an API key to start.</Trans>
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const e = row.endpoint;
              const chip =
                row.type === 'key'
                  ? { label: t`API key ${e.credential_hint.replace(/^\*+/, '••')}`, tone: TONE.emerald }
                  : row.type === 'unfunded'
                    ? { label: t`No key`, tone: TONE.destructive }
                    : row.flowpadAccount
                      ? { label: t`Flowpad account`, tone: TONE.violet }
                      : { label: t`Received`, tone: TONE.sky };
              const mark = row.flowpadAccount ? 'flowpad' : row.type === 'key' ? e.provider : null;
              return renderRow(e, 0, {
                chip,
                mark,
                name: row.flowpadAccount ? t`Flowpad account` : e.name || t`Unnamed`,
                canAllocate: e.canAllocate && row.type !== 'unfunded',
                source: {
                  label: row.flowpadAccount ? t`Flowpad account` : undefined,
                  funded: row.type === 'received' && !row.flowpadAccount,
                },
              });
            })}
          </tbody>
        </table>
      </div>
      {hiddenTeams > 0 && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="hidden-teams">
          <Trans>{hiddenTeams} teams without a budget are hidden.</Trans>
        </p>
      )}
    </section>
  );
}
