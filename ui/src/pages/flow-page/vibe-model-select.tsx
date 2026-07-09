import { WorkerModelTier } from '@sdk';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
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

export function VibeModelSelect({
  value,
  onChange,
  disabled = false,
  className,
  triggerClassName,
  testId = 'vibe-model-select',
}: VibeModelSelectProps) {
  const { t } = useLingui();
  const selected = normalizeVibeModelTier(value);
  const labels: Record<VibeModelTier, string> = {
    [WorkerModelTier.SM]: t`Fast`,
    [WorkerModelTier.MD]: t`Balanced`,
    [WorkerModelTier.LG]: t`Accurate`,
  };

  return (
    <Select
      value={selected}
      onValueChange={(next) => void onChange(normalizeVibeModelTier(next))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={t`Model`}
        title={labels[selected]}
        data-testid={testId}
        className={cn(
          'h-8 w-[112px] shrink-0 rounded-full border-border bg-background/70 px-2.5 text-xs shadow-none',
          triggerClassName,
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[8rem]">
        {VIBE_MODEL_TIERS.map((tier) => (
          <SelectItem key={tier} value={tier} data-testid={`vibe-model-option-${tier}`}>
            {labels[tier]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
