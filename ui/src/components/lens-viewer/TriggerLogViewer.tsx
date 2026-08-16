import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { formatTimeAgo } from '@src/components/project-activity-strip/project-activity-utils';
import { cn } from '@src/lib/utils';
import { ActionInfo, dataManager } from '@sdk';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface TriggerLogEntry {
  id: string;
  ts: string;
  hook_event: string;
  trigger: boolean;
  reason: string;
  is_test: boolean;
  rule_name: string;
  actions: string[];
}

function timeAgo(iso: string): string {
  return formatTimeAgo(iso) || 'just now';
}

interface Props {
  triggerId: string;
}

export function TriggerLogViewer({ triggerId }: Props) {
  const [entries, setEntries] = useState<TriggerLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggeredOnly, setTriggeredOnly] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const action = new ActionInfo('log', 'trigger', triggerId, 'GET');
      action.queryParameters = {
        limit: '500',
        ...(triggeredOnly ? { triggered_only: 'true' } : {}),
      };
      const data = await dataManager.callAction<undefined, TriggerLogEntry[]>(action);
      if (Array.isArray(data)) setEntries(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [triggerId, triggeredOnly]);

  useEffect(() => {
    setLoading(true);
    void fetchEntries();
    intervalRef.current = setInterval(() => {
      void fetchEntries();
    }, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchEntries]);

  const ruleName = entries[0]?.rule_name || triggerId;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="font-mono text-sm font-medium">{ruleName}</span>
        <span className="text-xs text-muted-foreground">trigger log</span>
        <Badge variant="secondary" className="text-[10px]">
          {entries.length}
        </Badge>

        <div className="ms-auto flex items-center gap-2">
          {/* Filter toggle */}
          <div className="flex rounded border">
            <button
              onClick={() => setTriggeredOnly(false)}
              className={cn(
                'px-2 py-0.5 text-[10px] transition-colors',
                !triggeredOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              All calls
            </button>
            <button
              onClick={() => setTriggeredOnly(true)}
              className={cn(
                'px-2 py-0.5 text-[10px] transition-colors',
                triggeredOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              Activations only
            </button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              setLoading(true);
              void fetchEntries();
            }}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-auto">
        {loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No log entries. Run or test this trigger to see entries.
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 border-b px-3 py-1.5 text-xs hover:bg-muted/30">
              {/* Timestamp */}
              <span className="w-16 flex-shrink-0 text-[10px] text-muted-foreground" title={entry.ts}>
                {timeAgo(entry.ts)}
              </span>

              {/* Hook event */}
              <Badge variant="outline" className="h-4 flex-shrink-0 px-1 text-[9px]">
                {entry.hook_event || 'unknown'}
              </Badge>

              {/* Triggered badge */}
              <span
                className={cn(
                  'flex-shrink-0 text-[10px] font-medium',
                  entry.trigger ? 'text-green-500' : 'text-muted-foreground',
                )}
              >
                {entry.trigger ? '✓' : '–'}
              </span>

              {/* Reason */}
              <span className="flex-1 truncate text-muted-foreground" title={entry.reason}>
                {entry.reason || (entry.trigger ? 'triggered' : 'not triggered')}
              </span>

              {/* Actions */}
              {entry.actions.length > 0 && (
                <div className="flex gap-1">
                  {entry.actions.map((a, i) => (
                    <Badge key={i} variant="secondary" className="h-4 px-1 text-[9px]">
                      {a}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Test badge */}
              {entry.is_test && (
                <Badge
                  variant="outline"
                  className="h-4 flex-shrink-0 border-orange-400 px-1 text-[9px] text-orange-500"
                >
                  test
                </Badge>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
