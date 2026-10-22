/**
 * Billing & keys: who pays for this organization's AI usage, and how much it may spend.
 *
 * "Who pays" states the funding source the hub reports (`is_root` / `provider` / the masked
 * `credential_hint`) and hosts the existing key form — set up, replace, test, delete — so the key
 * lives here and nowhere on the people screens.
 */
import type { OrgBudgets } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { providerSpec } from '@src/components/llm-endpoints/endpoint-catalog';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { AdvancedButton } from '@src/components/organization/budgets/AdvancedEndpointDialog';
import { BudgetHistoryButton } from '@src/components/organization/budgets/BudgetHistoryDialog';
import { EndpointControls } from '@src/components/organization/budgets/EndpointControls';
import { MoneyBox } from '@src/components/organization/budgets/MoneyBox';
import { PayingProviderSetup } from '@src/components/organization/budgets/PayingProviderSetup';
import { useSetLifetimeCap } from '@src/components/organization/budgets/use-budgets';

import { SpendBar, TabTitle, savingCap } from './shared';

export function BillingTab({ data }: { data: OrgBudgets }) {
  const { t } = useLingui();
  const { org } = data;
  const setCap = useSetLifetimeCap();
  const spec = org.provider ? providerSpec(org.provider) : undefined;
  const over = org.limit_usd !== null && org.allocated_usd !== null && org.allocated_usd > org.limit_usd;

  return (
    <div data-testid="org-billing-tab">
      <TabTitle
        title={<Trans>Billing &amp; keys</Trans>}
        sub={<Trans>Who pays for AI usage in this organization, and how much it may spend.</Trans>}
      />

      <section className="mb-5 rounded-lg border border-border" data-testid="org-who-pays">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">
          <Trans>Who pays</Trans>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 text-sm">
          <p className="text-muted-foreground" data-testid="org-funding-source">
            {!org.endpoint_id ? (
              <Trans>Not set up yet. Add your own provider key to start spending.</Trans>
            ) : org.is_root ? (
              spec ? (
                <Trans>Your own {t(spec.label)} key. Usage is billed to your provider account.</Trans>
              ) : (
                <Trans>Your own provider key. Usage is billed to your provider account.</Trans>
              )
            ) : (
              <Trans>Flowpad shared pool. Usage draws on Flowpad credits.</Trans>
            )}
          </p>
          <PayingProviderSetup orgId={org.id} org={org} />
        </div>
      </section>

      {org.endpoint_id && (
        <section className="rounded-lg border border-border" data-testid="org-budget">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">
              <Trans>Organization budget</Trans>
            </span>
            <div className="flex items-center gap-1">
              {org.can_configure && (
                <BudgetHistoryButton endpointId={org.endpoint_id} scopeLabel={org.name} testId="org-history" />
              )}
              <AdvancedButton
                endpointId={org.endpoint_id}
                scopeLabel={org.name}
                testId="org-advanced"
                readOnly={!org.can_configure}
              />
            </div>
          </div>
          <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4 px-4 py-4 text-sm">
            <span className="text-muted-foreground">
              <Trans>Total limit</Trans>
            </span>
            <span className="flex flex-wrap items-center gap-4">
              <MoneyBox
                value={org.limit_usd}
                ariaLabel={t`Total budget for ${org.name}`}
                data-testid="org-total-cap"
                disabled={savingCap(setCap, org.endpoint_id) || !org.can_configure}
                onCommit={(usd) => setCap.mutate({ endpointId: org.endpoint_id as string, usd })}
              />
              <SpendBar spent={org.spent_usd} limit={org.limit_usd} className="items-start" testId="org-spent" />
            </span>
            {org.allocated_usd !== null && (
              <>
                <span className="text-muted-foreground">
                  <Trans>Given to teams</Trans>
                </span>
                <span data-testid="org-allocated">
                  <span className={over ? 'font-medium text-destructive' : 'font-medium'}>
                    {formatUsd(org.allocated_usd)}
                  </span>
                  {org.limit_usd !== null && (
                    <span className="text-muted-foreground">
                      {' '}
                      <Trans>of {formatUsd(org.limit_usd)}</Trans>
                    </span>
                  )}
                  {over && (
                    <span className="block text-xs text-destructive" data-testid="org-over-allocated">
                      <Trans>
                        More is given out than this budget holds. Nothing is blocked — whoever spends last is refused
                        once the money runs out.
                      </Trans>
                    </span>
                  )}
                </span>
              </>
            )}
            <span className="text-muted-foreground">
              <Trans>Models &amp; status</Trans>
            </span>
            <EndpointControls endpointId={org.endpoint_id} scope="org" testIdPrefix="org" manage={org.can_configure} />
          </div>
        </section>
      )}
    </div>
  );
}
