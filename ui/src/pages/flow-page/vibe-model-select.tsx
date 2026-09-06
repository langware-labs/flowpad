import { capabilityManager, PrefKey, WorkerModelTier } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import { useEffect, useState } from 'react';
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

/** What the picker can emit: one of the three tiers, or a custom model NAME from
 *  the harness's `Capability.model_map`. Typing this as `VibeModelTier` alone was
 *  a lie the component papered over with a cast — a custom name is a legal value
 *  and flows through to `cli_config.model`, which the backend resolves. */
export type VibeModelChoice = VibeModelTier | (string & {});

interface VibeModelSelectProps {
  value: unknown;
  onChange: (value: VibeModelChoice) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

/** Custom named model options defined for the default harness (its
 *  Capability.model_map, union of non-tier keys across providers).
 *
 *  SUBSCRIBED, not read once: capabilities load asynchronously, and on a cold
 *  surface (the Vibe home hero) the snapshot is still empty at mount, so a
 *  read-once effect with `[]` deps returned `resolvedKind === null` and never
 *  ran again — the custom options were permanently invisible there. Recompute
 *  whenever the manager says something changed. */
function useCustomModelOptions(): string[] {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    const recompute = () => {
      const kind = capabilityManager.getSnapshot('harness').resolvedKind;
      if (!kind) return;
      const map = capabilityManager.getSnapshot(kind).capability?.model_map ?? {};
      const tiers = VIBE_MODEL_TIERS as readonly string[];
      const names = new Set<string>();
      for (const perProvider of Object.values(map)) {
        for (const name of Object.keys(perProvider ?? {})) {
          if (!tiers.includes(name)) names.add(name);
        }
      }
      // Same contents => same array, so this cannot loop through the subscription.
      setOptions((prev) =>
        prev.length === names.size && prev.every((n) => names.has(n)) ? prev : [...names],
      );
    };
    recompute();
    return capabilityManager.subscribe(recompute);
  }, []);
  return options;
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
 * The Vibe build tier, persisted.
 *
 * One owner for a value three surfaces need (both hero composers and, in time,
 * the workspace chat pane). It is a `usePreference` rather than `useState`
 * because picking *Fast* is usually a COST decision, and a preference that
 * silently reverts to the expensive default on the next mount is worse than
 * none — a user who chose Fast then got billed for Balanced would be right to
 * call that a bug.
 */
export function useVibeModelTier(): [VibeModelChoice, (next: VibeModelChoice) => void] {
  const [stored, setStored] = usePreference<string>(PrefKey.VIBE_MODEL_TIER);
  // A custom model name passes through untouched; anything unrecognised (an
  // absent pref, a tier that no longer exists) normalizes to the default.
  const value: VibeModelChoice = typeof stored === 'string' && stored ? stored : VIBE_MODEL_DEFAULT;
  return [value, (next) => setStored(next)];
}
