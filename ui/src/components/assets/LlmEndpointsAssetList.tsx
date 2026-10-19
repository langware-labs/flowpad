/**
 * The `llm_endpoint` browser surface — what the Assets body shows when the type root
 * itself is selected (`list/llm_endpoint`).
 *
 * Not `AssetListView`: that one searches the index, and these rows are not indexed. They
 * are not even local — an endpoint is a projection of hub state read through the
 * `llm-endpoint` box action, which is also why there is no "New" affordance here. A budget
 * comes into being by being allocated on the hub.
 *
 * Every row carries the same Test button the org page puts on its budget rows, so the
 * "does this actually work" question is answerable without opening anything.
 */
import { type LLMEndpointOffer } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { ProviderBadge } from '@src/components/llm-endpoints/LlmEndpointsList';
import { TestEndpointButton } from '@src/components/llm-endpoints/TestEndpointButton';
import { LIMIT_LABELS } from '@src/components/llm-endpoints/LimitsEditor';
import { LIMIT_KEYS } from '@src/components/llm-endpoints/filters-limits-forms';
import { endpointAssetPointer, useMyEndpoints } from '@src/components/llm-endpoints/my-endpoints';
import { TONE } from '@src/components/llm-endpoints/tone';
import { formatAmount } from '@src/components/llm-endpoints/usage-math';
import { Badge } from '@src/components/ui/badge';
import type { DockPointer } from '@src/navigation/DockPointer';

/** The ceilings this endpoint carries, shortest first, as "Cost (USD) / day $5" chips.
 *  A row with none draws on somebody else's budget and says so by staying empty. */
function LimitChips({ limits }: { limits: LLMEndpointOffer['limits'] }) {
  const { t } = useLingui();
  const set = LIMIT_KEYS.filter((key) => limits?.[key] != null);
  return (
    <div className="flex flex-wrap gap-1">
      {set.map((key) => (
        <Badge key={key} variant="outline" className="font-mono text-[11px]" data-testid={`llm-row-limit-${key}`}>
          {t(LIMIT_LABELS[key])} {formatAmount(key, limits[key] as number)}
        </Badge>
      ))}
    </div>
  );
}

export interface LlmEndpointsAssetListProps {
  /** URL-first: the row click hands back the pointer to navigate to. */
  onOpen: (pointer: DockPointer) => void;
}

export function LlmEndpointsAssetList({ onOpen }: LlmEndpointsAssetListProps) {
  const { endpoints, isLoading } = useMyEndpoints();
  // Registry, not a literal — the same rule the tree adapter follows.
  const EndpointIcon = iconForType('llm_endpoint');

  if (isLoading) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </div>
    );
  }
  if (endpoints.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="llm-endpoints-asset-empty">
        <div className="max-w-sm space-y-2 text-center">
          <EndpointIcon className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">
            <Trans>No budgets are allocated to you</Trans>
          </p>
          <p className="text-sm text-muted-foreground">
            <Trans>Endpoints appear here once the hub allocates one to you, or somebody shares theirs.</Trans>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-3" data-testid="llm-endpoints-asset-list">
      <div className="space-y-2">
        {endpoints.map((endpoint) => (
          <div
            key={endpoint.id}
            role="button"
            tabIndex={0}
            className="flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-md border p-3 text-start hover:bg-accent/50"
            data-testid={`llm-endpoint-row-${endpoint.id}`}
            onClick={() => onOpen(endpointAssetPointer(endpoint.id))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(endpointAssetPointer(endpoint.id));
              }
            }}
          >
            <EndpointIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="font-medium">{endpoint.name || endpoint.id}</span>
            <ProviderBadge provider={endpoint.provider} />
            {!endpoint.enabled && (
              <Badge variant="outline" className={TONE.amber}>
                <Trans>disabled</Trans>
              </Badge>
            )}
            <span className="flex-1" />
            <LimitChips limits={endpoint.limits} />
            <span onClick={(e) => e.stopPropagation()}>
              <TestEndpointButton endpointId={endpoint.id} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
