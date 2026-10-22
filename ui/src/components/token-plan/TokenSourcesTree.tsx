/**
 * Token sources: only where the caller's money comes from -- the API keys they stored and the
 * budgets they were given (`sourceRows`). Each row says which, with its own left / limit, Allocate
 * where the caller may carve from it, and ⚙ to configure it. What was allocated FROM a source is
 * not a source; the centre lists it under the selected one.
 */
import type { LLMEndpoint } from '@sdk';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';

import { FlowIcon } from '@sdk/react/FlowIcon';

import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { cn } from '@src/lib/utils';

import { childrenOf, costLeft, sourceRows } from './source-tree';

const PROVIDER_NAME: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' };

const CHIP = 'rounded-full border px-2 py-0.5 text-xs font-medium';
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
}) {
  const { t } = useLingui();
  const rows = useMemo(() => sourceRows(endpoints), [endpoints]);
  const allocated = (e: LLMEndpoint) => childrenOf(e, endpoints).filter((k) => k.enabled !== false).length;

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
              const left = costLeft(e);
              const selected = e.id === selectedId;
              const chip =
                row.type === 'key'
                  ? { label: t`API key ${e.credential_hint.replace(/^\*+/, '••')}`, tone: TONE.emerald }
                  : row.type === 'unfunded'
                    ? { label: t`No key`, tone: TONE.destructive }
                    : row.flowpadAccount
                      ? { label: t`Flowpad account`, tone: TONE.violet }
                      : { label: t`Received`, tone: TONE.sky };
              const mark = row.flowpadAccount ? 'flowpad' : row.type === 'key' ? e.provider : null;
              return (
                <tr
                  key={e.id}
                  data-testid={`source-row-${e.id}`}
                  className={cn('border-b last:border-0 hover:bg-accent/40', selected && 'bg-accent/30')}
                >
                  <td className="w-full max-w-0 px-2 py-2" title={e.name}>
                    <div className="flex min-w-0 items-center">
                      {mark && (mark === 'flowpad' || PROVIDER_NAME[mark]) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="me-1.5 inline-flex shrink-0" data-testid={`provider-mark-${e.id}`}>
                              <FlowIcon icon={mark === 'flowpad' ? 'flowpad.flowpad' : `brands.${mark}`} size={16} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {mark === 'flowpad' ? (
                              <Trans>Paid by your Flowpad account</Trans>
                            ) : (
                              <Trans>Your {PROVIDER_NAME[mark]} API key</Trans>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <button
                        type="button"
                        className={cn('truncate text-left', selected && 'font-medium')}
                        onClick={() => onSelect(e)}
                      >
                        {row.flowpadAccount ? t`Flowpad account` : e.name || t`Unnamed`}
                      </button>
                      {allocated(e) > 0 && (
                        <span
                          className="ms-1.5 whitespace-nowrap text-xs text-muted-foreground"
                          data-testid={`allocated-count-${e.id}`}
                        >
                          <Plural value={allocated(e)} one="· # allocation" other="· # allocations" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <span className={cn(CHIP, chip.tone)} data-testid={`source-type-${e.id}`}>
                      {chip.label}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                    {left ? (
                      <>
                        {formatUsd(Math.max(0, left.remaining))}
                        <span className="text-muted-foreground"> / {formatUsd(left.limit)}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        <Trans>no limit</Trans>
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <div className="flex items-center justify-end gap-2">
                      {e.canAllocate && row.type !== 'unfunded' && (
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
              );
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
