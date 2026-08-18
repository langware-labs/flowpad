import { Select, SelectContent, SelectItem, SelectTrigger } from '@src/components/ui/select';
import { cn } from '@src/lib/utils';
import { LAUNCHABLE_WORKERS, normalizeWorkerType, type WorkerType } from './worker-types';
import { useHarnessAvailability } from './harness-availability';
import { OpenerWarningBadge } from '@src/components/terminal/openers/OpenerWarningBadge';
import { openCapabilitiesForWorker } from '@src/navigation/open-capabilities';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { workerIcon, workerLabel } from '@src/components/lens-viewer/shared/transcript-features/transcript-utils';
import { useLingui } from '@lingui/react/macro';

export interface WorkerTypeSelectProps {
  value: string | null | undefined;
  onChange: (value: WorkerType) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}

/**
 * Shared worker selector used by Vibe settings and transcript recovery notices.
 *
 * A harness that failed its capability check is rendered exactly as the "+"
 * new-tab menu renders it — the vendor icon carrying an `OpenerWarningBadge`,
 * the check's own message in the row's tooltip — and picking it routes to the
 * Capabilities view instead of switching. Moving a chat onto a harness that
 * isn't installed used to succeed here and fail much later, at process
 * creation, by which point the user was on another page (FLOWPAD-1976).
 */
export function WorkerTypeSelect({
  value,
  onChange,
  disabled = false,
  className,
  triggerClassName,
  testId = 'vibe-worker-select',
}: WorkerTypeSelectProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { warnings, probeHarnesses } = useHarnessAvailability();
  const selected = normalizeWorkerType(value);
  const SelectedIcon = workerIcon(selected);

  // Same enforcement point as `TerminalOpenerToolbar.activate`: a warned choice
  // can't be honored, so send the user where they can fix it. The kind rides
  // along so that view re-probes THIS harness on arrival — the warning may be
  // stale, since discovery only sweeps at backend start.
  const handleValueChange = (next: string) => {
    const worker = normalizeWorkerType(next);
    if (warnings[worker]) {
      openCapabilitiesForWorker(navigation, worker);
      return;
    }
    void onChange(worker);
  };

  return (
    <Select
      value={selected}
      onValueChange={handleValueChange}
      onOpenChange={(open) => {
        if (open) probeHarnesses();
      }}
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
          const warning = warnings[worker];
          return (
            <SelectItem
              key={worker}
              value={worker}
              data-testid={`vibe-worker-option-${worker}`}
              data-warning={warning ? 'true' : undefined}
              title={warning ?? undefined}
              className="py-1 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <span className="relative inline-flex">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {warning && <OpenerWarningBadge id={worker} />}
                </span>
                {workerLabel(worker)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
