/**
 * "Who's spending" — the scope endpoint's `usage?by=child` for today and this
 * month, one row per member (child endpoint), named by the hub's `names`,
 * sorted by month spend. Row click → that member's expert Usage tab. Admins
 * see everyone; anyone else sees only their own row (the `me` scope endpoint),
 * or nothing.
 *
 * The rows themselves are the endpoint layer's `UsageChildRow`, the same one
 * the expert by-child table renders — only the columns differ.
 */
import type { LLMUsageCounters, LLMUsageReport } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { formatValue } from '@src/components/cost-dashboard/constants';
import { UsageChildRow } from '@src/components/llm-endpoints/UsageRows';
import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmEndpoints, usageQueryOptions } from '@src/components/llm-endpoints/use-llm-endpoints';
import { childLabel, cohortRange, formatUsd } from '@src/components/llm-endpoints/usage-math';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';

export interface MemberRow {
  /** Bare endpoint uuid. */
  id: string;
  name: string;
  today: LLMUsageCounters | null;
  month: LLMUsageCounters | null;
}

/** Merge the two reports into rows, month spend descending. Pure.
 *  `onlyId` is a BARE uuid — callers holding a typeid must normalise first. */
export function memberRows(
  today: LLMUsageReport | undefined,
  month: LLMUsageReport | undefined,
  onlyId?: string,
  lookup?: (id: string) => string | undefined,
): MemberRow[] {
  const dims = new Set<string>([...Object.keys(today?.breakdown ?? {}), ...Object.keys(month?.breakdown ?? {})]);
  const names = { ...(today?.names ?? {}), ...(month?.names ?? {}) };
  const rows: MemberRow[] = [];
  for (const dim of dims) {
    if (dim === '') continue; // usage that entered here directly — not a member
    const id = endpointIdFromTypeId(dim);
    if (onlyId && id !== onlyId) continue;
    rows.push({
      id,
      name: childLabel(dim, names, lookup),
      today: today?.breakdown?.[dim] ?? null,
      month: month?.breakdown?.[dim] ?? null,
    });
  }
  return rows.sort((a, b) => (b.month?.cost_usd ?? 0) - (a.month?.cost_usd ?? 0));
}

export interface MembersTableProps {
  endpointId: string;
  canConfigure: boolean;
  /** The caller's own default endpoint — a typeid or a bare uuid. */
  myEndpointId?: string | null;
}

export function MembersTable({ endpointId, canConfigure, myEndpointId }: MembersTableProps) {
  // The scope carries a typeid; entity action URLs take the bare uuid (a typeid
  // in the path answers 422), so normalize before querying.
  const queryId = endpointIdFromTypeId(endpointId);
  const { t } = useLingui();
  const ranges = useMemo(() => {
    const now = new Date();
    return { today: cohortRange('today', now), month: cohortRange('thisMonth', now) };
  }, []);
  const today = useQuery(usageQueryOptions(queryId, { ...ranges.today, by: 'child' }));
  const month = useQuery(usageQueryOptions(queryId, { ...ranges.month, by: 'child' }));
  // The hub sends `endpoint_id` as a typeid while a row id is bare: compare
  // both through the same normalisation or a non-admin never matches their own
  // row and the table reads as empty.
  const myId = myEndpointId ? endpointIdFromTypeId(myEndpointId) : null;
  // The hub's `names` map can come back empty (its in-request re-read of a
  // child is denied under the `usage` action), so fall back to the endpoints
  // the caller can already list rather than showing a raw typeid.
  const { endpoints } = useLlmEndpoints();
  const nameById = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);
  const rows = useMemo(
    () =>
      memberRows(
        today.data,
        month.data,
        canConfigure ? undefined : (myId ?? '-'),
        (id) => nameById.get(id) || undefined,
      ),
    [today.data, month.data, canConfigure, myId, nameById],
  );
  if (!canConfigure && rows.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="members-table">
      <h2 className="text-sm font-medium">
        <Trans>Who's spending</Trans>
      </h2>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Member</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>Today</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>This month</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>Tokens (month)</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>Requests (month)</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  {today.isLoading || month.isLoading ? '…' : t`No member usage yet.`}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <UsageChildRow
                key={row.id}
                id={row.id}
                testId={`member-row-${row.id}`}
                label={row.name}
                suffix={
                  myId && row.id === myId ? (
                    <span className="ms-2 text-xs text-muted-foreground">
                      <Trans>(you)</Trans>
                    </span>
                  ) : undefined
                }
                values={[
                  formatUsd(row.today?.cost_usd ?? 0),
                  formatUsd(row.month?.cost_usd ?? 0),
                  formatValue(row.month?.total_tokens ?? 0, 'tokens'),
                  row.month?.requests ?? 0,
                ]}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
