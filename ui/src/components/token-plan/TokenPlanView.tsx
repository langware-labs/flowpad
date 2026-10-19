/**
 * Token plan — "what's my budget, how much did I burn, when does it reset" for
 * me / my team / my org. URL: `/dock/hub/token-plan[/me|team[/<id>]|org]`.
 *
 * URL-first like the endpoints view: the active scope comes from the pointer
 * and the segmented control navigates. Everything shown comes from one hub
 * read (`token_plan/me`); the admin actions are a plain endpoint update (the
 * sheet) and the two setups. The expert page is one link away.
 */
import { PageId, ViewType, type TokenPlanScope } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Gauge } from 'lucide-react';
import { useMemo, useState } from 'react';

import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { Button } from '@src/components/ui/button';
import { ScopeBar } from '@src/components/ui/scope-bar';
import { Skeleton } from '@src/components/ui/skeleton';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

import { BudgetHero } from './BudgetHero';
import { ConsumptionPanel } from './ConsumptionPanel';
import { MembersTable } from './MembersTable';
import { ScopePath } from './ScopePath';
import { SetBudgetSheet } from './SetBudgetSheet';
import { scopeLabel } from './token-plan-math';
import { parseTokenPlanPointer, scopePointer, selectScope } from './token-plan-pointer';
import { useSetupScope, useTokenPlan } from './use-token-plan';

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

export function TokenPlanView({ pointer }: { pointer?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { data, isLoading, error } = useTokenPlan();
  const [sheetOpen, setSheetOpen] = useState(false);

  const scopes = useMemo(() => data?.scopes ?? [], [data]);
  const parsed = parseTokenPlanPointer(pointer);
  const scope = selectScope(scopes, parsed);
  const me = scopes.find((s) => s.kind === 'me');
  const remainingByHop = useMemo(() => {
    const out: Record<string, TokenPlanScope['remaining']> = {};
    for (const s of scopes) if (s.endpoint_id) out[s.endpoint_id] = s.remaining;
    return out;
  }, [scopes]);

  const options = scopes.map((s) => {
    const label = scopeLabel(s);
    return { value: scopePointer(s), label: typeof label === 'string' ? label : t(label) };
  });
  const active = scope ? scopePointer(scope) : '';
  const go = (next: string) => navigation.openPage(PageId.HUB, ViewType.TOKEN_PLAN, next || undefined);

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

      {options.length > 1 && (
        <div className="mb-4" data-testid="scope-bar">
          <ScopeBar value={active} options={options} onChange={go} />
        </div>
      )}

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

      {scope && (
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {scope.path.length > 0 && <ScopePath path={scope.path} remainingByHop={remainingByHop} />}
          {scope.endpoint_id ? (
            <>
              <BudgetHero scope={scope} onSetBudget={scope.can_configure ? () => setSheetOpen(true) : undefined} />
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
          ) : (
            <ScopeSetup scope={scope} />
          )}
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
    </div>
  );
}

export default TokenPlanView;
