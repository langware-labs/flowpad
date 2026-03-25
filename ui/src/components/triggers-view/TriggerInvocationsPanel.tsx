import { Badge } from '@src/components/ui/badge';
import { cn } from '@src/lib/utils';
import { useTriggerLog } from '@src/hooks/useTriggerLog';
import type { ITrigger } from '@sdk';

interface Props {
  trigger: ITrigger | null;
}

const EVENT_LABELS: Record<string, string> = {
  schedule_fire: 'Scheduled',
  UserPromptSubmit: 'Prompt',
  PreToolUse: 'Pre-tool',
  PostToolUse: 'Post-tool',
  Stop: 'Stop',
};

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

  if (!trigger) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a trigger to view invocations
      </div>
    );
  }

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
            {entries.map((entry) => (
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
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {formatTs(entry.ts)}
                  </span>
                </div>
                {entry.reason && (
                  <p className="text-[10px] text-muted-foreground truncate">{entry.reason}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
