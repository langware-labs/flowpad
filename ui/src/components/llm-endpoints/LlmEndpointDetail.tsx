/**
 * One endpoint: header (name, kind, provider, enabled, credential) and three
 * tabs — Overview (chain tree + limits remaining + effective filters), Usage,
 * Models. The active tab is the URL's, so switching is a navigation.
 */
import type { LLMEndpoint, LLMEndpointKind } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@src/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { ChainTree } from './ChainTree';
import { consumerRows } from './chain-tree';
import { LimitsRemaining } from './LimitsRemaining';
import { CredentialChip, EndpointLink, KindBadge, ProviderBadge } from './LlmEndpointsList';
import { ModelsList } from './ModelsList';
import { UsagePanel } from './UsagePanel';
import { canConfigure, canRemove, canShare, endpointTypeId, kindFromChain } from './endpoint-catalog';
import { LLM_ENDPOINT_TABS, openLlmEndpoint, type LlmEndpointTab } from './llm-endpoints-pointer';
import { useLlmEndpointChain } from './use-llm-endpoints';

export interface LlmEndpointDetailProps {
  endpointId: string;
  /** null while the list has not resolved it (loading, or not visible). */
  endpoint: LLMEndpoint | null;
  tab: LlmEndpointTab;
  all: readonly LLMEndpoint[];
  onBack: () => void;
  onTab: (tab: LlmEndpointTab) => void;
  /** `kind` is the chain-resolved one; the entity's own is always `root`. */
  onEdit: (endpoint: LLMEndpoint, kind?: LLMEndpointKind | null) => void;
  onDelete: (endpoint: LLMEndpoint) => void;
  onShare: (endpoint: LLMEndpoint) => void;
}

function EffectiveFilters({ filters }: { filters: Record<string, unknown> }) {
  const entries = Object.entries(filters).filter(([, v]) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return v !== 'allow';
  });
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No narrowing — everything the roots allow.</Trans>
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="effective-filters">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <dt className="w-40 shrink-0 text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words font-mono text-xs">
            {Array.isArray(v)
              ? v.join(', ')
              : typeof v === 'object'
                ? JSON.stringify(v)
                : String(v as string | number | boolean)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LlmEndpointDetail({
  endpointId,
  endpoint,
  tab,
  all,
  onBack,
  onTab,
  onEdit,
  onDelete,
  onShare,
}: LlmEndpointDetailProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const chain = useLlmEndpointChain(endpointId);
  // Hop ids are typeids; the pointer is the bare uuid.
  const entryTypeId = endpointTypeId(endpointId);
  const entryHop = chain.data?.hops.find((h) => h.id === entryTypeId);
  // NOT `endpoint.kind`: that reads `sources`, which the hub does not serialize, so it answers
  // `root` for every endpoint. The chain report resolves the real graph — see `kindFromChain`.
  // `null` until it arrives, and the badges below render nothing rather than guess.
  const kind = kindFromChain(chain.data, endpointId);
  const openEndpoint = (id: string) => openLlmEndpoint(navigation, id);
  const consumers = useMemo(() => consumerRows(endpointId, all), [endpointId, all]);
  const tabLabels: Record<LlmEndpointTab, string> = { overview: t`Overview`, usage: t`Usage`, models: t`Models` };

  return (
    <div className="space-y-4" data-testid="llm-endpoint-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="llm-back">
          <ArrowLeft className="me-1 h-4 w-4" />
          <Trans>All endpoints</Trans>
        </Button>
        <h2 className="text-base font-semibold">{endpoint?.name ?? chain.data?.entry.name ?? endpointId}</h2>
        {kind && <KindBadge kind={kind} />}
        {kind === 'root' && <ProviderBadge provider={endpoint?.provider} />}
        {endpoint && !endpoint.enabled && (
          <span className="text-xs text-muted-foreground">
            <Trans>disabled</Trans>
          </span>
        )}
        {endpoint && kind && <CredentialChip endpoint={endpoint} kind={kind} />}
        <span className="flex-1" />
        {endpoint && canConfigure(endpoint) && (
          <Button variant="outline" size="sm" onClick={() => onEdit(endpoint, kind)} data-testid="llm-detail-edit">
            <Pencil className="me-1 h-3.5 w-3.5" />
            <Trans>Edit</Trans>
          </Button>
        )}
        {endpoint && canShare(endpoint) && (
          <Button variant="outline" size="sm" onClick={() => onShare(endpoint)} data-testid="llm-detail-share">
            <Trans>Share</Trans>
          </Button>
        )}
        {endpoint && canRemove(endpoint) && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(endpoint)}
            data-testid="llm-detail-delete"
          >
            <Trash2 className="me-1 h-3.5 w-3.5" />
            <Trans>Delete</Trans>
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => onTab(v as LlmEndpointTab)}>
        <TabsList>
          {LLM_ENDPOINT_TABS.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`llm-tab-${k}`}>
              {tabLabels[k]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === 'overview' && (
        <div className="space-y-6">
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">
                <Trans>Chain</Trans>
              </h3>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t`Refresh`}
                onClick={() => void chain.refetch()}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${chain.isFetching ? 'animate-spin' : ''}`} />
              </Button>
              {chain.data && chain.data.paths.length > 1 && (
                <span className="text-xs text-muted-foreground">{t`${chain.data.paths.length} fallback paths`}</span>
              )}
            </div>
            {chain.error && (
              <p className="text-sm text-destructive">
                <Trans>Could not resolve the chain.</Trans>
              </p>
            )}
            <ChainTree chain={chain.data} onOpen={openEndpoint} />
          </section>

          <section className="space-y-2" data-testid="llm-consumers">
            <h3 className="text-sm font-medium">
              <Trans>Used by</Trans>
            </h3>
            {consumers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No endpoint sources from this one.</Trans>
              </p>
            ) : (
              <ol className="space-y-0.5 text-sm">
                {consumers.map(({ endpoint: c, depth }) => (
                  <li
                    key={c.id}
                    data-testid={`consumer-node-${c.id}`}
                    data-depth={depth}
                    style={{ paddingInlineStart: `${depth * 1.25}rem` }}
                    className="flex items-center gap-2 px-1 py-0.5"
                  >
                    <span className="text-muted-foreground">{depth === 0 ? '┌' : '├'}</span>
                    <EndpointLink endpoint={c} onOpen={(e) => openEndpoint(e.id)} testId={`consumer-link-${c.id}`} />
                    {!c.enabled && (
                      <span className="text-xs text-muted-foreground">
                        <Trans>disabled</Trans>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">
              <Trans>Limits remaining</Trans>
            </h3>
            <LimitsRemaining hops={chain.data?.hops ?? []} />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">
              <Trans>Effective filters at this endpoint</Trans>
            </h3>
            <EffectiveFilters filters={(entryHop?.effective_filters ?? {}) as unknown as Record<string, unknown>} />
          </section>
        </div>
      )}

      {tab === 'usage' && <UsagePanel endpointId={endpointId} endpoint={endpoint} all={all} />}
      {tab === 'models' && <ModelsList endpointId={endpointId} all={all} />}
    </div>
  );
}
