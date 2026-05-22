import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { useTriggerLog } from '@src/hooks/useTriggerLog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { StatusIndicator } from '@src/components/agentic-progress/shared/status-indicator';
import { AgenticProcess, ProcessType, Trigger, TypeId, type ITrigger, type ProcessStatus } from '@sdk';
import { useProcessesForTarget } from '@src/components/entity-execution-panel';
import { ExternalLink } from 'lucide-react';
import { useMemo } from 'react';

interface Props {
  trigger: ITrigger | null;
}

const EVENT_LABELS: Record<string, string> = {
  schedule_fire: 'Scheduled',
  file_change: 'File change',
  UserPromptSubmit: 'Prompt',
  PreToolUse: 'Pre-tool',
  PostToolUse: 'Post-tool',
  Stop: 'Stop',
};

/** Trim a long path to a readable head…tail when shown inline. */
function shortenPath(p: string, max = 56): string {
  if (p.length <= max) return p;
  const head = Math.floor(max * 0.45);
  const tail = max - head - 1;
  return `${p.slice(0, head)}…${p.slice(p.length - tail)}`;
}

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

export function TriggerInvocationsPanel({ trigger }: Props) {
  const { entries, isLoading } = useTriggerLog(trigger?.id ?? null);
  const { navigation } = useDockNavigation();

  // Subscribe to all agentic processes this trigger spawned so each row can show
  // live status. Shares the generic `useProcessesForTarget` hook with EntityExecutionPanel.
  const targetStr = useMemo(
    () => (trigger?.id ? new TypeId(Trigger.type, trigger.id).toString() : ''),
    [trigger?.id],
  );
  const { processes } = useProcessesForTarget(targetStr, {
    enabled: !!trigger?.id,
    processType: ProcessType.Execution,
  });

  const processById = useMemo(() => {
    const map = new Map<string, AgenticProcess>();
    for (const p of processes) {
      if (p.id) map.set(p.id, p);
    }
    return map;
  }, [processes]);

  if (!trigger) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a trigger to view invocations
      </div>
    );
  }

  const handleOpen = (processId: string) => {
    const proc = processById.get(processId);
    if (proc) {
      navigation.openDock(proc.dockPointer);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">Invocations</span>
        {entries.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">{entries.length}</Badge>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
            No invocations yet
          </div>
        ) : (
          <div className="divide-y">
            {entries.map((entry) => {
              const proc = entry.agentic_process_id ? processById.get(entry.agentic_process_id) : undefined;
              const status = proc?.status as ProcessStatus | undefined;
              return (
                <div key={entry.id} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Badge
                      variant={entry.trigger ? 'default' : 'secondary'}
                      className={cn(
                        'h-4 px-1 text-[9px]',
                        entry.trigger ? 'bg-green-500/20 text-green-700 dark:text-green-400' : '',
                      )}
                    >
                      {entry.trigger ? '✓' : '–'}
                    </Badge>
                    <span className="font-medium">
                      {EVENT_LABELS[entry.hook_event] ?? entry.hook_event}
                    </span>
                    {entry.is_test && (
                      <Badge variant="outline" className="h-4 px-1 text-[9px]">test</Badge>
                    )}
                    {status && (
                      <StatusIndicator status={status} size="sm" className="ml-1" />
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {formatTs(entry.ts)}
                    </span>
                    {entry.agentic_process_id && proc && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            onClick={() => handleOpen(entry.agentic_process_id!)}
                          >
                            <ExternalLink className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Open process</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  {/* Type-aware row body. Falls back to the legacy reason
                      string when no structured fields are present (pre-Chunk-C
                      entries + hook entries). */}
                  {(entry.event_kind === 'file_change' || entry.event_kind === 'test') && entry.changed_path ? (
                    <div className="flex items-center gap-1.5">
                      {entry.change_type && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">
                          {entry.change_type}
                        </Badge>
                      )}
                      <span
                        className="truncate font-mono text-[10px] text-muted-foreground"
                        title={entry.changed_path}
                      >
                        {shortenPath(entry.changed_path)}
                      </span>
                    </div>
                  ) : entry.reason ? (
                    <p className="text-[10px] text-muted-foreground truncate">{entry.reason}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
