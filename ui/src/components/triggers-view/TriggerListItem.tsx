import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';
import { ActionInfo, dataManager, Trigger as TriggerEntity, type ITrigger } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { scopeColor } from './scope-colors';

interface Props {
  trigger: TriggerEntity;
  isSelected: boolean;
  onSelect: () => void;
  onOpenLog: () => void;
}

export function TriggerListItem({ trigger, isSelected, onSelect, onOpenLog }: Props) {
  const [testing, setTesting] = useState(false);
  const { t } = useLingui();
  // `useEntitiesQuery` fires only on add/remove; per-entity field updates
  // (counter, last_triggered) need this single-entity subscription to re-render.
  const { data: live } = useEntity<TriggerEntity>(trigger.id ? trigger.typeId : null);
  const liveOrTrigger = live ?? trigger;

  /** Per-trigger-type label for the Test button tooltip. Each source has very
   * different "Test" semantics — schedule spawns an agentic process for real;
   * hook synthesizes a fake hook event; FSOp fires the callback with a
   * synthetic path. Same icon, different real-world effect — surface that. */
  const TEST_TOOLTIPS: Record<string, string> = {
    hook: t`Synthesize event`,
    schedule: t`Run now (spawns a process)`,
    fsop: t`Fire (synthetic test)`,
  };

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
        <span className={cn('rounded px-1 py-0.5 text-[10px] font-medium', scopeColor(trigger.scope))}>
          {trigger.scope || 'user'}
        </span>
        <span className="flex-1 truncate font-medium">{trigger.displayName}</span>

        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {/* Test button — tooltip is type-aware (schedule spawns a real
              process; hook synthesizes; fsop fires synthetically). The per-row
              Log icon is intentionally removed; TriggerInvocationsPanel in the
              right panel is the canonical surface for invocations. */}
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
            <TooltipContent>
              {TEST_TOOLTIPS[trigger.trigger_type ?? 'hook'] ?? t`Test trigger`}
            </TooltipContent>
          </Tooltip>

          {/* Log mode select — hook triggers only */}
          {(trigger.trigger_type ?? 'hook') === 'hook' && (
            <select
              value={trigger.log_mode || 'activations'}
              onChange={(e) => { void handleLogModeChange(e); }}
              className="h-5 rounded border border-input bg-background px-1 text-[10px] text-muted-foreground"
              title={t`Log mode`}
            >
              <option value="activations"><Trans>Activations only</Trans></option>
              <option value="all"><Trans>All calls</Trans></option>
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

      {/* Schedule metadata — cron expr + next run. The disabled/paused badge
          is rendered uniformly in the universal stats line below. */}
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
        </div>
      )}

      {/* FSOp-specific metadata: watched path. Type-specific because hook +
          schedule have their own per-type rows above; everyone shares the
          universal stats line below. */}
      {liveOrTrigger.trigger_type === 'fsop' && liveOrTrigger.watch_path && (
        <div className="flex items-center gap-1.5">
          <span
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={liveOrTrigger.watch_path}
          >
            {liveOrTrigger.watch_path}
          </span>
        </div>
      )}

      {/* Universal stats line — counter + last triggered + disabled state.
          Renders for every trigger type (live via useEntity); the prior
          FSOp-only `fires:` badge is folded in so hook/schedule rows also
          show their counter and last fire. */}
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono">
          <Trans>fires: {liveOrTrigger.counter ?? 0}</Trans>
        </Badge>
        {liveOrTrigger.last_triggered && (
          <span className="text-[10px] text-muted-foreground">
            <Trans>last {new Date(liveOrTrigger.last_triggered).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Trans>
          </span>
        )}
        {liveOrTrigger.enabled === false && (
          <Badge variant="secondary" className="h-4 px-1 text-[9px]"><Trans>disabled</Trans></Badge>
        )}
      </div>
    </div>
  );
}
