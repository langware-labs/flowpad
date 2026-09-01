/**
 * The admin-only breakdown of an endpoint's usage by the child it came through
 * (or by model). Child rows are the drill-down: clicking one navigates to that
 * endpoint's own Usage tab (`/dock/hub/llm-endpoints/<child>/usage`), which is
 * how you follow spend down a chain.
 */
import type { LLMEndpoint, LLMUsageBy, LLMUsageCounters } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { formatValue } from '@src/components/cost-dashboard/constants';

import { UsageChildRow } from './UsageRows';
import { endpointIdFromTypeId } from './llm-endpoints-pointer';
import { childLabel, formatUsd } from './usage-math';

export interface UsageByChildTableProps {
  by: LLMUsageBy;
  breakdown: Record<string, LLMUsageCounters>;
  /** The hub's display names for the `by` dimension — it names children the
   *  caller cannot list, which `all` alone cannot. */
  names?: Record<string, string>;
  /** Fallback naming for child ids; unknown ids fall back to the id. */
  all: readonly LLMEndpoint[];
}

export function UsageByChildTable({ by, breakdown, names, all }: UsageByChildTableProps) {
  const { t } = useLingui();
  const lookup = useMemo(() => {
    const byId = new Map(all.map((e) => [e.id, e.name]));
    return (id: string) => byId.get(id);
  }, [all]);
  const rows = Object.entries(breakdown).sort((a, b) => b[1].cost_usd - a[1].cost_usd);

  return (
    <div className="rounded-md border" data-testid="usage-breakdown">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{by === 'child' ? t`Via` : t`Model`}</TableHead>
            <TableHead className="text-end">
              <Trans>Requests</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Errors</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Fallbacks</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Tokens</Trans>
            </TableHead>
            <TableHead className="text-end">
              <Trans>Cost</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                <Trans>No usage in this period.</Trans>
              </TableCell>
            </TableRow>
          )}
          {rows.map(([dim, c]) => {
            // "" is usage that entered HERE (no child in between) — not a link.
            const isChild = by === 'child' && dim !== '';
            return (
              <UsageChildRow
                key={dim || '__direct'}
                id={isChild ? endpointIdFromTypeId(dim) : null}
                label={isChild ? childLabel(dim, names, lookup) : dim || t`direct`}
                testId={`usage-row-${dim || 'direct'}`}
                values={[
                  c.requests,
                  c.errors,
                  c.fallbacks,
                  formatValue(c.total_tokens, 'tokens'),
                  formatUsd(c.cost_usd),
                ]}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
