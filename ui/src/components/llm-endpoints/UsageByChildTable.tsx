/**
 * The admin-only breakdown of an endpoint's usage by the child it came through
 * (or by model). Child rows are the drill-down: clicking one navigates to that
 * endpoint's own Usage tab (`/dock/hub/llm-endpoints/<child>/usage`), which is
 * how you follow spend down a chain.
 */
import { PageId, ViewType, type LLMEndpoint, type LLMUsageBy, type LLMUsageCounters } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { formatValue } from '@src/components/cost-dashboard/constants';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { endpointIdFromTypeId } from './endpoint-catalog';
import { llmEndpointsPointer } from './llm-endpoints-pointer';
import { formatUsd } from './usage-math';

export interface UsageByChildTableProps {
  by: LLMUsageBy;
  breakdown: Record<string, LLMUsageCounters>;
  /** For naming child ids; unknown ids fall back to the id. */
  all: readonly LLMEndpoint[];
}

export function UsageByChildTable({ by, breakdown, all }: UsageByChildTableProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const names = new Map(all.map((e) => [e.id, e.name]));
  const rows = Object.entries(breakdown).sort((a, b) => b[1].cost_usd - a[1].cost_usd);

  const openChild = (dim: string) => {
    const childId = endpointIdFromTypeId(dim);
    navigation.openPage(PageId.HUB, ViewType.LLM_ENDPOINTS, llmEndpointsPointer(childId, 'usage'));
  };

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
            const label = isChild ? (names.get(endpointIdFromTypeId(dim)) ?? dim) : dim || t`direct`;
            return (
              <TableRow
                key={dim || '__direct'}
                data-testid={`usage-row-${dim || 'direct'}`}
                className={isChild ? 'cursor-pointer' : undefined}
                onClick={isChild ? () => openChild(dim) : undefined}
              >
                <TableCell className={isChild ? 'font-medium underline-offset-2 hover:underline' : ''}>
                  {label}
                </TableCell>
                <TableCell className="text-end font-mono text-xs">{c.requests}</TableCell>
                <TableCell className="text-end font-mono text-xs">{c.errors}</TableCell>
                <TableCell className="text-end font-mono text-xs">{c.fallbacks}</TableCell>
                <TableCell className="text-end font-mono text-xs">{formatValue(c.total_tokens, 'tokens')}</TableCell>
                <TableCell className="text-end font-mono text-xs">{formatUsd(c.cost_usd)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
