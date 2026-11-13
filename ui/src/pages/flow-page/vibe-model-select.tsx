import { PrefKey, WorkerModelTier } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import { useLingui } from '@lingui/react/macro';

export const VIBE_MODEL_DEFAULT = WorkerModelTier.MD;

const VIBE_MODEL_TIERS = [WorkerModelTier.SM, WorkerModelTier.MD, WorkerModelTier.LG] as const;

export type VibeModelTier = (typeof VIBE_MODEL_TIERS)[number];

const TIER_ALIASES: Record<string, VibeModelTier> = {
  haiku: WorkerModelTier.SM,
  sonnet: WorkerModelTier.MD,
  opus: WorkerModelTier.LG,
};

export function normalizeVibeModelTier(value: unknown): VibeModelTier {
  if (value === WorkerModelTier.SM || value === WorkerModelTier.MD || value === WorkerModelTier.LG) {
    return value;
  }
  if (typeof value === 'string') {
    return TIER_ALIASES[value] ?? VIBE_MODEL_DEFAULT;
  }
  return VIBE_MODEL_DEFAULT;
}

/** What the picker can emit: a tier, or a custom model NAME the funding endpoint declares
 *  beside its sizes (`customNames`). Typing it `VibeModelTier` was a lie the component
 *  papered over with a cast — a custom name is legal and reaches `cli_config.model`. */
export type VibeModelChoice = string;

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
  // A known custom name passes straight through to cli_config.model (the backend
  // resolves it from the funding endpoint's tiers); anything else normalizes to a tier.
  const resolveValue = (v: unknown): string =>
    typeof v === 'string' && customNames.includes(v) ? v : normalizeVibeModelTier(v);
  const selected = pinnedSize ? resolveValue(pinnedSize) : resolveValue(value);
  // A size the budget does not offer cannot be run: it is listed, so the person sees it exists, but not pickable.
  const offered = (tier: string) => !availableSizes || availableSizes.includes(tier);
  const labels: Record<string, string> = {
    [WorkerModelTier.SM]: t`Fast`,
    [WorkerModelTier.MD]: t`Balanced`,
    [WorkerModelTier.LG]: t`Accurate`,
  };
  const labelFor = (v: string) => labels[v] ?? v;

  return (
    <Select
      value={selected}
      onValueChange={(next) => void onChange(resolveValue(next))}
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

/**
 * The Vibe build tier — one owner for the value every Vibe surface starts a build
 * with, persisted so a Fast choice survives a remount rather than silently
 * reverting to the pricier default.
 */
export function useVibeModelTier(): [VibeModelChoice, (next: VibeModelChoice) => void] {
  // `usePreference` already resolves an unset key to the registry default and
  // returns a `useCallback`-stable setter; only an explicitly-stored empty string
  // needs a fallback here.
  const [stored, setStored] = usePreference<string>(PrefKey.VIBE_MODEL_TIER);
  return [stored || VIBE_MODEL_DEFAULT, setStored];
}
