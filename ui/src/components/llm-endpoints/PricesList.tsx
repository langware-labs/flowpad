/**
 * What a call through an API endpoint costs — the third tab, where an LLM endpoint lists its models.
 *
 * The prices are the ROOTS': each root's owner writes what one call to a path costs (`meter`), and
 * the chain report carries them, so anyone who holds the endpoint sees the price before calling.
 * Read only here; a root's prices are edited in its own dialog.
 */
import type { APIEndpointPriceRule, LLMChainHop } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

import { KindChips } from './KindChips';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';

import { formatUsd } from './usage-math';
import { useLlmEndpointChain } from './use-llm-endpoints';

interface PriceRow {
  key: string;
  root: LLMChainHop;
  rule: APIEndpointPriceRule | null;
}

/** `$0.10 × parameters.durationSeconds` — the unit price and what in the request multiplies it. */
export function priceText(rule: APIEndpointPriceRule, free: string): string {
  if (!rule.usd) return free;
  return [formatUsd(rule.usd), ...(rule.times ?? []).map((factor) => factor.field)].join(' × ');
}

export function PricesList({ endpointId }: { endpointId: string }) {
  const { t } = useLingui();
  const { data, isLoading, error } = useLlmEndpointChain(endpointId);
  const rows = useMemo<PriceRow[]>(() => {
    const out: PriceRow[] = [];
    for (const root of (data?.hops ?? []).filter((hop) => hop.is_root)) {
      const rules = root.meter?.kind === 'per_call' ? (root.meter.rules ?? []) : [];
      if (rules.length === 0) out.push({ key: root.id, root, rule: null });
      rules.forEach((rule, i) => out.push({ key: `${root.id}:${i}`, root, rule }));
    }
    return out;
  }, [data]);

  return (
    <div className="space-y-3" data-testid="prices-list">
      {error && (
        <p className="text-sm text-destructive">
          <Trans>Could not load the prices.</Trans>
        </p>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Call</Trans>
              </TableHead>
              <TableHead>
                <Trans>Serves</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>Price</Trans>
              </TableHead>
              <TableHead>
                <Trans>Root</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                  {isLoading ? '…' : t`No root to price a call.`}
                </TableCell>
              </TableRow>
            )}
            {rows.map(({ key, root, rule }) => (
              <TableRow key={key} data-testid="price-row">
                <TableCell className="font-mono text-xs">{rule ? rule.path : t`any call`}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1">
                    <KindChips kinds={root.kinds} />
                  </span>
                </TableCell>
                <TableCell className="text-end font-mono text-xs">
                  {rule
                    ? priceText(rule, t`free`)
                    : root.meter?.kind === 'json_usage'
                      ? t`by the tokens the answer reports`
                      : t`not priced`}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{root.name}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Set by the owner of each root. A call that matches no row is free. A call is booked when its answer is
          delivered; a refused or failed call costs nothing.
        </Trans>
      </p>
    </div>
  );
}
