/**
 * Token plan — every budget the caller can reach as a tree of token sources (left), and the
 * selected one's budget and consumption (centre). URL: `/dock/hub/token-plan[/<pointer>]`, where
 * the pointer is an endpoint typeid (`llm_endpoint-<uuid>`) or a scope (`me` | `team[/<id>]` | `org`).
 *
 * The tree is one permissions read of the endpoint list (parents, sponsor, own remaining ride the
 * expansion); a source that is one of the caller's scopes keeps the token plan's full view
 * (`token_plan/me`), any other shows its own limits and the endpoint usage panel.
 */
import { PageId, ViewType, type LLMEndpoint, type LLMEndpointLimits, type TokenPlanScope } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Gauge, Settings } from 'lucide-react';
import { useMemo, useState } from 'react';

import { LlmEndpointDialog } from '@src/components/llm-endpoints/LlmEndpointDialog';
import {
  endpointIdFromTypeId,
  endpointTypeId,
  openLlmEndpoint,
} from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { UsagePanel } from '@src/components/llm-endpoints/UsagePanel';
import { useLlmEndpoints } from '@src/components/llm-endpoints/use-llm-endpoints';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { Button } from '@src/components/ui/button';
import { Skeleton } from '@src/components/ui/skeleton';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { BudgetHero } from './BudgetHero';
import { ConsumptionPanel } from './ConsumptionPanel';
import { MembersTable } from './MembersTable';
import { AllocateDialog } from './AllocateDialog';
import { TokenSourcesTree } from './TokenSourcesTree';
import { childrenOf, costLeft, scopeForEndpoint } from './source-tree';
import { SetBudgetSheet } from './SetBudgetSheet';
import { parseTokenPlanPointer, selectScope } from './token-plan-pointer';
import { useInvalidateTokenPlan, useSetupScope, useTokenPlan } from './use-token-plan';

function ScopeSetup({ scope }: { scope: TokenPlanScope }) {
  const { t } = useLingui();
  const setup = useSetupScope();
  const run = async () => {
    try {
      await setup.mutateAsync({ kind: scope.kind as 'team' | 'org', id: scope.id });
      notify.success({ title: t`Budget endpoint created for ${scope.name}` });
    } catch (e) {
      notify.error({ title: t`Could not set up the budget`, message: errorMessage(e, '') });
    }
  };
  return (
    <section className="rounded-xl border border-dashed p-5" data-testid="scope-setup">
      <div className="text-base font-semibold">
        {scope.kind === 'team' ? <Trans>No team budget yet</Trans> : <Trans>No organization budget yet</Trans>}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {scope.can_configure ? (
          <Trans>Create the shared budget endpoint; members' defaults are then routed through it.</Trans>
        ) : (
          <Trans>Ask an admin to set one up.</Trans>
        )}
      </p>
      {scope.can_configure && (
        <Button
          size="sm"
          className="mt-3"
          onClick={() => void run()}
          disabled={setup.isPending}
          data-testid="scope-setup-run"
        >
          {scope.kind === 'team' ? <Trans>Set up team budget</Trans> : <Trans>Set up org budget</Trans>}
        </Button>
      )}
    </section>
  );
}

/** What was allocated FROM the selected source: each with its own left / limit. Not sources. */
function Allocations({
  source,
  endpoints,
  onOpen,
  onConfigure,
}: {
  source: LLMEndpoint;
  endpoints: readonly LLMEndpoint[];
  onOpen: (e: LLMEndpoint) => void;
  onConfigure: (e: LLMEndpoint) => void;
}) {
  const kids = childrenOf(source, endpoints).filter((k) => k.enabled !== false);
  if (kids.length === 0) return null;
  const own = costLeft(source);
  const given = own ? kids.reduce((sum, k) => sum + (k.limits[own.key as keyof LLMEndpointLimits] ?? 0), 0) : 0;
  return (
    <section className="space-y-2" data-testid="allocations">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">
          <Trans>Allocated from this source</Trans>
        </h2>
        {own && (
          <span className="text-xs text-muted-foreground" data-testid="pool-split">
            <Trans>unallocated {formatUsd(Math.max(0, own.limit - given))}</Trans>
          </span>
        )}
      </div>
      <div className="rounded-lg border">
        {kids.map((k) => {
          const left = costLeft(k);
          return (
            <div key={k.id} className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-0">
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(k)}>
                {k.name}
              </button>
              <span className="whitespace-nowrap tabular-nums">
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
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onConfigure(k)}
                aria-label={k.name}
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A tree pointer is an endpoint typeid; anything else is a scope pointer. */
function pointedEndpointId(pointer: string | undefined): string | null {
  return pointer?.startsWith('llm_endpoint-') ? endpointIdFromTypeId(pointer) : null;
}

export function TokenPlanView({ pointer }: { pointer?: string }) {
  const { navigation } = useDockNavigation();
  const { data, isLoading, error } = useTokenPlan();
  const { endpoints, refetch } = useLlmEndpoints();
  const invalidate = useInvalidateTokenPlan();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [allocating, setAllocating] = useState<LLMEndpoint | null>(null);

  const scopes = useMemo(() => data?.scopes ?? [], [data]);
  const me = scopes.find((s) => s.kind === 'me');
  const bare = (id: string | null | undefined) => (id ? endpointIdFromTypeId(id) : null);

  // What is selected: an endpoint from the tree, or a scope (the old pointers still land).
  const treeId = pointedEndpointId(pointer);
  const pointedScope = treeId ? undefined : selectScope(scopes, parseTokenPlanPointer(pointer));
  const selected =
    (treeId && endpoints.find((e) => e.id === treeId)) ||
    endpoints.find((e) => e.id === bare(pointedScope?.endpoint_id)) ||
    null;
  const selectedId = selected ? selected.id : bare(pointedScope?.endpoint_id);
  const scope = scopeForEndpoint(scopes, selectedId) ?? null;
  const setupScope = !selectedId && pointedScope && !pointedScope.endpoint_id ? pointedScope : null;
  const hiddenTeams = scopes.filter((s) => s.kind === 'team' && !s.endpoint_id).length;

  const go = (next: string) => navigation.openPage(PageId.HUB, ViewType.TOKEN_PLAN, next || undefined);
  const refresh = () => void Promise.all([invalidate(), refetch()]);

  // A source that is not one of the caller's scopes: its own limits, no path.
  const ownView = useMemo<TokenPlanScope | null>(() => {
    if (!selected || scope) return null;
    const remaining = selected.ownRemaining;
    return {
      kind: 'me',
      id: selected.id,
      name: selected.name,
      endpoint_id: endpointTypeId(selected.id),
      can_configure: false,
      path: [],
      headline: costLeft(selected) ?? remaining[0] ?? null,
      remaining,
      totals: { today: {}, week: {}, month: {}, all: {} } as TokenPlanScope['totals'],
      series: [],
    };
  }, [selected, scope]);

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
          <div className="w-full min-w-0 space-y-6">
            {setupScope && <ScopeSetup scope={setupScope} />}
            {(scope?.endpoint_id || ownView) && (
              <BudgetHero
                scope={(scope?.endpoint_id ? scope : ownView) as TokenPlanScope}
                onSetBudget={scope?.endpoint_id && scope.can_configure ? () => setSheetOpen(true) : undefined}
              />
            )}
            {selected && (
              <Allocations
                source={selected}
                endpoints={endpoints}
                onOpen={(e) => go(endpointTypeId(e.id))}
                onConfigure={(e) => openLlmEndpoint(navigation, e.id)}
              />
            )}
            {!selected && !scope && !setupScope && (
              <p className="text-sm text-muted-foreground" data-testid="nothing-selected">
                <Trans>Select a token source to see its budget and consumption.</Trans>
              </p>
            )}
            {scope && scope.endpoint_id && (
              <>
                <ConsumptionPanel scope={scope} />
                {scope.kind !== 'me' && (
                  <MembersTable
                    endpointId={scope.endpoint_id}
                    canConfigure={scope.can_configure}
                    myEndpointId={me?.endpoint_id ?? null}
                  />
                )}
                <footer className="pt-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    data-testid="expert-link"
                    onClick={() => openLlmEndpoint(navigation, scope.endpoint_id as string, 'usage')}
                  >
                    <Trans>Expert details</Trans>
                    <ArrowUpRight className="h-3 w-3" />
                  </button>
                </footer>
              </>
            )}
            {selected && ownView && (
              <>
                <UsagePanel endpointId={selected.id} endpoint={selected} all={endpoints} />
              </>
            )}
          </div>
        </div>
      )}

      {/* Mounted only while open: the sheet fetches the endpoint it edits, so a
          visit to this screen costs no endpoint request. */}
      {scope && scope.endpoint_id && sheetOpen && (
        <SetBudgetSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          endpointId={scope.endpoint_id}
          scopeKind={scope.kind}
          scopeName={scope.name}
        />
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
