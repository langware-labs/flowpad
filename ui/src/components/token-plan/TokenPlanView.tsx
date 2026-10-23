/**
 * Token plan -- the caller's token sources (left) and, in the centre, one stable summary: every source
 * together by default, or the selected row (which includes everything allocated from it).
 * URL: `/dock/hub/token-plan[/llm_endpoint-<uuid>]`.
 */
import { PageId, ViewType, type LLMEndpoint } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';

import { LlmEndpointDialog } from '@src/components/llm-endpoints/LlmEndpointDialog';
import {
  endpointIdFromTypeId,
  endpointTypeId,
  openLlmEndpoint,
} from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmEndpoints } from '@src/components/llm-endpoints/use-llm-endpoints';
import { Skeleton } from '@src/components/ui/skeleton';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { AllocateDialog } from './AllocateDialog';
import { SourceSummary } from './SourceSummary';
import { TokenSourcesTree } from './TokenSourcesTree';
import { childrenOf, sourceRows } from './source-tree';
import { useInvalidateTokenPlan, useTokenPlan } from './use-token-plan';

/** The selected row: an endpoint typeid pointer; anything else selects nothing (all sources). */
function pointedEndpointId(pointer: string | undefined): string | null {
  return pointer?.startsWith('llm_endpoint-') ? endpointIdFromTypeId(pointer) : null;
}

export function TokenPlanView({ pointer }: { pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { data, isLoading, error } = useTokenPlan();
  const { endpoints, refetch } = useLlmEndpoints();
  const invalidate = useInvalidateTokenPlan();
  const [adding, setAdding] = useState(false);
  const [allocating, setAllocating] = useState<LLMEndpoint | null>(null);

  const scopes = useMemo(() => data?.scopes ?? [], [data]);
  const hiddenTeams = scopes.filter((s) => s.kind === 'team' && !s.endpoint_id).length;
  const sources = useMemo(() => sourceRows(endpoints), [endpoints]);

  // One row, or -- with nothing selected -- every source together.
  const treeId = pointedEndpointId(pointer);
  const selected = (treeId && endpoints.find((e) => e.id === treeId)) || null;
  const label = (e: LLMEndpoint) =>
    sources.find((r) => r.endpoint.id === e.id)?.flowpadAccount ? t`Flowpad account` : e.name || t`Unnamed`;

  const go = (next: string) => navigation.openPage(PageId.HUB, ViewType.TOKEN_PLAN, next || undefined);
  const open = (e: LLMEndpoint) => go(endpointTypeId(e.id));
  const refresh = () => void Promise.all([invalidate(), refetch()]);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-1 flex items-center gap-2">
        <Gauge className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">
          <Trans>Token plan</Trans>
        </h1>
      </header>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        <Trans>Your budget, what you burned, and when it resets — for you, your team and your organization.</Trans>
      </p>

      {isLoading && !data && (
        <div className="space-y-3" data-testid="token-plan-loading">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" data-testid="token-plan-error">
          <Trans>Could not load your token plan.</Trans>
        </p>
      )}

      {data && (
        <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,44rem)_minmax(0,1fr)]">
          <TokenSourcesTree
            endpoints={endpoints}
            selectedId={selected?.id ?? null}
            hiddenTeams={hiddenTeams}
            onSelect={(e) => go(endpointTypeId(e.id))}
            onAllocate={setAllocating}
            onConfigure={(e) => openLlmEndpoint(navigation, e.id)}
            onAdd={() => setAdding(true)}
            onAllEndpoints={() => navigation.openPage(PageId.HUB, ViewType.LLM_ENDPOINTS)}
          />
          <div className="w-full min-w-0 space-y-3">
            {selected && (
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => go('')}
                  data-testid="show-all"
                >
                  <Trans>← All sources</Trans>
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="expert-link"
                  onClick={() => openLlmEndpoint(navigation, selected.id, 'usage')}
                >
                  <Trans>Expert details</Trans>
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              </div>
            )}
            <SourceSummary
              key={selected?.id ?? 'all'}
              title={selected ? label(selected) : t`All sources`}
              subject={selected ? [selected] : sources.map((r) => r.endpoint)}
              breakdown={(selected
                ? childrenOf(selected, endpoints).filter((k) => k.enabled !== false)
                : sources.map((r) => r.endpoint)
              ).map((e) => ({ endpoint: e, label: label(e) }))}
              breakdownTitle={selected ? t`Allocated from this source` : t`Sources`}
              onOpen={open}
            />
          </div>
        </div>
      )}

      {adding && (
        <LlmEndpointDialog
          open
          onOpenChange={(next) => !next && setAdding(false)}
          all={endpoints}
          onSaved={() => {
            refresh();
            setAdding(false);
          }}
        />
      )}
      {allocating && (
        <AllocateDialog source={allocating} scopes={scopes} onClose={() => setAllocating(null)} onDone={refresh} />
      )}
    </div>
  );
}

export default TokenPlanView;
