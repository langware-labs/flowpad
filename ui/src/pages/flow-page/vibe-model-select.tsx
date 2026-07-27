import { capabilityManager, WorkerModelTier } from '@sdk';
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

interface VibeModelSelectProps {
  value: unknown;
  onChange: (value: VibeModelTier) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

/** Custom named model options defined for the default harness (its
 *  Capability.model_map, union of non-tier keys across providers). Read from the
 *  cached capability snapshot; empty until capabilities are loaded, in which case
 *  the selector behaves exactly as the tier-only version. */
function useCustomModelOptions(): string[] {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
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
    setOptions([...names]);
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
      onValueChange={(next) => void onChange(resolveValue(next) as VibeModelTier)}
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
