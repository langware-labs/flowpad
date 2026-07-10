import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import {
  LAUNCHABLE_WORKERS,
  normalizeWorkerType,
  type WorkerType,
} from '@src/components/workers/worker-types';
import {
  workerIcon,
  workerLabel,
} from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { useLingui } from '@lingui/react/macro';

interface VibeWorkerSelectProps {
  value: string | null | undefined;
  onChange: (value: WorkerType) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

export function VibeWorkerSelect({
  value,
  onChange,
  disabled = false,
  className,
  triggerClassName,
  testId = 'vibe-worker-select',
}: VibeWorkerSelectProps) {
  const { t } = useLingui();
  const selected = normalizeWorkerType(value);
  const SelectedIcon = workerIcon(selected);

  return (
    <Select
      value={selected}
      onValueChange={(next) => void onChange(normalizeWorkerType(next))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={t`Worker`}
        title={workerLabel(selected)}
        data-testid={testId}
        className={cn(
          'h-7 w-auto min-w-[146px] shrink-0 rounded-md border-input bg-background px-2 text-xs shadow-none',
          triggerClassName,
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-muted-foreground">{t`Worker`}:</span>
          <SelectedIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{workerLabel(selected)}</span>
        </div>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[7.75rem]">
        {LAUNCHABLE_WORKERS.map((worker) => {
          const Icon = workerIcon(worker);
          return (
            <SelectItem
              key={worker}
              value={worker}
              data-testid={`vibe-worker-option-${worker}`}
              className="py-1 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {workerLabel(worker)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
