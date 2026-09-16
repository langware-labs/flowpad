import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { CronForm } from '@src/components/cron-view/CronForm';
import { useProject } from '@src/hooks/useProject';
import { Agent, dataManager, QueryRequest, Trigger, TypeId, type ITrigger } from '@sdk';
import { ActionInfo } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Bot, History, Pencil, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { describeSchedule } from '@src/components/cron-view/describe-schedule';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { scopeColor } from './scope-colors';

/** The agent a trigger runs, when it is a scheduled agent run: its `run_agent`
 *  action's target, else the agent it lives inside. */
function runAgentTypeId(trigger: Trigger | null): string | null {
  const action = (trigger?.actions ?? []).find((a) => a.action_type === 'run_agent');
  if (!action) return null;
  const target = action.target_type_id || trigger?.parent_type_id || '';
  return target.startsWith('agent-') ? target : null;
}

/**
 * A scheduled agent run, read-only. Its source of truth is the trigger.json
 * under the agent's folder, which the agent's Schedule tab writes; a row PATCH
 * from here would be reverted on the next re-index, so editing goes there.
 */
function AgentScheduleDetail({ trigger, agentTypeId }: { trigger: Trigger; agentTypeId: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const agentId = agentTypeId.slice('agent-'.length);
  const request = useMemo(
    () => new QueryRequest({ type: Agent.type, scope: [], query: { id: agentId }, name: 'scheduleAgent' }),
    [agentId],
  );
  const { data: agents = [] } = useEntitiesQuery<Agent>(request);
  const agentName = agents[0]?.name ?? agentId.slice(0, 8);
  const prompt = (trigger.actions ?? []).find((a) => a.action_type === 'run_agent')?.prompt ?? '';
  const openAgent = () => navigation.openDock(DockPointer.forAssetEditorByTypeId('agent', new TypeId(agentTypeId)));

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-sm" data-testid="agent-schedule-detail">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          <Trans>Runs agent</Trans>
        </span>
        <button type="button" className="font-medium hover:underline" onClick={openAgent} data-testid="trigger-runs-agent">
          {agentName}
        </button>
      </div>
      <div>
        <div className="text-[11px] font-medium text-muted-foreground">
          <Trans>When</Trans>
        </div>
        <div data-testid="agent-schedule-detail-when">
          {describeSchedule(trigger.expr, trigger.sched_trigger_type, trigger.timezone)}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium text-muted-foreground">
          <Trans>Prompt</Trans>
        </div>
        <div className="whitespace-pre-wrap" data-testid="agent-schedule-detail-prompt">
          {prompt}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {trigger.enabled ? <Trans>Enabled</Trans> : <Trans>Disabled</Trans>}
        {' · '}
        {trigger.counter ? t`ran ${trigger.counter}×` : t`not run yet`}
        {trigger.last_run ? ` · ${t`last ${new Date(trigger.last_run).toLocaleString()}`}` : ''}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={openAgent} data-testid="trigger-edit-in-agent">
          <Pencil className="h-3 w-3" />
          <Trans>Edit in agent</Trans>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => navigation.openDock(DockPointer.forProcessRuns({ trigger_id: trigger.id }))}
          data-testid="trigger-runs"
        >
          <History className="h-3 w-3" />
          <Trans>Runs</Trans>
        </Button>
      </div>
    </div>
  );
}

interface Props {
  /** null = create mode */
  trigger: Trigger | null;
  onSaved: (trigger: ITrigger) => void;
  onCancel?: () => void;
}

export function ScheduleTriggerEditor({ trigger, onSaved, onCancel }: Props) {
  const { t } = useLingui();
  const { project } = useProject();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState(trigger?.instruction ?? '');
  const [workdir, setWorkdir] = useState(trigger?.workdir ?? project?.fs_storage_mount_path ?? '');
  const agentTypeId = runAgentTypeId(trigger);

  const handleSubmit = async (formData: {
    name?: string;
    description?: string;
    expr?: string;
    trigger_type?: string;
    enabled?: boolean;
  }) => {
    setSaving(true);
    setError(null);
    try {
      if (trigger?.id) {
        // Update existing
        const changed =
          trigger.name !== formData.name ||
          trigger.description !== formData.description ||
          trigger.expr !== formData.expr ||
          trigger.sched_trigger_type !== formData.trigger_type ||
          trigger.enabled !== (formData.enabled ?? true) ||
          (trigger.instruction ?? '') !== instruction ||
          (trigger.workdir ?? '') !== workdir;
        const action = new ActionInfo('update', 'trigger', trigger.id, 'PATCH');
        action.bodyParameters = {
          name: formData.name,
          description: formData.description,
          expr: formData.expr,
          sched_trigger_type: formData.trigger_type, // CronForm returns trigger_type as 'cron'|'interval'|'date'
          enabled: formData.enabled ?? true,
          instruction: instruction || null,
          workdir: workdir || null,
        };
        const updated = await dataManager.callAction<unknown, ITrigger>(action);
        if (changed) Trigger.markEditById(trigger.id);
        onSaved(updated as unknown as ITrigger);
      } else {
        // Create new
        const action = new ActionInfo('create', 'trigger', null, 'POST');
        action.bodyParameters = {
          name: formData.name,
          description: formData.description,
          trigger_type: 'schedule',
          expr: formData.expr,
          sched_trigger_type: formData.trigger_type, // cron|interval|date
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
      setError(e instanceof Error ? e.message : t`Save failed`);
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
      setError(e instanceof Error ? e.message : t`Run failed`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {trigger ? (
          <>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${scopeColor(trigger.scope)}`}>
              {trigger.scope || 'user'}
            </span>
            <span className="font-mono text-sm font-medium">{trigger.displayName}</span>
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              <Trans>schedule</Trans>
            </Badge>
            {/* A spent one-shot keeps its old next_run; only a future run is "next". */}
            {trigger.next_run && new Date(trigger.next_run).getTime() > Date.now() && (
              <span className="text-[10px] text-muted-foreground">
                <Trans>next: {new Date(trigger.next_run).toLocaleString()}</Trans>
              </span>
            )}
            <div className="ms-auto flex items-center gap-2">
              {error && <span className="text-[10px] text-destructive">{error}</span>}
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => {
                  void handleRunNow();
                }}
                disabled={running || saving || !trigger.id}
                title={t`Fire this trigger immediately`}
              >
                <Play className="h-3 w-3" />
                {running ? t`Running…` : t`Run now`}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-sm font-medium">
              <Trans>New Schedule Trigger</Trans>
            </span>
            {error && <span className="ms-auto text-[10px] text-destructive">{error}</span>}
          </>
        )}
      </div>

      {/* Body */}
      {trigger && agentTypeId ? (
        <div className="flex-1 overflow-auto">
          <AgentScheduleDetail trigger={trigger} agentTypeId={agentTypeId} />
        </div>
      ) : (
      <div className="flex-1 overflow-auto">
        {/* Instruction + workdir */}
        <div className="flex flex-col gap-2 border-b px-4 py-3">
          <label className="text-[11px] font-medium text-muted-foreground">
            <Trans>Instruction</Trans>
          </label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t`Prompt sent to the agentic process when this trigger fires…`}
            rows={4}
            className="w-full resize-y rounded border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <label className="text-[11px] font-medium text-muted-foreground">
            <Trans>Working directory</Trans>
          </label>
          <Input
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            placeholder={project?.fs_storage_mount_path ?? t`Optional — leave blank for home`}
            className="h-7 font-mono text-xs"
          />
        </div>

        {/* Cron schedule */}
        <CronForm
          initial={
            trigger
              ? {
                  name: trigger.name,
                  description: trigger.description,
                  expr: trigger.expr ?? '',
                  trigger_type: trigger.sched_trigger_type ?? 'cron',
                }
              : {}
          }
          defaultName={t`My Schedule`}
          onSubmit={handleSubmit}
          onCancel={onCancel ?? (() => {})}
          submitting={saving}
        />
      </div>
      )}
    </div>
  );
}
