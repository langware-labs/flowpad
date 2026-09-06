import { PrefKey, WorkerModelTier } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { useOptionalHarnessCapabilities } from '@src/contexts/HarnessCapabilitiesContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';

export const VIBE_MODEL_DEFAULT = WorkerModelTier.MD;

const VIBE_MODEL_TIERS = [
  WorkerModelTier.SM,
  WorkerModelTier.MD,
  WorkerModelTier.LG,
] as const;

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

/** What the picker can emit: a tier, or a custom model NAME from the harness's
 *  `Capability.model_map`. Typing it `VibeModelTier` was a lie the component
 *  papered over with a cast — a custom name is legal and reaches `cli_config.model`. */
export type VibeModelChoice = string;

interface VibeModelSelectProps {
  value: unknown;
  onChange: (value: VibeModelChoice) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

/** Custom named model options defined for the default harness (its
 *  `Capability.model_map`, union of non-tier keys across providers).
 *
 *  Read from the app-wide `HarnessCapabilitiesProvider` rather than subscribing to
 *  the manager here: that provider exists precisely so each consumer does not add
 *  its own listener, and it already loads the capabilities this needs. Outside the
 *  app tree (isolated tests) there is no provider and the selector degrades to
 *  tier-only, which is the same "unknown means fail open" rule its consumers use. */
function useCustomModelOptions(): string[] {
  const harnesses = useOptionalHarnessCapabilities();
  const snapshot = harnesses?.defaultHarness;
  const kind = snapshot?.resolvedKind;
  const map = kind ? (snapshot?.capabilities.find((c) => c.kind === kind)?.model_map ?? {}) : {};
  return useMemo(() => {
    const tiers = VIBE_MODEL_TIERS as readonly string[];
    const names = new Set<string>();
    for (const perProvider of Object.values(map)) {
      for (const name of Object.keys(perProvider ?? {})) {
        if (!tiers.includes(name)) names.add(name);
      }
    }
    return [...names];
    // Keyed on the map's content, not its identity: `useCapability` hands back a
    // fresh object every render, so an identity dep would rebuild every time.
  }, [JSON.stringify(map)]);
}

export function VibeModelSelect({
  value,
  onChange,
  disabled = false,
  className,
  triggerClassName,
  testId = 'vibe-model-select',
}: VibeModelSelectProps) {
  const { t } = useLingui();
  const customOptions = useCustomModelOptions();
  // A known custom name passes straight through to cli_config.model (the backend
  // resolves it via the harness model_map); anything else normalizes to a tier.
  const resolveValue = (v: unknown): string =>
    typeof v === 'string' && customOptions.includes(v) ? v : normalizeVibeModelTier(v);
  const selected = resolveValue(value);
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
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={t`Model`}
        title={labelFor(selected)}
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
          <SelectItem key={tier} value={tier} data-testid={`vibe-model-option-${tier}`} className="py-1 text-xs">
            {labels[tier]}
          </SelectItem>
        ))}
        {customOptions.map((name) => (
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
