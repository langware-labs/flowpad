import { llmSourcesService, type Agent, type AgentTokenAllocation, type LLMEndpointOffer } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { Info, Loader2, Settings2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { endpointTypeId, openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { useLlmEndpointModels } from '@src/components/llm-endpoints/use-llm-endpoints';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** What a new cloud deployment gets per day when nobody changes it. */
const DEFAULT_COST_USD_PER_DAY = 5;

export interface TokenAllocationFieldProps {
  agent: Agent;
  /** The environment the deployment is planned in (Configure plans it first). */
  environment: string;
  /** `null` = unchecked: the agent spends its owner's capped default. */
  value: AgentTokenAllocation | null;
  onChange: (next: AgentTokenAllocation | null) => void;
  disabled?: boolean;
}

/**
 * "Token allocation": the cloud deployment's own budget, drawn from an endpoint the user administers — a daily
 * cap and the one model it runs. Unchecked, the deployed agent spends its owner's capped default. "Configure"
 * plans the deployment with this allocation (so it exists) and opens it in the LLM endpoint editor for the
 * rest of its limits.
 */
export function TokenAllocationField({ agent, environment, value, onChange, disabled }: TokenAllocationFieldProps) {
  const { t } = useLingui();
  // The hub endpoints offered to this person, as the desk's funding view knows them; allocating from one
  // takes administering it (the hub checks the same right).
  const [offers, setOffers] = useState<LLMEndpointOffer[] | null>(null);
  useEffect(() => {
    let live = true;
    llmSourcesService
      .status()
      .then((status) => live && setOffers(status?.available ?? []))
      .catch(() => live && setOffers([]));
    return () => {
      live = false;
    };
  }, []);
  const isLoading = offers === null;
  const sources = useMemo(() => (offers ?? []).filter((e) => e.kind === 'hub' && e.can_administer === true), [offers]);
  const checked = value !== null;

  // A source picked, or the only one there is: fill what the user has not chosen yet.
  useEffect(() => {
    if (checked && !value.source && sources.length === 1) {
      onChange({ ...value, source: endpointTypeId(sources[0].id) });
    }
  }, [checked, value, sources, onChange]);

  const toggle = (on: boolean) =>
    onChange(
      on
        ? {
            source: sources.length === 1 ? endpointTypeId(sources[0].id) : '',
            cost_usd_per_day: DEFAULT_COST_USD_PER_DAY,
            model: agent.model || '',
          }
        : null,
    );

  const noSources = !isLoading && sources.length === 0;

  return (
    <div className="flex flex-col gap-2" data-testid="token-allocation">
      <div className="flex items-center gap-2">
        <Checkbox
          id="token-allocation"
          checked={checked}
          disabled={disabled || noSources}
          onCheckedChange={(on) => toggle(on === true)}
          data-testid="token-allocation-toggle"
        />
        <Label htmlFor="token-allocation" className="text-xs">
          <Trans>Token allocation</Trans>
        </Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground" data-testid="token-allocation-info" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              {noSources ? (
                <Trans>
                  You administer no LLM endpoint to allocate from, so this agent spends your capped default.
                </Trans>
              ) : (
                <Trans>
                  Give this deployment its own model budget, drawn from an LLM endpoint you administer: a daily cap and
                  the one model it runs. Unchecked, the agent spends your capped default. Deleted with the deployment.
                </Trans>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {checked && (
        <div className="flex flex-col gap-2 ps-6">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={value.source}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, source: e.target.value })}
            aria-label={t`Token source`}
            data-testid="token-allocation-source"
          >
            <option value="">{t`Choose a token source…`}</option>
            {sources.map((e) => (
              <option key={e.id} value={endpointTypeId(e.id)}>
                {e.name}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="token-allocation-budget" className="text-xs">
              <Trans>$/day</Trans>
            </Label>
            <Input
              id="token-allocation-budget"
              type="number"
              min={0}
              step="0.5"
              className="h-8 w-24 text-xs"
              value={value.cost_usd_per_day ?? ''}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...value, cost_usd_per_day: e.target.value === '' ? null : Number(e.target.value) })
              }
              data-testid="token-allocation-budget"
            />
            <ModelField value={value} onChange={onChange} disabled={disabled} />
            <ConfigureButton agent={agent} environment={environment} value={value} disabled={disabled} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The one model: free text, suggested from the models the chosen source offers. */
function ModelField({
  value,
  onChange,
  disabled,
}: {
  value: AgentTokenAllocation;
  onChange: (next: AgentTokenAllocation) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const models = useLlmEndpointModels(value.source || undefined);
  return (
    <>
      <Input
        className="h-8 min-w-0 flex-1 font-mono text-xs"
        list="token-allocation-models"
        value={value.model}
        placeholder={t`Model`}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, model: e.target.value.trim() })}
        aria-label={t`Model`}
        data-testid="token-allocation-model"
      />
      <datalist id="token-allocation-models">
        {(models.data ?? []).map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
    </>
  );
}

/**
 * Plans the deployment with this allocation (so it exists) and opens it in the LLM endpoint editor. Its own
 * component: it navigates, and only a checked allocation shows it.
 */
function ConfigureButton({
  agent,
  environment,
  value,
  disabled,
}: {
  agent: Agent;
  environment: string;
  value: AgentTokenAllocation;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [configuring, setConfiguring] = useState(false);

  const configure = async () => {
    setConfiguring(true);
    try {
      const planned = await agent.planDeployment(environment, value);
      const allocation = planned.deployment?.llm_endpoint_typeid;
      if (allocation) openLlmEndpoint(navigation, allocation);
    } catch (e) {
      notify.error({ title: t`Could not set the token allocation`, message: errorMessage(e, t`Failed.`) });
    } finally {
      setConfiguring(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8"
      disabled={disabled || configuring || !value.source || !value.model}
      onClick={() => void configure()}
      data-testid="token-allocation-configure"
    >
      {configuring ? <Loader2 className="me-1 h-3.5 w-3.5 animate-spin" /> : <Settings2 className="me-1 h-3.5 w-3.5" />}
      <Trans>Configure</Trans>
    </Button>
  );
}

/** Whether a checked allocation says enough to deploy with. */
export function tokenAllocationComplete(value: AgentTokenAllocation | null): boolean {
  return value === null || (!!value.source && !!value.model);
}
