/**
 * Token sources: every budget the caller can reach, as the tree it is (root → org pool → team pool
 * → key), each row with its sponsor, its own left / limit, Allocate where the caller administers it
 * and ⚙ to configure it. Key / Team / Org filter by sponsor; a filtered-out ancestor stays dimmed so
 * the tree still reads.
 */
import type { LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';

import { FlowIcon } from '@sdk/react/FlowIcon';

import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { cn } from '@src/lib/utils';

import { buildSourceTree, visibleRows, costLeft, sponsorOf, type Sponsor, type SponsorFilter } from './source-tree';

/** A root talks to a provider with its own key: its row wears that provider's mark (`brands.<provider>`). */
const PROVIDER_NAME: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' };

const CHIP = 'rounded-full border px-2 py-0.5 text-xs font-medium';

/** One tone per sponsor (the endpoint screens' `TONE`), so the column reads at a glance. */
const SPONSOR_TONE: Record<Sponsor, string> = {
  key: TONE.emerald,
  team: TONE.sky,
  org: TONE.violet,
  shared: 'border-foreground/25 bg-foreground/5 text-foreground/80',
};

/** The row's action, in the primary colour rather than another grey chip. */
const ACTION_CHIP = 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20';

export function TokenSourcesTree({
  endpoints,
  selectedId,
  filter,
  onFilter,
  hiddenTeams,
  onSelect,
  onAllocate,
  onConfigure,
  onAdd,
  onAllEndpoints,
}: {
  endpoints: readonly LLMEndpoint[];
  selectedId: string | null;
  filter: SponsorFilter;
  onFilter: (f: SponsorFilter) => void;
  /** Teams the caller is in that have no budget — not sources, so only counted. */
  hiddenTeams: number;
  onSelect: (endpoint: LLMEndpoint) => void;
  onAllocate: (endpoint: LLMEndpoint) => void;
  onConfigure: (endpoint: LLMEndpoint) => void;
  onAdd: () => void;
  onAllEndpoints: () => void;
}) {
  const { t } = useLingui();
  const tree = useMemo(() => buildSourceTree(endpoints, filter), [endpoints, filter]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed]);
  const parents = tree.filter((r) => r.hasChildren).map((r) => r.endpoint.id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sponsorLabel: Record<Sponsor, string> = { key: t`Key`, team: t`Team`, org: t`Org`, shared: t`Shared` };
  const tabs: { id: SponsorFilter; label: string }[] = [
    { id: 'all', label: t`All` },
    { id: 'key', label: t`Key` },
    { id: 'team', label: t`Team` },
    { id: 'org', label: t`Org` },
  ];

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

      <div className="flex items-center gap-2">
        <div className="flex flex-1 rounded-lg bg-muted p-0.5" role="tablist" data-testid="scope-bar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              onClick={() => onFilter(tab.id)}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-all',
                filter === tab.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t`Expand all`}
          aria-label={t`Expand all`}
          disabled={collapsed.size === 0}
          onClick={() => setCollapsed(new Set())}
          data-testid="expand-all"
        >
          <ChevronsUpDown className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={t`Collapse all`}
          aria-label={t`Collapse all`}
          disabled={parents.length === 0 || collapsed.size === parents.length}
          onClick={() => setCollapsed(new Set(parents))}
          data-testid="collapse-all"
        >
          <ChevronsDownUp className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 overflow-y-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-2 text-left font-medium">
                <Trans>Source</Trans>
              </th>
              <th className="px-2 py-2 text-left font-medium">
                <Trans>Sponsor</Trans>
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
                  <Trans>No token sources here.</Trans>
                </td>
              </tr>
            )}
            {rows.map(({ endpoint: e, depth, hasChildren, dimmed }) => {
              const left = costLeft(e);
              const selected = e.id === selectedId;
              return (
                <tr
                  key={e.id}
                  data-testid={`source-row-${e.id}`}
                  className={cn('border-b last:border-0 hover:bg-accent/40', selected && 'bg-accent/30')}
                  style={dimmed ? { opacity: 0.45 } : undefined}
                >
                  <td className="w-full max-w-0 px-2 py-2" title={e.name}>
                    <div className="flex min-w-0 items-center" style={{ paddingInlineStart: depth * 16 }}>
                      <span className="me-1 inline-flex w-3.5 shrink-0 text-muted-foreground">
                        {hasChildren && (
                          <button
                            type="button"
                            aria-label={collapsed.has(e.id) ? t`Expand ${e.name}` : t`Collapse ${e.name}`}
                            aria-expanded={!collapsed.has(e.id)}
                            onClick={() => toggle(e.id)}
                            className="hover:text-foreground"
                            data-testid={`toggle-${e.id}`}
                          >
                            {collapsed.has(e.id) ? (
                              <ChevronRight className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </span>
                      {e.kind === 'root' && PROVIDER_NAME[e.provider] && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="me-1.5 inline-flex shrink-0" data-testid={`provider-mark-${e.id}`}>
                              <FlowIcon icon={`brands.${e.provider}`} size={16} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <Trans>Root source · {PROVIDER_NAME[e.provider]} key</Trans>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <button
                        type="button"
                        className={cn('truncate text-left', selected && 'font-medium')}
                        onClick={() => onSelect(e)}
                      >
                        {e.name || t`Unnamed`}
                      </button>
                      {e.isMine && (
                        <span className="ms-1 whitespace-nowrap text-xs text-muted-foreground">
                          <Trans>· yours</Trans>
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    <span className={cn(CHIP, SPONSOR_TONE[sponsorOf(e)])}>{sponsorLabel[sponsorOf(e)]}</span>
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
                      {e.canAllocate && (
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
          <Trans>{hiddenTeams} teams without a budget are hidden — Allocate on the org pool gives one a budget.</Trans>
        </p>
      )}
    </section>
  );
}
