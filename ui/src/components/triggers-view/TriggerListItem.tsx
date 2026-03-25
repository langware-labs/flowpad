import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { ActionInfo, dataManager, type ITrigger } from '@sdk';
import { FlaskConical, ScrollText } from 'lucide-react';
import { useState } from 'react';

const SCOPE_COLORS: Record<string, string> = {
  system: 'bg-muted text-muted-foreground',
  user: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  project: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
};

interface Props {
  trigger: ITrigger;
  isSelected: boolean;
  onSelect: () => void;
  onOpenLog: () => void;
  onLogModeChange: (mode: string) => void;
}

export function TriggerListItem({ trigger, isSelected, onSelect, onOpenLog, onLogModeChange }: Props) {
  const [testing, setTesting] = useState(false);

  const handleTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!trigger.id) return;
    setTesting(true);
    try {
      const action = new ActionInfo('test', 'trigger', trigger.id, 'POST');
      await dataManager.callAction(action);
      onOpenLog();
    } catch {
      // ignore
    } finally {
      setTesting(false);
    }
  };

  const handleLogModeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const mode = e.target.value;
    if (!trigger.id) return;
    try {
      const action = new ActionInfo('meta', 'trigger', trigger.id, 'PATCH');
      action.bodyParameters = { log_mode: mode };
      await dataManager.callAction(action);
      onLogModeChange(mode);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={cn(
        'flex cursor-pointer flex-col gap-1 border-b px-3 py-2 text-xs transition-colors hover:bg-muted/50',
        isSelected && 'bg-muted',
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('rounded px-1 py-0.5 text-[10px] font-medium', SCOPE_COLORS[trigger.scope || 'user'] ?? SCOPE_COLORS['user'])}>
          {trigger.scope || 'user'}
        </span>
        <span className="flex-1 truncate font-medium">{trigger.name}</span>

        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {/* Test button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => { void handleTest(e); }}
                disabled={testing}
              >
                <FlaskConical className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Test trigger</TooltipContent>
          </Tooltip>

          {/* Log button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={(e) => { e.stopPropagation(); onOpenLog(); }}
              >
                <ScrollText className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>View trigger log</TooltipContent>
          </Tooltip>

          {/* Log mode select — hook triggers only */}
          {(trigger.trigger_type ?? 'hook') === 'hook' && (
            <select
              value={trigger.log_mode || 'activations'}
              onChange={(e) => { void handleLogModeChange(e); }}
              className="h-5 rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
              title="Log mode"
            >
              <option value="activations">Activations only</option>
              <option value="all">All calls</option>
            </select>
          )}
        </div>
      </div>

      {/* Hook events chips */}
      {(trigger.hook_events?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {trigger.hook_events!.map(ev => (
            <Badge key={ev} variant="outline" className="h-4 px-1 text-[9px]">{ev}</Badge>
          ))}
        </div>
      )}

      {/* Schedule metadata */}
      {trigger.trigger_type === 'schedule' && (
        <div className="flex flex-wrap items-center gap-1">
          {trigger.expr && (
            <span className="font-mono text-[10px] text-muted-foreground">{trigger.expr}</span>
          )}
          {trigger.next_run && (
            <span className="text-[10px] text-muted-foreground">
              → {new Date(trigger.next_run).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {trigger.enabled === false && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px]">paused</Badge>
          )}
        </div>
      )}
    </div>
  );
}
