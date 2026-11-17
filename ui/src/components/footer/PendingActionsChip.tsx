import { Trans, useLingui } from '@lingui/react/macro';
import { AgenticProcess, Project, TypeId, WorkerStatus } from '@sdk';
import type { ActivityProgressSpec } from '@sdk/activity';
import { Pencil } from 'lucide-react';
import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { showWizard } from '@src/components/assets/editor/wizard/wizard-popup-store';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  agenticProcessName,
  openAgenticProcess,
  resolveAgenticProcessName,
} from '@src/navigation/agentic-process-open';
import {
  acknowledgePending,
  formatTimeAgo,
  useWorkerList,
  type WorkerListEntry,
} from '@src/store/pending-actions-store';
import { cn } from '@src/lib/utils';
import { useActivities } from '@src/store/activity-store';
import { ActivityRow } from './ActivityRow';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNotificationPulse } from './useNotificationPulse';
import { workerStatusLabel } from './worker-status-label';

/** A worker-list entry projected to the fields a row renders. Names are read
 *  from the (non-reactive) entity cache — a `nameTick` bump re-runs this. */
function projectNameFromCache(projectId: string): string | null {
  const p = Project.getByIdFromCache<Project>(projectId);
  return p?.getDisplayName() ?? p?.name ?? null;
}

function buildWorkerRow(e: WorkerListEntry) {
  return {
    processId: e.processId,
    category: e.category,
    state: e.state,
    errorDetail: e.errorDetail,
    interactive: e.visible,
    name: agenticProcessName(e.processId) ?? e.processId.slice(0, 8),
    projectName: e.projectId ? projectNameFromCache(e.projectId) : null,
    statusLabel: workerStatusLabel(e.workerStatus, e.pending),
    statusIcon: workerStatusConfig[e.workerStatus as WorkerStatus],
    lastActive: formatTimeAgo(e.lastStatusChangedAt),
    pending: e.pending,
  };
}

type WorkerRowData = ReturnType<typeof buildWorkerRow>;
type ActivityTab = 'overview' | 'processes' | 'errors';
type ProcessFilter = 'all' | 'chat' | 'background';

const ACTIVITY_TABS: readonly ActivityTab[] = ['overview', 'processes', 'errors'];
const PROCESS_FILTERS: readonly ProcessFilter[] = ['all', 'chat', 'background'];
const DISMISSED_COMPLETED_KEY = 'activity-panel-dismissed-completed';

function readDismissedCompleted(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_COMPLETED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-2" data-testid={`activity-count-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="px-2 py-3 text-center text-xs text-muted-foreground">{label}</div>;
}

/**
 * Footer chip — a compact activity panel for processes and generic work.
 *
 * The list shows EVERY live worker on the machine, classified into an
 * Process categories come from `process_type`: Chat is conversational work;
 * every other process type is Background. Terminal visibility remains only an
 * interaction choice when a row is opened.
 *
 * Pulse + glow are preserved verbatim: a one-shot 3 s chip pulse fires alongside
 * the notification sound when a new id enters pending, and per-row
 * ``animate-pending-glow`` marks rows in the pending-input window.
 *
 * Row name and project name come from ``*.getByIdFromCache(id)`` and are NOT
 * reactive; both the linked session/shell and the row's Project are lazily
 * fetched into the cache when the popover opens so the names resolve.
 *
 * It also lists ACTIVITIES — the generic progress mechanism every kind of long-running
 * work reports through (an index, a walk, a RAG pass, a QA cycle). One chip, one count:
 * "what is happening on this machine" is a single question and deserves a single answer.
 *
 * Process-scoped activities are filtered OUT of that list. A running process reports as an
 * activity on the backend (which is what makes `flow progress list` and every other
 * consumer see one model), but here it already has a worker row — and that row is the
 * richer one, carrying inline rename, execution-mode classification and the attach/lens
 * routing. Showing both would double-count the same work.
 */
export function PendingActionsChip() {
  const allRows = useWorkerList();
  // See the note above: a process's own activity is represented by its worker row.
  // Memoized on the snapshot identity — the store hands out a new array only when
  // something actually changed, and this list is a render dependency below.
  const allActivities = useActivities();
  const activities = useMemo(
    () => allActivities.filter((a) => !a.subject_entity?.startsWith(`${AgenticProcess.type}-`)),
    [allActivities],
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ActivityTab>('overview');
  const [processFilter, setProcessFilter] = useState<ProcessFilter>('all');
  const [dismissedCompleted, setDismissedCompleted] = useState<Record<string, number>>(readDismissedCompleted);
  const { navigation } = useDockNavigation();
  const pulsing = useNotificationPulse(3000);

  const visibleRows = useMemo(
    () => allRows.filter((entry) => dismissedCompleted[entry.processId] !== entry.lastStatusChangedAt),
    [allRows, dismissedCompleted],
  );
  const counts = useMemo(() => {
    const next = { running: 0, waiting: 0, completed: 0, error: 0 };
    for (const entry of visibleRows) next[entry.state]++;
    return next;
  }, [visibleRows]);
  const filtered = useMemo(
    () => visibleRows.filter((entry) => processFilter === 'all' || entry.category === processFilter),
    [visibleRows, processFilter],
  );
  const errors = useMemo(
    () => visibleRows.filter((entry) => entry.state === 'error'),
    [visibleRows],
  );
  const clearCompleted = useCallback(() => {
    const next = { ...dismissedCompleted };
    for (const entry of visibleRows) {
      if (entry.category === 'background' && entry.state === 'completed') next[entry.processId] = entry.lastStatusChangedAt;
    }
    localStorage.setItem(DISMISSED_COMPLETED_KEY, JSON.stringify(next));
    setDismissedCompleted(next);
  }, [dismissedCompleted, visibleRows]);

  // When the popover opens, lazily fetch each row's process (+ its ClaudeSession
  // / Shell) and its Project so the cached names replace the id fragments. Both
  // the row name and the project name come from `*.getByIdFromCache`, which is
  // almost never warm without this; a single `nameTick` bump re-reads the cache
  // once everything lands.
  const fetchedRef = useRef<Set<string>>(new Set());
  const fetchedProjectsRef = useRef<Set<string>>(new Set());
  const [nameTick, setNameTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const missingProcesses = allRows
      .map((e) => e.processId)
      .filter((id) => !fetchedRef.current.has(id) && !agenticProcessName(id));
    // Many rows can share one project, so dedup before fetching.
    const missingProjects = Array.from(
      new Set(
        allRows
          .map((e) => e.projectId)
          .filter((id): id is string => !!id)
          .filter((id) => !fetchedProjectsRef.current.has(id) && !Project.getByIdFromCache<Project>(id)),
      ),
    );
    if (missingProcesses.length === 0 && missingProjects.length === 0) return;
    missingProcesses.forEach((id) => fetchedRef.current.add(id));
    missingProjects.forEach((id) => fetchedProjectsRef.current.add(id));
    let cancelled = false;
    void Promise.allSettled([
      ...missingProcesses.map(resolveAgenticProcessName),
      ...missingProjects.map((id) => Project.getById<Project>(id)),
    ]).then(() => {
      if (!cancelled) setNameTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [open, allRows]);

  const rows = useMemo(
    () => filtered.map(buildWorkerRow),
    // nameTick forces a re-read of the entity cache after the lazy fetch above
    // resolves (the fetched names aren't otherwise a render dependency).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, nameTick],
  );
  // Stable so `memo(WorkerRow)` only re-renders rows whose data actually changed.
  const bumpNameTick = useCallback(() => setNameTick((t) => t + 1), []);

  // Route per execution mode (shared with the process line on notifications): an
  // Interactive worker attaches its live terminal; a Background / Error worker
  // opens the read-only transcript lens. External rows are never produced.
  // Declared BEFORE the early return below — a hook after a conditional return
  // makes the hook count jump when `allRows` goes 0 → non-zero, which throws
  // "Rendered more hooks than during the previous render".
  const handlePick = useCallback(
    async (processId: string, interactive: boolean) => {
      setOpen(false);
      try {
        await openAgenticProcess(processId, navigation, interactive);
      } finally {
        // Ack either way — clears the row's glow if the process was in the
        // pending set. No-op if it was only burning (no readyAt to mark).
        acknowledgePending(processId);
      }
    },
    [navigation],
  );

  // A wizard's own top-level activity is scoped to ITSELF when attended (see
  // `Wizard.run`: `subject_entity=None if unattended else str(self.typeid)`),
  // so its row can be picked straight back to the editor page it was
  // minimized from — no lookup needed, the address already IS the typeid.
  // Every other activity kind (an index walk, a RAG pass) has nowhere of its
  // own to reopen, so this is deliberately a no-op for them.
  const handlePickActivity = useCallback(
    (spec: ActivityProgressSpec) => {
      if (!spec.subject_entity?.startsWith('wizard-')) return;
      setOpen(false);
      void showWizard(navigation, new TypeId(spec.subject_entity));
    },
    [navigation],
  );

  // Hide the chip only when there is nothing happening at all.
  // MUST come after every hook above — see the handlePick note.
  if (visibleRows.length === 0 && activities.length === 0) return null;

  const count = counts.running + counts.waiting + counts.error + activities.length;
  const tooltipText =
    activities.length === 0
      ? `${count} active agent${count === 1 ? '' : 's'}`
      : `${count} thing${count === 1 ? '' : 's'} in progress`;

  const chipClass = [
    'flex h-5 min-w-5 items-center justify-center rounded-md bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-1 focus:ring-ring',
    pulsing ? 'animate-pending-glow-once' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <TooltipProvider delayDuration={400}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="pending-actions-chip"
                data-minimize-anchor="process-chip"
                aria-label={tooltipText}
                className={chipClass}
              >
                {count}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{tooltipText}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          className="w-80 p-1"
          data-testid="pending-actions-popover"
        >
          <div className="flex border-b px-1" role="tablist" aria-label="Activity panel views">
            {ACTIVITY_TABS.map((item) => (
              <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)} className={cn('px-2 py-1.5 text-xs font-medium capitalize', tab === item ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground')}>
                {item === 'errors' ? `Errors${counts.error ? ` (${counts.error})` : ''}` : item}
              </button>
            ))}
          </div>
          {/* Fixed-height scroll body: a constant height means the popover
              (which opens upward) never resizes when the filtered count
              changes, so the pinned filter bar above stays put. */}
          <div className="h-64 overflow-y-auto" data-testid="worker-list-body">
            {tab === 'overview' ? (
              <div className="p-3" data-testid="activity-overview">
                {counts.completed > 0 && <button type="button" onClick={clearCompleted} className="mb-2 text-xs text-muted-foreground hover:text-foreground">Clear completed</button>}
                <div className="grid grid-cols-2 gap-2">
                <Counter label="Running" value={counts.running + activities.length} />
                <Counter label="Waiting for you" value={counts.waiting} />
                <Counter label="Completed" value={counts.completed} />
                <Counter label="Errors" value={counts.error} />
                </div>
              </div>
            ) : tab === 'errors' ? (
              errors.length === 0 ? <Empty label="No errors" /> : <ul className="flex flex-col">{errors.map((row) => <WorkerRow key={row.processId} row={buildWorkerRow(row)} onPick={handlePick} onRenamed={bumpNameTick} />)}</ul>
            ) : (
              <>
                <div className="flex gap-1 border-b px-2 py-1.5" data-testid="process-filter">
                  {PROCESS_FILTERS.map((item) => <button key={item} type="button" onClick={() => setProcessFilter(item)} className={cn('rounded px-2 py-0.5 text-xs capitalize', processFilter === item ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground')}>{item}</button>)}
                </div>
                {rows.length === 0 && activities.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground" data-testid="worker-list-empty">
                No processes match this filter
              </div>
            ) : (
              <>
                {rows.length > 0 && (
                  <ul className="flex flex-col">
                    {rows.map((row) => (
                      <WorkerRow key={row.processId} row={row} onPick={handlePick} onRenamed={bumpNameTick} />
                    ))}
                  </ul>
                )}
                {activities.length > 0 && (
                  <>
                    {/* A heading only when both kinds are present — a lone section needs
                        no label to tell it apart from the other one. */}
                    {rows.length > 0 && (
                      <div
                        className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                        data-testid="activity-section-heading"
                      >
                        <Trans>Activity</Trans>
                      </div>
                    )}
                    <ul className="flex flex-col" data-testid="activity-list">
                      {/* Keyed by scope+path: an activity's address is its identity, and a
                          recycled address is a new activity rather than a moved row. */}
                      {activities.map((spec) => (
                        <ActivityRow
                          key={`${spec.subject_entity ?? ''}::${spec.path}`}
                          spec={spec}
                          onPick={handlePickActivity}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}</>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

/** One worker row (extracted so it can own a per-row `useInlineRename` — a hook
 *  can't run inside the list `.map` — and be `memo`ized). Primary click
 *  opens/attaches the worker; the hover pencil (or double-click on the name)
 *  enters an inline rename that calls `AgenticProcess.renameById` — the same
 *  bidirectional rename a tab does (pins `auto_rename`, mirrors onto any open tab
 *  chip). `onRenamed` re-reads the non-reactive name cache. */
const WorkerRow = memo(function WorkerRow({
  row,
  onPick,
  onRenamed,
}: {
  row: WorkerRowData;
  onPick: (processId: string, interactive: boolean) => void | Promise<void>;
  onRenamed: () => void;
}) {
  const { t } = useLingui();
  const rename = useInlineRename(row.name, async (next) => {
    await AgenticProcess.renameById(row.processId, next);
    AgenticProcess.markEditById(row.processId);
    onRenamed();
  });
  const StatusIcon = row.statusIcon?.icon;
  const statusIconEl = StatusIcon ? (
    <StatusIcon
      className={cn('h-3.5 w-3.5 shrink-0', row.statusIcon?.color, row.statusIcon?.animate && 'animate-spin')}
    />
  ) : null;

  if (rename.editing) {
    // No outer <button> while editing (input-in-button is invalid HTML) — a
    // plain row with the status icon + a full-width input.
    return (
      <li className="flex items-center gap-2 rounded px-2 py-1.5" data-category={row.category}>
        {statusIconEl}
        <InlineRenameInput
          rename={rename}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-sm font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          testId="worker-rename-input"
          ariaLabel={t`Rename worker`}
        />
      </li>
    );
  }

  const rowClass = [
    'flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start text-sm',
    row.pending ? 'animate-pending-glow' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className="group flex items-center rounded pe-1 hover:bg-muted" data-pending={row.pending ? 'true' : undefined}>
      <button
        type="button"
        onClick={() => void onPick(row.processId, row.interactive)}
        onDoubleClick={(e) => {
          e.preventDefault();
          rename.startEditing();
        }}
        className={rowClass}
        data-category={row.category}
      >
        {statusIconEl}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{row.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {row.category === 'chat' ? 'Chat' : 'Background'} · {row.statusLabel}
            {row.errorDetail ? ` · ${row.errorDetail}` : ''}
            {row.projectName ? ` · ${row.projectName}` : ''}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={() => rename.startEditing()}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
        aria-label={t`Rename`}
        title={t`Rename`}
        data-testid="worker-rename-button"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <span className="shrink-0 ps-1 text-xs tabular-nums text-muted-foreground">{row.lastActive}</span>
    </li>
  );
});
