/**
 * The endpoints table. Rows open the detail; edit/delete show only when the
 * hub's permission expansion allows them. New endpoint is always offered —
 * creating one is a type-level right (the creator becomes its owner).
 *
 * Today's tokens/cost per row come from one `usage` call per visible endpoint
 * (react-query dedupes and caches them; the same query feeds the detail's
 * Today tab), so the list is a glance at spend without a second endpoint.
 */
import type { LLMEndpoint, LLMUsageReport } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueries } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { formatValue } from '@src/components/cost-dashboard/constants';

import { canConfigure, canRemove, endpointTypeId } from './endpoint-catalog';
import { TONE } from './tone';
import { cohortRange, formatUsd } from './usage-math';
import { usageQueryOptions } from './use-llm-endpoints';

export interface LlmEndpointsListProps {
  endpoints: readonly LLMEndpoint[];
  isLoading?: boolean;
  onOpen: (endpoint: LLMEndpoint) => void;
  onNew: () => void;
  onEdit: (endpoint: LLMEndpoint) => void;
  onDelete: (endpoint: LLMEndpoint) => void;
}

export function KindBadge({ kind }: { kind: 'root' | 'chain' }) {
  return (
    <Badge variant="outline" data-testid={`kind-badge-${kind}`} className={kind === 'root' ? TONE.sky : TONE.violet}>
      {kind === 'root' ? <Trans>root</Trans> : <Trans>chain</Trans>}
    </Badge>
  );
}

export function ProviderBadge({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  return (
    <Badge variant="secondary" data-testid="provider-badge" className="font-mono text-[11px]">
      {provider}
    </Badge>
  );
}

/** A clickable endpoint name — the graph edge in the table. Stops the row click. */
export function EndpointLink({
  endpoint,
  onOpen,
  testId,
}: {
  endpoint: LLMEndpoint;
  onOpen: (endpoint: LLMEndpoint) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="truncate text-xs text-primary hover:underline"
      data-testid={testId}
      onClick={(ev) => {
        ev.stopPropagation();
        onOpen(endpoint);
      }}
    >
      {endpoint.name || endpoint.id}
    </button>
  );
}

export function CredentialChip({ endpoint }: { endpoint: LLMEndpoint }) {
  if (endpoint.kind !== 'root') return <span className="text-xs text-muted-foreground">—</span>;
  return endpoint.hasCredential ? (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${TONE.emerald}`}
      data-testid="credential-chip"
    >
      <KeyRound className="h-3 w-3" />
      {endpoint.credential_hint}
    </span>
  ) : (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${TONE.amber}`}
      data-testid="credential-chip"
    >
      <KeyRound className="h-3 w-3" />
      <Trans>no key</Trans>
    </span>
  );
}

/** Today's usage per endpoint id, one query each, batched by react-query. */
export function useTodayUsage(ids: readonly string[]) {
  // Computed once per mount; `cohortRange` floors `to` to the minute, so a
  // remount within the minute (list ↔ detail) lands on the same cache entry.
  const range = useMemo(() => cohortRange('today'), []);
  const results = useQueries({
    queries: ids.map((id) => usageQueryOptions(id, range)),
  });
  const byId = new Map<string, LLMUsageReport | undefined>();
  ids.forEach((id, i) => byId.set(id, results[i]?.data));
  return byId;
}

export function LlmEndpointsList({ endpoints, isLoading, onOpen, onNew, onEdit, onDelete }: LlmEndpointsListProps) {
  const { t } = useLingui();
  const usage = useTodayUsage(endpoints.map((e) => e.id));
  const byId = useMemo(() => new Map(endpoints.map((e) => [endpointTypeId(e.id), e])), [endpoints]);
  // Consumers per endpoint id, one pass over the list rather than a scan per row.
  const consumersById = useMemo(() => {
    const out = new Map<string, LLMEndpoint[]>();
    for (const e of endpoints) {
      for (const src of e.sources) {
        const source = byId.get(src);
        if (!source) continue;
        const list = out.get(source.id) ?? [];
        list.push(e);
        out.set(source.id, list);
      }
    }
    return out;
  }, [endpoints, byId]);

  return (
    <div className="space-y-3" data-testid="llm-endpoints-list">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={onNew} data-testid="llm-new-endpoint">
          <Plus className="me-1 h-4 w-4" />
          <Trans>New endpoint</Trans>
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Name</Trans>
              </TableHead>
              <TableHead>
                <Trans>Kind</Trans>
              </TableHead>
              <TableHead>
                <Trans>Provider</Trans>
              </TableHead>
              <TableHead>
                <Trans>Sources</Trans>
              </TableHead>
              <TableHead>
                <Trans>Used by</Trans>
              </TableHead>
              <TableHead>
                <Trans>Enabled</Trans>
              </TableHead>
              <TableHead>
                <Trans>Credential</Trans>
              </TableHead>
              <TableHead className="text-end">
                <Trans>Today</Trans>
              </TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                  {isLoading ? t`Loading…` : t`No endpoints yet.`}
                </TableCell>
              </TableRow>
            )}
            {endpoints.map((e) => {
              const totals = usage.get(e.id)?.totals;
              const configurable = canConfigure(e);
              const removable = canRemove(e);
              const sources = e.sources.map((id) => byId.get(id) ?? null);
              const consumers = consumersById.get(e.id) ?? [];
              return (
                <TableRow
                  key={e.id}
                  data-testid={`llm-row-${e.id}`}
                  className="cursor-pointer"
                  onClick={() => onOpen(e)}
                >
                  <TableCell className="font-medium">{e.name || e.id}</TableCell>
                  <TableCell>
                    <KindBadge kind={e.kind} />
                  </TableCell>
                  <TableCell>
                    <ProviderBadge provider={e.kind === 'root' ? e.provider : null} />
                  </TableCell>
                  <TableCell data-testid={`llm-sources-${e.id}`}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      {sources.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                      {sources.map((src, i) =>
                        src ? (
                          <EndpointLink
                            key={src.id}
                            endpoint={src}
                            onOpen={onOpen}
                            testId={`llm-source-link-${src.id}`}
                          />
                        ) : (
                          <span key={e.sources[i]} className="text-xs text-muted-foreground" title={e.sources[i]}>
                            {t`(not visible)`}
                          </span>
                        ),
                      )}
                    </span>
                  </TableCell>
                  <TableCell data-testid={`llm-consumers-${e.id}`}>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      {consumers.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                      {consumers.map((c) => (
                        <EndpointLink key={c.id} endpoint={c} onOpen={onOpen} testId={`llm-consumer-link-${c.id}`} />
                      ))}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${e.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                      title={e.enabled ? t`Enabled` : t`Disabled`}
                      data-testid={`enabled-dot-${e.enabled ? 'on' : 'off'}`}
                    />
                  </TableCell>
                  <TableCell>
                    <CredentialChip endpoint={e} />
                  </TableCell>
                  <TableCell className="text-end font-mono text-xs" data-testid="today-usage">
                    {totals ? `${formatValue(totals.total_tokens, 'tokens')} · ${formatUsd(totals.cost_usd)}` : '…'}
                  </TableCell>
                  <TableCell className="text-end">
                    <span className="inline-flex gap-1" onClick={(ev) => ev.stopPropagation()}>
                      {configurable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={t`Edit`}
                          data-testid={`llm-edit-${e.id}`}
                          onClick={() => onEdit(e)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {removable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          aria-label={t`Delete`}
                          data-testid={`llm-delete-${e.id}`}
                          onClick={() => onDelete(e)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
