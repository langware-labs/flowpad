import {
  Agent,
  QueryRequest,
  Trigger,
  placeOf as placeOfSummary,
  type AgentPlace,
  type AutomationPlace,
  type AutomationSummary,
  type TypeId,
} from '@sdk';
import type { AgentScheduleFields } from '@sdk/entities/agent';
import { useEntitiesQuery } from '@sdk/react/hooks';
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

/**
 * One schedule that runs this agent, wherever it lives: a child trigger of the agent (`owned`, written through
 * the agent's schedule verbs), another of this machine's triggers that runs it, or a hub trigger (`source`
 * `hub`, acted on with `hubReflect`).
 */
export interface AgentScheduleRow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  expr?: string;
  sched_trigger_type?: string | null;
  timezone?: string | null;
  prompt: string;
  runs_on?: string | null;
  next_run?: string | Date | null;
  last_run?: string | Date | null;
  counter: number;
  place: AutomationPlace;
  source: 'local' | 'hub';
  owned: boolean;
}

type ScheduleKind = NonNullable<AgentScheduleFields['every']>;

/** The prompt a schedule runs with — on its `run_agent` action. Read off the
 *  plain row so it works on any shape the query hands back. */
function promptOf(row: Pick<Trigger, 'actions'>): string {
  return (row.actions ?? []).find((a) => a.action_type === 'run_agent')?.prompt ?? '';
}

/** Where a row of this machine's store runs, read against the agent's places when the overview has not said. */
function localPlace(runsOn: string | null | undefined, places: AgentPlace[]): AutomationPlace {
  if (!runsOn) return { kind: 'local', label: 'This computer', every_machine: true };
  const place = places.find((p) => p.deployment.id === runsOn);
  if (place && !place.is_local)
    return { kind: 'cloud_machine', label: `Cloud · ${place.deployment.name}`, deployment_id: runsOn };
  return { kind: 'local', label: 'This computer', deployment_id: runsOn };
}

function fromTrigger(row: Trigger, place: AutomationPlace): AgentScheduleRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    expr: row.expr,
    sched_trigger_type: row.sched_trigger_type,
    timezone: row.timezone,
    prompt: promptOf(row),
    runs_on: row.runs_on,
    next_run: row.next_run ?? null,
    last_run: row.last_run ?? null,
    counter: row.counter ?? 0,
    place,
    source: 'local',
    owned: true,
  };
}

function fromSummary(a: AutomationSummary): AgentScheduleRow {
  const schedule = a.when.schedule;
  const place = placeOfSummary(a);
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    expr: schedule?.expr,
    sched_trigger_type: schedule?.sched_type ?? 'cron',
    timezone: schedule?.timezone ?? null,
    prompt: a.then.find((p) => p.kind === 'run_agent')?.prompt ?? '',
    runs_on: place.deployment_id ?? null,
    next_run: a.next_run ?? null,
    last_run: a.last_run?.ts ?? null,
    counter: a.fires ?? 0,
    place,
    source: a.source === 'hub' ? 'hub' : 'local',
    owned: false,
  };
}

/** The place a row is on, as the picker's choice. */
function runsOnOfRow(row: AgentScheduleRow): RunsOn {
  if (row.source === 'hub') return { kind: 'hub' };
  if (row.place.kind === 'cloud_machine' && row.runs_on) return { kind: 'cloud_machine', deploymentId: row.runs_on };
  return { kind: 'local', deploymentId: row.runs_on ?? null };
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
  const [editing, setEditing] = useState<AgentScheduleRow | 'new' | null>(null);
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

  const { schedules: allSchedules, refetch } = useAgentSchedules(agent.typeId, places);
  const schedules = useMemo(
    () =>
      allSchedules.filter((row) =>
        onHub
          ? row.source === 'hub'
          : row.source === 'local' && (row.runs_on === deploymentId || (!row.runs_on && isLocal)),
      ),
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

  const startEdit = (row: AgentScheduleRow) => {
    setPrompt(row.prompt);
    setRunsOn(runsOnOfRow(row));
    setEditing(row);
  };

  /** Remove a row from the store it lives in. */
  const removeRow = async (row: AgentScheduleRow) => {
    if (row.owned) await agent.removeSchedule(row.id);
    else await Trigger.remove(row.id, { hubReflect: row.source === 'hub' });
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
        if (row && !moving) await Trigger.updateAutomation(row.id, Trigger.cloudScheduleFields(cloud), { hubReflect: true });
        else await Trigger.createOnCloud(cloud);
      } else if (!row || moving) {
        await agent.addSchedule(fields);
      } else if (row.owned) {
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

  const setEnabled = async (row: AgentScheduleRow, enabled: boolean) => {
    setBusy(row.id);
    try {
      if (row.owned) {
        await agent.updateSchedule(row.id, { enabled });
        Trigger.markEditById(row.id);
      } else {
        await Trigger.setEnabled(row.id, enabled, { hubReflect: row.source === 'hub' });
      }
      await refetch();
    } catch (e) {
      fail(t`Could not update schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (row: AgentScheduleRow) => {
    setBusy(row.id);
    try {
      // A hub schedule fires on the hub; a cloud place's fires on THAT machine, which only the hub can reach.
      if (row.source === 'hub') await Trigger.fire(row.id);
      else if (!isLocal) await agent.placeAction(deploymentId, 'run_now', row.id);
      else await Trigger.runOnce(row.id);
      notify.success({ title: t`Scheduled run started`, message: row.name });
      await refetch();
    } catch (e) {
      fail(t`Could not run schedule`, e);
    } finally {
      setBusy(null);
    }
  };

  const remove = (row: AgentScheduleRow) => {
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
  const openTrigger = (row: AgentScheduleRow) => navigation.openDock(DockPointer.forAutomations({ trigger: row.id }));

  const openRuns = (row: AgentScheduleRow) => navigation.openDock(DockPointer.forProcessRuns({ trigger_id: row.id }));

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
            row
              ? {
                  name: row.name,
                  description: row.description,
                  expr: row.expr ?? '',
                  trigger_type: row.sched_trigger_type ?? 'cron',
                  timezone: row.timezone ?? undefined,
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
                  <PlaceBadge place={row.place} className="text-[10px]" testId={`agent-schedule-place-${index}`} />
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
                <div className="mt-0.5 truncate text-xs" title={row.prompt}>
                  {row.prompt}
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

/**
 * Every schedule that runs this agent, on any place: its child triggers (one named query shared by its
 * readers) and every other overview row whose `agent_type_id` is this agent — the hub's among them.
 * `places` names the cloud machines of a child row the overview has not placed yet.
 */
export function useAgentSchedules(agentTypeId: TypeId, places: AgentPlace[] = []) {
  const request = useMemo(
    () =>
      new QueryRequest({
        type: Trigger.type,
        scope: [],
        // `query`, not `match` — see AgentDeploymentsSection.
        query: { parent_type_id: agentTypeId.toString() },
        name: 'agentSchedules',
      }),
    [agentTypeId],
  );
  const { data: rows = [], isLoading, refetch: refetchOwn } = useEntitiesQuery<Trigger>(request);
  const { data: overview = [] } = useAutomations({ poll: false });
  const client = useQueryClient();
  const key = agentTypeId.toString();
  const schedules = useMemo(() => {
    const running = overview.filter((a) => a.kind === 'schedule' && a.agent_type_id === key);
    const byId = new Map(running.map((a) => [a.id, a]));
    const own = rows
      .filter((row) => row.trigger_type === 'schedule')
      .map((row) => {
        const summary = byId.get(row.id);
        return fromTrigger(row, summary?.place ?? localPlace(row.runs_on, places));
      });
    const ownIds = new Set(own.map((row) => row.id));
    return [...own, ...running.filter((a) => !ownIds.has(a.id)).map(fromSummary)];
  }, [rows, overview, key, places]);
  const refetch = useCallback(async () => {
    await Promise.all([refetchOwn(), client.invalidateQueries({ queryKey: ['automations', 'overview'] })]);
  }, [refetchOwn, client]);
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

