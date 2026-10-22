/**
 * Token sources: every budget the caller can reach, as the tree it is (root → org pool → team pool
 * → key), each row with its sponsor, its own left / limit, Allocate where the caller administers it
 * and ⚙ to configure it. Key / Team / Org filter by sponsor; a filtered-out ancestor stays dimmed so
 * the tree still reads.
 */
import type { LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, ChevronDown, Plus, Settings } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@src/components/ui/button';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { cn } from '@src/lib/utils';

import anthropicMark from '../../../../flow_sdk/server/icons/brands/assets/claude.svg';
import openaiMark from '../../../../flow_sdk/server/icons/brands/assets/codex.svg';
import openrouterMark from '../../../../flow_sdk/server/icons/brands/assets/openrouter.svg';

import { buildSourceTree, costLeft, sponsorOf, type Sponsor, type SponsorFilter } from './source-tree';

/** A root talks to a provider with its own key: its row wears that provider's mark. */
const PROVIDER_MARK: Record<string, string> = {
  openrouter: openrouterMark,
  anthropic: anthropicMark,
  openai: openaiMark,
};

/** Marks drawn in black: inverted in dark mode so they stay visible. */
const MONO_MARKS = new Set(['openrouter', 'anthropic', 'openai']);

const CHIP = 'rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground';

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
  const rows = useMemo(() => buildSourceTree(endpoints, filter), [endpoints, filter]);
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

      <div className="flex rounded-lg bg-muted p-0.5" role="tablist" data-testid="scope-bar">
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
              <th className="px-2 py-2 text-right font-medium">
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
                        {hasChildren && <ChevronDown className="h-3.5 w-3.5" />}
                      </span>
                      {e.kind === 'root' && PROVIDER_MARK[e.provider] && (
                        <img
                          src={PROVIDER_MARK[e.provider]}
                          alt={e.provider}
                          title={e.provider}
                          className={cn('me-1.5 h-4 w-4 shrink-0', MONO_MARKS.has(e.provider) && 'dark:invert')}
                          data-testid={`provider-mark-${e.id}`}
                        />
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
                    <span className={CHIP}>{sponsorLabel[sponsorOf(e)]}</span>
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
                          className={cn(CHIP, 'hover:bg-accent')}
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
