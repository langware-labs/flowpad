import { Badge } from '@src/components/ui/badge';
import { CronForm } from '@src/components/cron-view/CronForm';
import { dataManager, type ITrigger } from '@sdk';
import { ActionInfo } from '@sdk';
import { useState } from 'react';

interface Props {
  /** null = create mode */
  trigger: ITrigger | null;
  onSaved: (trigger: ITrigger) => void;
  onCancel?: () => void;
}

export function ScheduleTriggerEditor({ trigger, onSaved, onCancel }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (formData: { name?: string; description?: string; expr?: string; trigger_type?: string; enabled?: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      if (trigger?.id) {
        // Update existing
        const action = new ActionInfo('update', 'trigger', trigger.id, 'PATCH');
        action.bodyParameters = {
          name: formData.name,
          description: formData.description,
          expr: formData.expr,
          sched_trigger_type: formData.trigger_type,  // CronForm returns trigger_type as 'cron'|'interval'|'date'
          enabled: formData.enabled ?? true,
        };
        const updated = await dataManager.callAction<unknown, ITrigger>(action);
        onSaved(updated as unknown as ITrigger);
      } else {
        // Create new
        const action = new ActionInfo('create', 'trigger', null, 'POST');
        action.bodyParameters = {
          name: formData.name,
          description: formData.description,
          trigger_type: 'schedule',
          expr: formData.expr,
          sched_trigger_type: formData.trigger_type,  // cron|interval|date
          scope: 'user',
          enabled: formData.enabled ?? true,
        };
        const created = await dataManager.callAction<unknown, ITrigger>(action);
        onSaved(created as unknown as ITrigger);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const SCOPE_COLORS: Record<string, string> = {
    system: 'bg-muted text-muted-foreground',
    user: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    project: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {trigger ? (
          <>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SCOPE_COLORS[trigger.scope || 'user'] ?? SCOPE_COLORS['user']}`}>
              {trigger.scope || 'user'}
            </span>
            <span className="font-mono text-sm font-medium">{trigger.name}</span>
            <Badge variant="outline" className="h-4 px-1 text-[9px]">schedule</Badge>
            {trigger.next_run && (
              <span className="text-[10px] text-muted-foreground ml-auto">
                next: {new Date(trigger.next_run).toLocaleString()}
              </span>
            )}
          </>
        ) : (
          <span className="text-sm font-medium">New Schedule Trigger</span>
        )}
        {error && <span className="ml-auto text-[10px] text-destructive">{error}</span>}
      </div>

      {/* Form */}
      <div className="flex-1 overflow-auto">
        <CronForm
          initial={trigger ? {
            name: trigger.name,
            description: trigger.description,
            expr: trigger.expr ?? '',
            trigger_type: trigger.sched_trigger_type ?? 'cron',
          } : {}}
          defaultName="My Schedule"
          onSubmit={handleSubmit}
          onCancel={onCancel ?? (() => {})}
          submitting={saving}
        />
      </div>
    </div>
  );
}
