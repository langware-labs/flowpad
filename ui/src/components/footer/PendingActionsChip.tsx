import { AgenticProcess, ClaudeSession, ExecutionMode, Project, Shell, supportedExecutionModes, TypeId, WorkerStatus } from '@sdk';
import { EntityTypeBar } from '@src/components/asset-manager/EntityTypeBar';
import { workerStatusConfig } from '@src/components/agentic-progress/shared/status-indicator';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useIsAdvanced } from '@src/contexts/view-mode-context';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { setPendingIntent } from '@src/tabs/pending-intent';
import {
  acknowledgePending,
  formatTimeAgo,
  useWorkerCountsByMode,
  useWorkerList,
} from '@src/store/pending-actions-store';
import { cn } from '@src/lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { executionModeLabel, iconForExecutionMode } from './execution-mode-icons';
import { useNotificationPulse } from './useNotificationPulse';
import { workerStatusLabel } from './worker-status-label';

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
/** The two related ids the name resolver reads off an AgenticProcess. */
type APWithIds = AgenticProcess & { session_id?: string | null; shell_id?: string | null };

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

  // A worker's meaningful name is the session title (the ai-title the history
  // and transcript views show), carried on its ClaudeSession (keyed by
  // session_id). When the session has no title yet, fall back to the linked
  // Shell's label ("Claude - <sid> (new)" / OSC title from the tab strip).
  // The lightweight status-op store carries none of these, so resolve from
  // the cache: AgenticProcess → session_id / shell_id → name.
  const apOf = (processId: string) =>
    AgenticProcess.getByIdFromCache<AgenticProcess>(processId) as APWithIds | null;
  const nameFromCache = (processId: string): string | null => {
    const ap = apOf(processId);
    const sessionId = ap?.session_id;
    const sessionName = sessionId
      ? ClaudeSession.getByIdFromCache<ClaudeSession>(sessionId)?.name
      : null;
    // ClaudeSession.name is `custom_title || slug || session_id`; only use it
    // when it's an actual title, not the raw id.
    if (sessionName && sessionName !== sessionId) return sessionName;
    const shellId = ap?.shell_id;
    return (shellId ? Shell.getByIdFromCache<Shell>(shellId)?.name : null) ?? null;
  };

  // A row's project label (shown on the meta subline, like the history modal).
  // Reads the warmed Project entity (see the lazy fetch below).
  const projectNameFromCache = (projectId: string): string | null => {
    const p = Project.getByIdFromCache<Project>(projectId);
    return p?.getDisplayName() ?? p?.name ?? null;
  };

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
      .filter((id) => !fetchedRef.current.has(id) && !nameFromCache(id));
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
    const resolveProcess = async (id: string): Promise<void> => {
      const ap = apOf(id) ?? ((await AgenticProcess.getById<AgenticProcess>(id)) as APWithIds | null);
      const sessionId = ap?.session_id;
      const shellId = ap?.shell_id;
      await Promise.allSettled(
        [
          sessionId && !ClaudeSession.getByIdFromCache<ClaudeSession>(sessionId)
            ? ClaudeSession.getById<ClaudeSession>(sessionId)
            : null,
          shellId && !Shell.getByIdFromCache<Shell>(shellId)
            ? Shell.getById<Shell>(shellId)
            : null,
        ].filter(Boolean) as Promise<unknown>[],
      );
    };
    void Promise.allSettled([
      ...missingProcesses.map(resolveProcess),
      ...missingProjects.map((id) => Project.getById<Project>(id)),
    ]).then(() => {
      if (!cancelled) setNameTick((t) => t + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [open, allRows]);

  const rows = useMemo(
    () =>
      filtered.map((e) => ({
        processId: e.processId,
        mode: e.mode,
        name: nameFromCache(e.processId) ?? e.processId.slice(0, 8),
        projectName: e.projectId ? projectNameFromCache(e.projectId) : null,
        statusLabel: workerStatusLabel(e.workerStatus, e.pending),
        statusIcon: workerStatusConfig[e.workerStatus as WorkerStatus],
        lastActive: formatTimeAgo(e.lastStatusChangedAt),
        pending: e.pending,
      })),
    // nameTick forces a re-read of the entity cache after the lazy fetch above
    // resolves (the fetched names aren't otherwise a render dependency).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, nameTick],
  );

  // Hide the chip only when there are no supported workers at all. When the user
  // has narrowed to an empty mode (e.g. External in v1) the chip stays visible
  // showing 0 so the popover remains reachable to reset the filter.
  if (allRows.length === 0) return null;

  const count = rows.length;
  const tooltipText = `${count} active agent${count === 1 ? '' : 's'}`;

  // Route per execution mode: an Interactive worker attaches its live terminal;
  // a Background (headless) or Error worker opens the read-only transcript lens
  // to *view* the run rather than forcing a PTY (which `openShellProcess` would
  // by flipping visible=true). External rows are never produced, so they never
  // reach here.
  const handlePick = async (processId: string, mode: ExecutionMode) => {
    setOpen(false);
    try {
      if (mode === ExecutionMode.Interactive) {
        // Pin the explicit intent BEFORE navigating: the agent may live in
        // another project, so the navigation triggers a strip rebuild. Without
        // this, the self-heal resolver would re-pick the new project's default
        // tab instead of the clicked agent (Bug 2). resolveActive case 2 honors
        // this intent, then consumes it once the agent lands in the strip.
        setPendingIntent(new TypeId(AgenticProcess.type, processId).toString());
        const opened = await navigation.openShellProcess(processId);
        if (!opened) {
          notify.error({
            title: 'Process unavailable',
            message: 'That agent is no longer in your workspace.',
          });
        }
        return;
      }
      // Background / Error → view the run's transcript (read-only).
      const ap = apOf(processId)
        ?? ((await AgenticProcess.getById<AgenticProcess>(processId)) as APWithIds | null);
      const sessionId = ap?.session_id;
      if (sessionId) {
        navigation.openLens('claude', 'transcript', sessionId);
      } else {
        notify.error({
          title: 'No transcript',
          message: 'This worker has no session to view yet.',
        });
      }
    } catch (err) {
      console.error('[PendingActionsChip] open failed', err);
      notify.error({
        title: 'Process unavailable',
        message: 'That agent is no longer in your workspace.',
      });
    } finally {
      // Ack either way — clears the row's glow if the process was in the
      // pending set. No-op if it was only burning (no readyAt to mark).
      acknowledgePending(processId);
    }
  };

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
              {rows.map((row) => {
                const rowClass = [
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted',
                  row.pending ? 'animate-pending-glow' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const StatusIcon = row.statusIcon?.icon;
                return (
                  <li key={row.processId}>
                    <button
                      type="button"
                      onClick={() => void handlePick(row.processId, row.mode)}
                      className={rowClass}
                      data-pending={row.pending ? 'true' : undefined}
                      data-mode={row.mode}
                    >
                      {StatusIcon && (
                        <StatusIcon
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            row.statusIcon?.color,
                            row.statusIcon?.animate && 'animate-spin',
                          )}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{row.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {executionModeLabel(row.mode)} · {row.statusLabel}
                          {row.projectName ? ` · ${row.projectName}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {row.lastActive}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
