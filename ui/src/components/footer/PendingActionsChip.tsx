import { AgenticProcess, ExecutionMode, Project, supportedExecutionModes, WorkerStatus } from '@sdk';
import { Pencil } from 'lucide-react';
import { EntityTypeBar } from '@src/components/asset-manager/EntityTypeBar';
import { InlineRenameInput } from '@src/components/browseable-tree/InlineRenameInput';
import { useInlineRename } from '@src/components/browseable-tree/use-inline-rename';
import { workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { agenticProcessName, openAgenticProcess, resolveAgenticProcessName } from '@src/navigation/agentic-process-open';
import {
  acknowledgePending,
  formatTimeAgo,
  useWorkerCountsByMode,
  useWorkerList,
  type WorkerListEntry,
} from '@src/store/pending-actions-store';
import { cn } from '@src/lib/utils';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { executionModeLabel, iconForExecutionMode } from './execution-mode-icons';
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
    mode: e.mode,
    name: agenticProcessName(e.processId) ?? e.processId.slice(0, 8),
    projectName: e.projectId ? projectNameFromCache(e.projectId) : null,
    statusLabel: workerStatusLabel(e.workerStatus, e.pending),
    statusIcon: workerStatusConfig[e.workerStatus as WorkerStatus],
    lastActive: formatTimeAgo(e.lastStatusChangedAt),
    pending: e.pending,
  };
}

type WorkerRowData = ReturnType<typeof buildWorkerRow>;

/**
 * Footer chip — generic "agents at work" list, grouped by execution mode and
 * gated by view mode.
 *
 * The list shows EVERY live worker on the machine, classified into an
 * ``ExecutionMode`` (interactive / background / error / external). The chip owns
 * the per-view-mode *supported* set via ``supportedExecutionModes`` — Standard
 * users only ever see interactive + background, so the error/external complexity
 * is hidden from them entirely. A filter-toggle bar (the same ``EntityTypeBar``
 * the asset picker uses) narrows the shown modes; the badge counter reflects the
 * current filter (supported ∩ selected).
 *
 * Pulse + glow are preserved verbatim: a one-shot 3 s chip pulse fires alongside
 * the notification sound when a new id enters pending, and per-row
 * ``animate-pending-glow`` marks rows in the pending-input window.
 *
 * Row name and project name come from ``*.getByIdFromCache(id)`` and are NOT
 * reactive; both the linked session/shell and the row's Project are lazily
 * fetched into the cache when the popover opens so the names resolve.
 */
export function PendingActionsChip() {
  const isAdvanced = useIsAdvanced();
  const supported = useMemo(() => supportedExecutionModes(isAdvanced), [isAdvanced]);

  const allRows = useWorkerList(supported);
  const counts = useWorkerCountsByMode(supported);
  const [open, setOpen] = useState(false);
  // Empty = all supported modes shown (mirrors AssetPickerPopover).
  const [selected, setSelected] = useState<string[]>([]);
  const { navigation } = useDockNavigation();
  const pulsing = useNotificationPulse(3000);

  // The shown set: the user's selection, or all supported modes when nothing
  // is narrowed. Memoized so the `filtered` memo below stays stable across
  // renders where neither input changed.
  const effective: readonly string[] = useMemo(
    () => (selected.length ? selected : supported),
    [selected, supported],
  );
  const filtered = useMemo(
    () => allRows.filter((e) => effective.includes(e.mode)),
    [allRows, effective],
  );

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

  // Hide the chip only when there are no supported workers at all. When the user
  // has narrowed to an empty mode (e.g. External in v1) the chip stays visible
  // showing 0 so the popover remains reachable to reset the filter.
  if (allRows.length === 0) return null;

  const count = rows.length;
  const tooltipText = `${count} active agent${count === 1 ? '' : 's'}`;

  // Route per execution mode (shared with the process line on notifications): an
  // Interactive worker attaches its live terminal; a Background / Error worker
  // opens the read-only transcript lens. External rows are never produced.
  const handlePick = useCallback(
    async (processId: string, mode: ExecutionMode) => {
      setOpen(false);
      try {
        await openAgenticProcess(processId, navigation, mode === ExecutionMode.Interactive);
      } finally {
        // Ack either way — clears the row's glow if the process was in the
        // pending set. No-op if it was only burning (no readyAt to mark).
        acknowledgePending(processId);
      }
    },
    [navigation],
  );

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
          {/* Execution-mode filter toggles — pinned at the top. ``shrink-0``
              keeps the bar in place; only the scrollable body below it changes
              when a filter is toggled, so the header never moves. */}
          {supported.length > 1 && (
            <div
              className="flex shrink-0 items-center border-b px-2 py-1.5"
              data-testid="worker-mode-bar"
            >
              <EntityTypeBar
                selected={selected}
                onChange={setSelected}
                counts={counts}
                allowed={supported}
                iconForType={iconForExecutionMode}
                labelForType={executionModeLabel}
                testIdPrefix="worker-mode"
              />
            </div>
          )}
          {/* Fixed-height scroll body: a constant height means the popover
              (which opens upward) never resizes when the filtered count
              changes, so the pinned filter bar above stays put. */}
          <div className="h-64 overflow-y-auto" data-testid="worker-list-body">
          {rows.length === 0 ? (
            <div
              className="px-2 py-3 text-center text-xs text-muted-foreground"
              data-testid="worker-list-empty"
            >
              {effective.length === 1 && effective[0] === ExecutionMode.External
                ? 'No external workers detected'
                : 'No agents match this filter'}
            </div>
          ) : (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <WorkerRow
                  key={row.processId}
                  row={row}
                  onPick={handlePick}
                  onRenamed={bumpNameTick}
                />
              ))}
            </ul>
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
  onPick: (processId: string, mode: ExecutionMode) => void | Promise<void>;
  onRenamed: () => void;
}) {
  const rename = useInlineRename(row.name, async (next) => {
    await AgenticProcess.renameById(row.processId, next);
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
      <li className="flex items-center gap-2 rounded px-2 py-1.5" data-mode={row.mode}>
        {statusIconEl}
        <InlineRenameInput
          rename={rename}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-sm font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          testId="worker-rename-input"
          ariaLabel="Rename worker"
        />
      </li>
    );
  }

  const rowClass = [
    'flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm',
    row.pending ? 'animate-pending-glow' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className="group flex items-center rounded pr-1 hover:bg-muted" data-pending={row.pending ? 'true' : undefined}>
      <button
        type="button"
        onClick={() => void onPick(row.processId, row.mode)}
        onDoubleClick={(e) => {
          e.preventDefault();
          rename.startEditing();
        }}
        className={rowClass}
        data-mode={row.mode}
      >
        {statusIconEl}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{row.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {executionModeLabel(row.mode)} · {row.statusLabel}
            {row.projectName ? ` · ${row.projectName}` : ''}
          </div>
        </div>
      </button>
      <button
        type="button"
        onClick={() => rename.startEditing()}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        aria-label="Rename"
        title="Rename"
        data-testid="worker-rename-button"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <span className="shrink-0 pl-1 text-xs tabular-nums text-muted-foreground">{row.lastActive}</span>
    </li>
  );
});
