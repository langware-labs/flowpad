import { Agent, QueryRequest, Trigger, type ICronEvent } from '@sdk';
import type { AgentScheduleFields } from '@sdk/entities/agent';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { projectScope, userScope } from '@sdk/utils/scope-filter';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useMemo, useState } from 'react';
import { CalendarClock, ExternalLink, History, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { CronForm } from '@src/components/cron-view/CronForm';
import { describeSchedule, type ScheduleDescribeLabels } from '@src/components/cron-view/describe-schedule';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

interface AgentScheduleSectionProps {
  agent: Agent;
  /** The agent's live auto-launch prompt — the default for a new schedule. */
  autoLaunchPrompt?: string;
  /** The place (Deployment id) this list belongs to: shows its schedules and
   *  creates new ones there. Omitted = every schedule of the agent. */
  deploymentId?: string;
  /** Whether that place is this computer — where legacy place-less schedules show. */
  isLocal?: boolean;
}

type ScheduleKind = NonNullable<AgentScheduleFields['every']>;

/** The prompt a schedule runs with — on its `run_agent` action. Read off the
 *  plain row so it works on any shape the query hands back. */
function promptOf(row: Pick<Trigger, 'actions'>): string {
  return (row.actions ?? []).find((a) => a.action_type === 'run_agent')?.prompt ?? '';
}

/**
 * Scheduled runs of this agent.
 *
 * Each schedule is a CHILD TRIGGER ASSET under the agent's folder
 * (`agentic-assets/trigger/<slug>/trigger.json`), so the list is a query over
 * containment — the same `parent_type_id` the indexer stamps for a wizard's
 * triggers — and a schedule travels with the agent wherever it is indexed.
 * Writes go through the agent's schedule verbs, never a trigger row PATCH: the
 * document is the source of truth and a row edit would be reverted on re-index.
 */
export function AgentScheduleSection({ agent, autoLaunchPrompt = '', deploymentId, isLocal = false }: AgentScheduleSectionProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [editing, setEditing] = useState<Trigger | 'new' | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // The author's zone: "daily at 09:00" must mean their 09:00 on a sandbox too.
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const request = useMemo(
    () =>
      new QueryRequest({
        type: Trigger.type,
        scope: [],
        // `query`, not `match` — see AgentDeploymentsSection.
        query: { parent_type_id: agent.typeId.toString() },
        name: 'agentSchedules',
      }),
    [agent.typeId],
  );
  const { data: rows = [], refetch } = useEntitiesQuery<Trigger>(request);
  const schedules = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.trigger_type === 'schedule' &&
          (!deploymentId || row.runs_on === deploymentId || (!row.runs_on && isLocal)),
      ),
    [rows, deploymentId, isLocal],
  );

  const labels = useMemo<ScheduleDescribeLabels>(
    () => ({
      once: (when) => t`Once at ${when}`,
      daily: (time) => t`Daily at ${time}`,
      weekly: (day, time) => t`${day} at ${time}`,
      monthly: (day, time) => t`Day ${day} of each month at ${time}`,
      every: (interval) => t`Every ${interval}`,
      cron: (expr) => t`Cron ${expr}`,
    }),
    [t],
  );

  const fail = useCallback(
    (title: string, e: unknown) => notify.error({ title, message: errorMessage(e, title), forceToast: true }),
    [],
  );

  const startNew = () => {
    setPrompt(autoLaunchPrompt);
    setEditing('new');
  };

  const startEdit = (row: Trigger) => {
    setPrompt(promptOf(row));
    setEditing(row);
  };

  const submit = async (data: Partial<ICronEvent>) => {
    const text = prompt.trim();
    if (!text) {
      notify.error({ title: t`A schedule needs a prompt`, message: t`Write what the agent should do when it runs.`, forceToast: true });
      return;
    }
    const fields = {
      name: data.name ?? '',
      description: data.description ?? '',
      every: (data.trigger_type as ScheduleKind | undefined) ?? 'cron',
      expr: data.expr ?? '',
      timezone,
      ...(deploymentId ? { runs_on: deploymentId } : {}),
      prompt: text,
      enabled: data.enabled ?? true,
    };
    setBusy('form');
    try {
      if (editing === 'new') {
        await agent.addSchedule(fields);
      } else if (editing?.id) {
        await agent.updateSchedule(editing.id, fields);
        Trigger.markEditById(editing.id);
      }
      setEditing(null);
      await refetch();
    } catch (e) {
      fail(t`Could not save schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (row: Trigger, enabled: boolean) => {
    setBusy(row.id);
    try {
      await agent.updateSchedule(row.id, { enabled });
      Trigger.markEditById(row.id);
      await refetch();
    } catch (e) {
      fail(t`Could not update schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (row: Trigger) => {
    setBusy(row.id);
    try {
      // A cloud place's schedule fires on THAT machine, which only the hub can reach.
      if (deploymentId && !isLocal) await agent.placeAction(deploymentId, 'run_now', row.id);
      else await new Trigger(row).runNow();
      notify.success({ title: t`Scheduled run started`, message: row.name });
      await refetch();
    } catch (e) {
      fail(t`Could not run schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const remove = (row: Trigger) => {
    showDeleteAssetModal({
      name: row.name,
      description: t`This removes the schedule from the agent. Past runs stay in the run history.`,
      onConfirm: async () => {
        setBusy(row.id);
        try {
          await agent.removeSchedule(row.id);
          await refetch();
        } finally {
          setBusy(null);
        }
      },
    });
  };

  // URL-first: a click only navigates. The scope must match the rule's own, or
  // the events screen filters the rule out and the link lands on nothing.
  const openTrigger = (row: Trigger) =>
    navigation.openDock(
      DockPointer.forEvents(row.id, { system: row.scope === 'system' }).withScopeFilter(
        row.project_id ? projectScope(row.project_id) : userScope(),
      ),
    );

  const openRuns = (row: Trigger) => navigation.openDock(DockPointer.forProcessRuns({ trigger_id: row.id }));

  if (editing) {
    const row = editing === 'new' ? null : editing;
    return (
      <section data-testid="agent-schedule-form" className="rounded-md border">
        <div className="flex flex-col gap-1 px-4 pt-3">
          <label className="text-[11px] font-medium text-muted-foreground" htmlFor="agent-schedule-prompt">
            <Trans>Prompt</Trans>
          </label>
          <Textarea
            id="agent-schedule-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t`What should the agent do each time it runs?`}
            data-testid="agent-schedule-prompt"
            className="min-h-16 resize-none text-sm"
            rows={3}
          />
        </div>
        <CronForm
          initial={
            row
              ? {
                  name: row.name,
                  description: row.description,
                  expr: row.expr ?? '',
                  trigger_type: row.sched_trigger_type ?? 'cron',
                  enabled: row.enabled,
                }
              : {}
          }
          defaultName={t`Scheduled run`}
          onSubmit={submit}
          onCancel={() => setEditing(null)}
          submitting={busy === 'form'}
        />
      </section>
    );
  }

  return (
    <section data-testid="agent-schedules">
      <p className="mb-3 text-xs text-muted-foreground">
        <Trans>Run this agent on its own, at a time you pick. Runs are headless and show up in the run history.</Trans>
      </p>
      <div className="flex flex-col gap-2">
        {schedules.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="agent-no-schedules">
            <Trans>No schedules yet.</Trans>
          </p>
        ) : (
          schedules.map((row, index) => {
            const rowBusy = busy === row.id;
            return (
              <div key={row.id} className="rounded-md border p-2 text-sm" data-testid={`agent-schedule-${index}`}>
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {!row.runs_on && deploymentId ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground" data-testid={`agent-schedule-everywhere-${index}`}>
                      <Trans>every machine</Trans>
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-start font-medium hover:underline"
                    onClick={() => openTrigger(row)}
                    title={t`Open trigger`}
                    data-testid={`agent-schedule-open-${index}`}
                  >
                    {row.name}
                  </button>
                  <Switch
                    checked={row.enabled}
                    disabled={rowBusy}
                    onCheckedChange={(v) => void setEnabled(row, v)}
                    aria-label={t`Schedule enabled`}
                    data-testid={`agent-schedule-enabled-${index}`}
                  />
                </div>
                <div className="mt-1 text-xs text-muted-foreground" data-testid={`agent-schedule-when-${index}`}>
                  {describeSchedule(row.expr, row.sched_trigger_type, row.timezone, labels)}
                </div>
                <div className="mt-0.5 truncate text-xs" title={promptOf(row)}>
                  {promptOf(row)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground" data-testid={`agent-schedule-status-${index}`}>
                  {/* A spent one-shot keeps its old `next_run`; only a future run is "next". */}
                  {row.enabled && row.next_run && new Date(row.next_run).getTime() > Date.now() ? (
                    <span>{t`next ${new Date(row.next_run).toLocaleString()}`}</span>
                  ) : null}
                  {row.last_run ? <span>{t`last ${new Date(row.last_run).toLocaleString()}`}</span> : null}
                  <span>{row.counter ? t`ran ${row.counter}×` : t`not run yet`}</span>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  {/* A disabled trigger's fire is a no-op — offering Run now would toast a run that never starts. */}
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" disabled={rowBusy || !row.enabled}
                    title={row.enabled ? undefined : t`Enable the schedule to run it`}
                    onClick={() => void runNow(row)} data-testid={`agent-schedule-run-${index}`}>
                    {rowBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    <Trans>Run now</Trans>
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => openRuns(row)} data-testid={`agent-schedule-runs-${index}`}>
                    <History className="h-3 w-3" />
                    <Trans>Runs</Trans>
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => openTrigger(row)} data-testid={`agent-schedule-trigger-${index}`}>
                    <ExternalLink className="h-3 w-3" />
                    <Trans>Open trigger</Trans>
                  </Button>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={rowBusy}
                    onClick={() => startEdit(row)} title={t`Edit schedule`} data-testid={`agent-schedule-edit-${index}`}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-1.5" disabled={rowBusy}
                    onClick={() => remove(row)} title={t`Delete schedule`} data-testid={`agent-schedule-delete-${index}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
        <div>
          <Button size="sm" onClick={startNew} disabled={!agent.enabled} data-testid="agent-schedule-add">
            <Plus className="me-1.5 h-3.5 w-3.5" />
            <Trans>Add schedule</Trans>
          </Button>
        </div>
      </div>
    </section>
  );
}
