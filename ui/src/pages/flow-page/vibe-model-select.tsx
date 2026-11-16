import { WorkerModelTier } from '@sdk';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import { useLingui } from '@lingui/react/macro';

export const VIBE_MODEL_DEFAULT = null;
const ENDPOINT_DEFAULT_OPTION = '__endpoint_default__';

const VIBE_MODEL_TIERS = [WorkerModelTier.SM, WorkerModelTier.MD, WorkerModelTier.LG] as const;

export type VibeModelTier = (typeof VIBE_MODEL_TIERS)[number];

const TIER_ALIASES: Record<string, VibeModelTier> = {
  haiku: WorkerModelTier.SM,
  sonnet: WorkerModelTier.MD,
  opus: WorkerModelTier.LG,
};

export function normalizeVibeModelTier(value: unknown): VibeModelChoice {
  if (value === WorkerModelTier.SM || value === WorkerModelTier.MD || value === WorkerModelTier.LG) {
    return value;
  }
  if (typeof value === 'string') {
    return TIER_ALIASES[value] ?? (value || null);
  }
  return VIBE_MODEL_DEFAULT;
}

/** Null delegates to the endpoint; a tier, custom name, or concrete ID is an explicit choice. */
export type VibeModelChoice = string | null;

interface VibeModelSelectProps {
  value: unknown;
  onChange: (value: VibeModelChoice) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
  /** The sizes the budget funding this session offers; `null` = not known, nothing is held back. */
  availableSizes?: readonly string[] | null;
  /** A size the agent requires: the picker shows it and does not offer to leave it. */
  pinnedSize?: string | null;
  /** Custom named models the endpoint funding this session declares beside its sizes (any
   *  non-size `tiers` key, e.g. `coding`); offered after the sizes. */
  customNames?: readonly string[];
}

const NO_CUSTOM_NAMES: readonly string[] = [];

export function VibeModelSelect({
  value,
  onChange,
  disabled = false,
  className,
  triggerClassName,
  testId = 'vibe-model-select',
  availableSizes = null,
  pinnedSize = null,
  customNames = NO_CUSTOM_NAMES,
}: VibeModelSelectProps) {
  const { t } = useLingui();
  // Concrete IDs and custom names stay explicit; null leaves resolution to the endpoint.
  const resolveValue = (v: unknown): VibeModelChoice =>
    typeof v === 'string' && customNames.includes(v) ? v : normalizeVibeModelTier(v);
  const selected = (pinnedSize ? resolveValue(pinnedSize) : resolveValue(value)) ?? ENDPOINT_DEFAULT_OPTION;
  // A size the budget does not offer cannot be run: it is listed, so the person sees it exists, but not pickable.
  const offered = (tier: string) => !availableSizes || availableSizes.includes(tier);
  const labels: Record<string, string> = {
    [ENDPOINT_DEFAULT_OPTION]: t`Endpoint default`,
    [WorkerModelTier.SM]: t`Fast`,
    [WorkerModelTier.MD]: t`Balanced`,
    [WorkerModelTier.LG]: t`Accurate`,
  };
  const labelFor = (v: string) => labels[v] ?? v;

  return (
    <Select
      value={selected}
      onValueChange={(next) => void onChange(next === ENDPOINT_DEFAULT_OPTION ? null : resolveValue(next))}
      disabled={disabled || !!pinnedSize}
    >
      <SelectTrigger
        aria-label={t`Model`}
        title={pinnedSize ? t`The agent requires this model size` : labelFor(selected)}
        data-testid={testId}
        className={cn(
          'h-7 w-auto min-w-[142px] shrink-0 rounded-md border-input bg-background px-2 text-xs shadow-none',
          triggerClassName,
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground">{t`Model`}:</span>
          <span className="truncate">{labelFor(selected)}</span>
        </div>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[7.75rem]">
        <SelectItem value={ENDPOINT_DEFAULT_OPTION} data-testid="vibe-model-option-default" className="py-1 text-xs">
          {labels[ENDPOINT_DEFAULT_OPTION]}
        </SelectItem>
        {VIBE_MODEL_TIERS.map((tier) => (
          <SelectItem
            key={tier}
            value={tier}
            disabled={!offered(tier)}
            data-testid={`vibe-model-option-${tier}`}
            className="py-1 text-xs"
          >
            {labels[tier]}
          </SelectItem>
        ))}
        {customNames.map((name) => (
          <SelectItem key={name} value={name} data-testid={`vibe-model-option-${name}`} className="py-1 text-xs">
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
