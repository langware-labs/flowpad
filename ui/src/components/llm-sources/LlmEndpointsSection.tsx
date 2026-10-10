/**
 * The hub endpoints this account can spend, with what is left on each.
 *
 * The `endpoints` section of LLM sources (`/dock/llm-sources/endpoints`). Every row is one of
 * `funding.available` of the hub kind; the bar is the tightest cost cap along its chain, read
 * by `useHubRemaining` from the hub's own `chain` answer — so the "$X left" here, on the modal
 * row and on the endpoint's hub page are one number. Open lands on that page, where the chain,
 * limits and usage live.
 */
import { LLMFundingKind, type LLMFundingStatus } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Waypoints } from 'lucide-react';

import { LimitBar } from '@src/components/llm-endpoints/LimitsRemaining';
import { endpointTypeId, openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { TONE } from '@src/components/llm-endpoints/tone';
import type { NavigationActions } from '@src/navigation/NavigationActions';

import { useHubRemaining } from './use-hub-remaining';
import { endpointOf } from './use-llm-sources';

export function LlmEndpointsSection({
  funding,
  navigation,
}: {
  funding: LLMFundingStatus;
  navigation: NavigationActions;
}) {
  const { t } = useLingui();
  const remaining = useHubRemaining(funding);
  const hubs = (funding.available ?? []).filter((e) => e.kind === (LLMFundingKind.Hub as string));
  const inUse = new Set(
    Object.values(funding.resolved ?? {})
      .filter((pick) => !!pick && endpointOf(funding, pick)?.kind === LLMFundingKind.Hub)
      .map((pick) => pick!.endpoint_typeid),
  );
  return (
    <section className="flex flex-col gap-3" data-testid="llm-sources-endpoints">
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Waypoints className="h-3 w-3" />
        <Trans>Hub endpoints from your FlowPad account</Trans>
      </h2>
      {hubs.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="llm-sources-endpoints-empty">
          <Trans>No hub endpoint is available to this box. Sign in to FlowPad to receive one.</Trans>
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {hubs.map((e) => {
          const typeid = endpointTypeId(e.id);
          const r = remaining[typeid];
          return (
            <li
              key={e.id}
              data-testid={`endpoint-row-${e.id}`}
              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
                inUse.has(typeid) ? 'border-primary/60 bg-primary/5' : 'border-border/60'
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{e.name}</span>
                  <span className="text-xs text-muted-foreground">{e.provider}</span>
                  {inUse.has(typeid) && (
                    <Badge variant="outline" className={`gap-1 ${TONE.sky}`}>
                      <Trans>in use</Trans>
                    </Badge>
                  )}
                </span>
                {r ? (
                  <LimitBar limitKey={r.key} remaining={r} resetsText="" testId={`endpoint-left-${e.id}`} />
                ) : (
                  <span className="text-xs text-muted-foreground" data-testid={`endpoint-left-${e.id}`}>
                    <Trans>no cost cap</Trans>
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openLlmEndpoint(navigation, typeid)}
                title={t`Open this endpoint on the hub`}
                data-testid={`endpoint-open-${e.id}`}
              >
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
