import { AgenticProcess, Project } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { toast } from '@src/hooks/use-toast';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  acknowledgePending,
  formatTimeAgo,
  useActiveProcesses,
} from '@src/store/pending-actions-store';
import { useMemo, useState } from 'react';
import { useNotificationPulse } from './useNotificationPulse';
import { workerStatusLabel } from './worker-status-label';

/**
 * Footer chip — live "agents at work" surface.
 *
 * Count = active AgenticProcesses (burning tokens ∪ in pending-input
 * window). Per-row glow on processes in the pending set, identical to
 * the tab-strip glow (`animate-pending-glow`). A one-shot 3 s chip
 * pulse fires alongside the notification sound when a new id enters
 * pending — the pulse is decorative only, doesn't affect membership.
 *
 * Known limitation: row name / project name come from
 * `*.getByIdFromCache(id)?.name` and are NOT reactive — a rename in
 * another surface won't update an open popover until the row's data
 * (status, last-active-time) changes for an unrelated reason.
 */
export function PendingActionsChip() {
  const entries = useActiveProcesses();
  const [open, setOpen] = useState(false);
  const { navigation } = useDockNavigation();
  const pulsing = useNotificationPulse(3000);

  const rows = useMemo(
    () =>
      entries.map((e) => ({
        processId: e.processId,
        name: AgenticProcess.getByIdFromCache<AgenticProcess>(e.processId)?.name
          ?? e.processId.slice(0, 8),
        projectName: e.projectId
          ? Project.getByIdFromCache<Project>(e.projectId)?.name ?? null
          : null,
        statusLabel: workerStatusLabel(e.workerStatus, e.pending),
        lastActive: formatTimeAgo(e.lastStatusChangedAt),
        pending: e.pending,
      })),
    [entries],
  );

  if (rows.length === 0) return null;

  const tooltipText = `${rows.length} active agent${rows.length === 1 ? '' : 's'}`;

  const handlePick = async (processId: string) => {
    setOpen(false);
    try {
      const opened = await navigation.openShellProcess(processId);
      if (!opened) {
        toast({
          title: 'Process unavailable',
          description: 'That agent is no longer in your workspace.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      // Server fetch threw (404, network error) — same UX as the
      // null-return branch: tell the user, then ack so the dead row
      // doesn't haunt the chip.
      console.error('[PendingActionsChip] openShellProcess threw', err);
      toast({
        title: 'Process unavailable',
        description: 'That agent is no longer in your workspace.',
        variant: 'destructive',
      });
    } finally {
      // Ack either way — clears the row's glow if the process was in the
      // pending set. No-op if it was only burning (no readyAt to mark).
      acknowledgePending(processId);
    }
  };

  const chipClass = [
    'flex h-5 w-5 items-center justify-center rounded-md bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-1 focus:ring-ring',
    pulsing ? 'animate-pending-glow-once' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="pending-actions-chip"
                aria-label={tooltipText}
                className={chipClass}
              >
                {rows.length}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipText}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          className="w-80 p-1"
          data-testid="pending-actions-popover"
        >
          <ul className="flex flex-col">
            {rows.map((row) => {
              const rowClass = [
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted',
                row.pending ? 'animate-pending-glow' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <li key={row.processId}>
                  <button
                    type="button"
                    onClick={() => void handlePick(row.processId)}
                    className={rowClass}
                    data-pending={row.pending ? 'true' : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{row.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {row.statusLabel}
                        {row.projectName ? ` · ${row.projectName}` : ''}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {row.lastActive}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
