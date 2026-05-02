import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { CronForm } from '@src/components/cron-view/CronForm';
import { useProject } from '@src/hooks/useProject';
import { dataManager, Trigger, type ITrigger } from '@sdk';
import { ActionInfo } from '@sdk';
import { Play } from 'lucide-react';
import { useState } from 'react';

interface Props {
  /** null = create mode */
  trigger: ITrigger | null;
  onSaved: (trigger: ITrigger) => void;
  onCancel?: () => void;
}

export function ScheduleTriggerEditor({ trigger, onSaved, onCancel }: Props) {
  const { project } = useProject();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(trigger?.instruction ?? '');
  const [workdir, setWorkdir] = useState(trigger?.workdir ?? project?.fs_storage_mount_path ?? '');

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
          instruction: instruction || null,
          workdir: workdir || null,
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
          scope: project?.id ? 'project' : 'user',
          project_id: project?.id ?? null,
          enabled: formData.enabled ?? true,
          instruction: instruction || null,
          workdir: workdir || null,
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

  const handleRunNow = async () => {
    if (!trigger?.id) return;
    setRunning(true);
    setError(null);
    try {
      await new Trigger(trigger).runNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(false);
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
            <span className="font-mono text-sm font-medium">{trigger.displayName}</span>
            <Badge variant="outline" className="h-4 px-1 text-[9px]">schedule</Badge>
            {trigger.next_run && (
              <span className="text-[10px] text-muted-foreground">
                next: {new Date(trigger.next_run).toLocaleString()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {error && <span className="text-[10px] text-destructive">{error}</span>}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => { void handleRunNow(); }}
                disabled={running || saving || !trigger.id}
                title="Fire this trigger immediately"
              >
                <Play className="h-3 w-3" />
                {running ? 'Running…' : 'Run now'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">New Schedule Trigger</span>
            {error && <span className="ml-auto text-[10px] text-destructive">{error}</span>}
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {/* Instruction + workdir */}
        <div className="flex flex-col gap-2 border-b px-4 py-3">
          <label className="text-[11px] font-medium text-muted-foreground">Instruction</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Prompt sent to the agentic process when this trigger fires…"
            rows={4}
            className="w-full resize-y rounded border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <label className="text-[11px] font-medium text-muted-foreground">Working directory</label>
          <Input
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder={project?.fs_storage_mount_path ?? 'Optional — leave blank for home'}
            className="h-7 font-mono text-xs"
          />
        </div>

        {/* Cron schedule */}
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
