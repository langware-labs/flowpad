import { LLM_MODEL_SIZES, TypeId, type Agent, type AgentTokenAllocation, type CloudDeployProvider } from '@sdk';
import { useDebounceCallback } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Info, Loader2, Settings2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { endpointTypeId, openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import {
  useLlmEndpointChain,
  useLlmEndpointModels,
  useLlmEndpoints,
} from '@src/components/llm-endpoints/use-llm-endpoints';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/** What a new cloud deployment gets per day when nobody changes it. */
const DEFAULT_COST_USD_PER_DAY = 5;
/** How long typing must pause before the model list is filtered. */
const MODEL_FILTER_DEBOUNCE_MS = 120;

export interface TokenAllocationFieldProps {
  agent: Agent;
  /** The environment the deployment is planned in (Configure plans it first). */
  environment: string;
  /** The hub provider the deployment lands on — its placement is per provider. */
  provider: CloudDeployProvider;
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
export function TokenAllocationField({
  agent,
  environment,
  provider,
  value,
  onChange,
  disabled,
}: TokenAllocationFieldProps) {
  const { t } = useLingui();
  // The hub's own list of the budgets this person may carve a sub-budget from (its `allocate` right: an
  // admin's pools, and their own allowance as its holder). Read from the HUB, not the desktop's funding
  // view, so the hub page works with no desktop attached.
  const { endpoints, isLoading } = useLlmEndpoints();
  const sources = useMemo(() => endpoints.filter((e) => e.canAllocate), [endpoints]);
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
            source: '',
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
        {noSources && (
          // Never a silently disabled box: say why it cannot be checked.
          <span className="text-xs text-destructive" data-testid="token-allocation-no-sources">
            <Trans>No budget you can allocate from — ask its admin for an allowance.</Trans>
          </span>
        )}
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
            <ConfigureButton
              agent={agent}
              environment={environment}
              provider={provider}
              value={value}
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** The model: a SIZE (sm/md/lg — the source's chain says which model each is) or one model the source offers. */
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
  const [open, setOpen] = useState(false);
  // What is typed, and what the list is filtered by once typing pauses.
  const [typed, setTyped] = useState('');
  const [needle, setNeedle] = useState('');
  const filterBy = useDebounceCallback(setNeedle, MODEL_FILTER_DEBOUNCE_MS, []);
  const sourceId = value.source ? new TypeId(value.source).id : undefined;
  const models = useLlmEndpointModels(sourceId);
  const chain = useLlmEndpointChain(sourceId);
  const ids = useMemo(() => [...new Set((models.data ?? []).map((m) => m.id))].sort(), [models.data]);
  // The sizes the source's chain declares, each with the model it resolves to.
  const sizes = LLM_MODEL_SIZES.flatMap((size) => {
    const model = chain.data?.effective_tiers?.[size]?.model;
    return model ? [{ size, model }] : [];
  });
  // The only model the source offers and no size to choose instead: nothing to choose, so it is the one.
  useEffect(() => {
    if (!sizes.length && ids.length === 1 && value.model !== ids[0]) onChange({ ...value, model: ids[0] });
  }, [ids, sizes.length, value, onChange]);
  const sizeOf = (model: string) => sizes.find((s) => s.size === model);
  // Until the source's models are known (none picked, loading, or the hub refused), the model is typed.
  if (ids.length === 0 && sizes.length === 0) {
    return (
      <Input
        className="h-8 min-w-0 flex-1 font-mono text-xs"
        value={value.model}
        placeholder={models.isLoading ? t`Loading models…` : t`Model`}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, model: e.target.value.trim() })}
        aria-label={t`Model`}
        data-testid="token-allocation-model"
      />
    );
  }
  // The agent's own model, kept selectable when the source does not list it under that name.
  const offered = value.model && !ids.includes(value.model) && !sizeOf(value.model) ? [value.model, ...ids] : ids;
  const q = needle.trim().toLowerCase();
  const rows = q ? offered.filter((id) => id.toLowerCase().includes(q)) : offered;
  return (
    // Modal: it opens over a dialog, whose scroll lock otherwise swallows the wheel on this portaled list.
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t`Model`}
          disabled={disabled}
          className="h-8 min-w-0 flex-1 justify-between px-2 font-mono text-xs font-normal"
          data-testid="token-allocation-model"
        >
          <span className={cn('truncate', !value.model && 'text-muted-foreground')}>
            {sizeOf(value.model) ? `${value.model} · ${sizeOf(value.model)?.model}` : value.model || t`Choose a model…`}
          </span>
          <ChevronsUpDown className="ms-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t`Filter models…`}
            value={typed}
            onValueChange={(next) => {
              setTyped(next);
              filterBy(next);
            }}
          />
          <CommandList>
            <CommandEmpty>
              <Trans>No models.</Trans>
            </CommandEmpty>
            {!q &&
              sizes.map(({ size, model }) => (
                <CommandItem
                  key={size}
                  value={size}
                  onSelect={() => {
                    onChange({ ...value, model: size });
                    setOpen(false);
                  }}
                  data-testid={`token-allocation-size-${size}`}
                >
                  <Check className={cn('me-2 h-3.5 w-3.5', value.model === size ? 'opacity-100' : 'opacity-0')} />
                  <span className="w-6 font-mono text-xs font-medium">{size}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{model}</span>
                </CommandItem>
              ))}
            {rows.map((id) => (
              <CommandItem
                key={id}
                value={id}
                onSelect={() => {
                  onChange({ ...value, model: id });
                  setOpen(false);
                }}
                data-testid={`token-allocation-model-${id}`}
              >
                <Check className={cn('me-2 h-3.5 w-3.5', value.model === id ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate font-mono text-xs">{id}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Plans the deployment with this allocation (so it exists) and opens it in the LLM endpoint editor. Its own
 * component: it navigates, and only a checked allocation shows it.
 */
function ConfigureButton({
  agent,
  environment,
  provider,
  value,
  disabled,
}: {
  agent: Agent;
  environment: string;
  provider: CloudDeployProvider;
  value: AgentTokenAllocation;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [configuring, setConfiguring] = useState(false);

  const configure = async () => {
    setConfiguring(true);
    try {
      const planned = await agent.planDeployment(environment, provider, value);
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
      disabled={disabled || configuring || !tokenAllocationComplete(value)}
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
