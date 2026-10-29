import {
  Agent,
  Trigger,
  placeOf,
  type AutomationSummary,
  type TypeId,
} from '@sdk';
import type { AgentScheduleFields } from '@sdk/entities/agent';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { CalendarClock, ExternalLink, History, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';

import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { Textarea } from '@src/components/ui/textarea';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { CronForm, type ScheduleFormValue } from '@src/components/cron-view/CronForm';
import { describeSchedule, type ScheduleDescribeLabels } from '@src/components/cron-view/describe-schedule';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { useAutomations } from '@src/hooks/automations/useAutomations';
import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { useContext } from '@src/hooks/useContext';
import { PlaceBadge } from './PlaceBadge';
import { RunsOnPicker } from './RunsOnPicker';
import { isMove, type RunsOn } from './runs-on';
import { useAgentPlaces } from './use-agent-places';

interface AgentScheduleSectionProps {
  agent: Agent;
  /** The agent's live auto-launch prompt — the default for a new schedule. */
  autoLaunchPrompt?: string;
  /** The place (Deployment id) this list belongs to: shows its schedules and creates new ones there. */
  deploymentId: string;
  /** Whether that place is this computer — where legacy place-less schedules show. */
  isLocal: boolean;
  /** This list is Flowpad cloud's: the hub schedules that run the agent (`deploymentId` is then unused). */
  onHub?: boolean;
}

type ScheduleKind = NonNullable<AgentScheduleFields['every']>;

/** An overview schedule row's timing and prompt — what the list and the form show. */
export function scheduleOf(row: AutomationSummary) {
  const schedule = row.when.schedule;
  return {
    expr: schedule?.expr,
    sched_trigger_type: schedule?.sched_type ?? 'cron',
    timezone: schedule?.timezone ?? null,
    prompt: row.then.find((p) => p.kind === 'run_agent')?.prompt ?? '',
  };
}

/** The agent's own schedule is written through the agent's schedule verbs (the document is the source
 *  of truth); any other row through the Trigger SDK. */
function isOwnedBy(agent: Agent, row: AutomationSummary): boolean {
  return row.source !== 'hub' && row.parent_type_id === agent.typeId.toString();
}

/** The place a row is on, as the picker's choice. */
function runsOnOfRow(row: AutomationSummary): RunsOn {
  const place = placeOf(row);
  if (row.source === 'hub') return { kind: 'hub' };
  if (place.kind === 'cloud_machine' && place.deployment_id) return { kind: 'cloud_machine', deploymentId: place.deployment_id };
  return { kind: 'local', deploymentId: place.deployment_id ?? null };
}

/**
 * Scheduled runs of this agent.
 *
 * The list is the overview's schedule rows that run this agent, on this list's place. A schedule
 * made here is a CHILD TRIGGER ASSET under the agent's folder
 * (`agentic-assets/trigger/<slug>/trigger.json`), so it travels with the agent
 * wherever it is indexed; its writes go through the agent's schedule verbs, never
 * a trigger row PATCH: the document is the source of truth and a row edit would be
 * reverted on re-index. Every other row (a hub one among them) is written through
 * the Trigger SDK, which routes it by id.
 */
export function AgentScheduleSection({
  agent,
  autoLaunchPrompt = '',
  deploymentId,
  isLocal,
  onHub = false,
}: AgentScheduleSectionProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const cloudGate = useCloudLoginGate();
  const projectId = useContext().project?.id ?? null;
  const { places: loadedPlaces } = useAgentPlaces(agent);
  const places = useMemo(() => loadedPlaces ?? [], [loadedPlaces]);
  const [editing, setEditing] = useState<AutomationSummary | 'new' | null>(null);
  const [prompt, setPrompt] = useState('');
  // The list's own place: where a new schedule goes unless another is picked.
  const listPlace = useMemo<RunsOn>(
    () =>
      onHub
        ? { kind: 'hub' }
        : isLocal
          ? { kind: 'local', deploymentId }
          : { kind: 'cloud_machine', deploymentId },
    [onHub, isLocal, deploymentId],
  );
  const [runsOn, setRunsOn] = useState<RunsOn>(listPlace);
  const [busy, setBusy] = useState<string | null>(null);
  // The author's zone: "daily at 09:00" must mean their 09:00 on a sandbox too.
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const { schedules: allSchedules, refetch } = useAgentSchedules(agent.typeId);
  const schedules = useMemo(
    () =>
      allSchedules.filter((row) => {
        if (onHub) return row.source === 'hub';
        const runsOn = placeOf(row).deployment_id;
        return row.source !== 'hub' && (runsOn === deploymentId || (!runsOn && isLocal));
      }),
    [allSchedules, deploymentId, isLocal, onHub],
  );

  const labels = useScheduleLabels();

  const fail = useCallback(
    (title: string, e: unknown) => notify.error({ title, message: errorMessage(e, title), forceToast: true }),
    [],
  );

  const startNew = () => {
    setPrompt(autoLaunchPrompt);
    setRunsOn(listPlace);
    setEditing('new');
  };

  const startEdit = (row: AutomationSummary) => {
    setPrompt(scheduleOf(row).prompt);
    setRunsOn(runsOnOfRow(row));
    setEditing(row);
  };

  /** Remove a row from the store it lives in. */
  const removeRow = async (row: AutomationSummary) => {
    if (isOwnedBy(agent, row)) await agent.removeSchedule(row.id);
    else await Trigger.remove(row.id);
  };

  const submit = async (data: Partial<ScheduleFormValue>) => {
    const text = prompt.trim();
    if (!text) {
      notify.error({ title: t`A schedule needs a prompt`, message: t`Write what the agent should do when it runs.`, forceToast: true });
      return;
    }
    const every = (data.trigger_type as ScheduleKind | undefined) ?? 'cron';
    const row = editing === 'new' ? null : editing;
    const moving = !!row && isMove(runsOnOfRow(row), runsOn);
    if (runsOn.kind === 'hub') {
      const gate = await cloudGate();
      if (!gate.ok) {
        notify.error({ title: t`Sign in to Flowpad cloud`, message: gate.error, forceToast: true });
        return;
      }
    }
    const place = runsOn.kind === 'hub' ? undefined : (runsOn.deploymentId ?? undefined);
    const fields = {
      name: data.name ?? '',
      description: data.description ?? '',
      every,
      expr: data.expr ?? '',
      timezone,
      ...(place ? { runs_on: place } : {}),
      prompt: text,
      enabled: data.enabled ?? true,
    };
    setBusy('form');
    try {
      if (runsOn.kind === 'hub') {
        const cloud = {
          name: fields.name,
          description: fields.description,
          expr: fields.expr,
          sched_trigger_type: every,
          timezone,
          agent: agent.typeId.toString(),
          prompt: text,
          project_id: projectId,
          enabled: fields.enabled,
        };
        if (row && !moving) await Trigger.updateAutomation(row.id, Trigger.cloudScheduleFields(cloud));
        else await Trigger.createOnCloud(cloud);
      } else if (!row || moving) {
        await agent.addSchedule(fields);
      } else if (isOwnedBy(agent, row)) {
        await agent.updateSchedule(row.id, fields);
        Trigger.markEditById(row.id);
      } else {
        await Trigger.updateAutomation(row.id, {
          name: fields.name,
          description: fields.description,
          expr: fields.expr,
          sched_trigger_type: every,
          timezone,
          runs_on: place ?? null,
          enabled: fields.enabled,
        });
      }
      // A move across stores: created on the new place, then deleted where it was.
      if (row && moving) await removeRow(row);
      setEditing(null);
      await refetch();
    } catch (e) {
      fail(t`Could not save schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (row: AutomationSummary, enabled: boolean) => {
    setBusy(row.id);
    try {
      if (isOwnedBy(agent, row)) {
        await agent.updateSchedule(row.id, { enabled });
        Trigger.markEditById(row.id);
      } else {
        await Trigger.setEnabled(row.id, enabled);
      }
      await refetch();
    } catch (e) {
      fail(t`Could not update schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (row: AutomationSummary) => {
    setBusy(row.id);
    try {
      // A cloud machine's schedule runs on THAT machine, which only the hub can reach; any other row is the
      // overview's *Run now* (the hub's fire for a hub row).
      if (!onHub && !isLocal) await agent.placeAction(deploymentId, 'run_now', row.id);
      else await Trigger.runNow(row);
      notify.success({ title: t`Scheduled run started`, message: row.name });
      await refetch();
    } catch (e) {
      fail(t`Could not run schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const remove = (row: AutomationSummary) => {
    showDeleteAssetModal({
      name: row.name,
      description: t`This removes the schedule from the agent. Past runs stay in the run history.`,
      onConfirm: async () => {
        setBusy(row.id);
        try {
          await removeRow(row);
          await refetch();
        } finally {
          setBusy(null);
        }
      },
    });
  };

  // URL-first: a click only navigates — to the automation's own page.
  const openTrigger = (row: AutomationSummary) => navigation.openDock(DockPointer.forAutomations({ trigger: row.id }));

  const openRuns = (row: AutomationSummary) => navigation.openDock(DockPointer.forProcessRuns({ trigger_id: row.id }));

  if (editing) {
    const row = editing === 'new' ? null : editing;
    const saved = row ? scheduleOf(row) : null;
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
          <RunsOnPicker
            value={runsOn}
            onChange={setRunsOn}
            places={places}
            cloudAllowed={!!prompt.trim()}
            saved={row ? runsOnOfRow(row) : null}
          />
        </div>
        <CronForm
          initial={
            row && saved
              ? {
                  name: row.name,
                  description: row.description,
                  expr: saved.expr ?? '',
                  trigger_type: saved.sched_trigger_type,
                  timezone: saved.timezone ?? undefined,
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
            const when = scheduleOf(row);
            return (
              <div key={row.id} className="rounded-md border p-2 text-sm" data-testid={`agent-schedule-${index}`}>
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <PlaceBadge place={placeOf(row)} places={places} className="text-[10px]" testId={`agent-schedule-place-${index}`} />
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
                  {describeSchedule(when.expr, when.sched_trigger_type, when.timezone, labels)}
                </div>
                <div className="mt-0.5 truncate text-xs" title={when.prompt}>
                  {when.prompt}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground" data-testid={`agent-schedule-status-${index}`}>
                  {/* A spent one-shot keeps its old `next_run`; only a future run is "next". */}
                  {row.enabled && row.next_run && new Date(row.next_run).getTime() > Date.now() ? (
                    <span>{t`next ${new Date(row.next_run).toLocaleString()}`}</span>
                  ) : null}
                  {row.last_run?.ts ? <span>{t`last ${new Date(row.last_run.ts).toLocaleString()}`}</span> : null}
                  <span>{row.fires ? t`ran ${row.fires}×` : t`not run yet`}</span>
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

/** Every schedule that runs this agent, on any place — the overview's schedule rows whose `agent_type_id` is
 *  this agent (each carries its place and source; the hub's are among them). */
export function useAgentSchedules(agentTypeId: TypeId) {
  const { data: overview = [], isLoading } = useAutomations({ poll: false });
  const client = useQueryClient();
  const key = agentTypeId.toString();
  const schedules = useMemo(
    () => overview.filter((a) => a.kind === 'schedule' && a.agent_type_id === key),
    [overview, key],
  );
  const refetch = useCallback(
    () => client.invalidateQueries({ queryKey: ['automations', 'overview'] }),
    [client],
  );
  return { schedules, isLoading, refetch };
}

/** How a schedule's timing is said ("Daily at 09:00"). */
export function useScheduleLabels(): ScheduleDescribeLabels {
  const { t } = useLingui();
  return useMemo<ScheduleDescribeLabels>(
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
}

