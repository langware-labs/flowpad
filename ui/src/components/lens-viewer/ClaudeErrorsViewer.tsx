import { Shell, timeAgo } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Switch } from '@src/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { toast } from '@src/hooks/use-toast';
import {
  ERROR_TIME_SPANS,
  ErrorCategory,
  ErrorStatus,
  useClaudeErrorRecords,
  type ClaudeErrorRecord,
  type ErrorOccurrence,
} from '@src/hooks/useClaudeErrorRecords';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@src/components/ui/alert-dialog';
import {
  AlarmClock,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  EyeOff,
  FileText,
  ListTodo,
  OctagonAlert,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  Webhook,
  Wrench,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import {
  STATUS_SLUG_MAP,
  UNKNOWN_TIMESTAMP,
  parseTranscriptPath,
  slugFromStatusFilter,
  statusFilterFromSlug,
} from './error-viewer-utils';

const SNOOZE_OPTIONS = [
  { label: '1 hour', ms: 3_600_000 },
  { label: '4 hours', ms: 14_400_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '1 week', ms: 604_800_000 },
] as const;

function statusBadge(status: ErrorStatus) {
  switch (status) {
    case ErrorStatus.OPEN:
      return null; // no badge for open
    case ErrorStatus.IGNORED:
      return (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <EyeOff className="mr-0.5 inline h-2.5 w-2.5" />
          Ignored
        </span>
      );
    case ErrorStatus.IGNORED_UNTIL:
      return (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
          <Clock className="mr-0.5 inline h-2.5 w-2.5" />
          Snoozed
        </span>
      );
    case ErrorStatus.TASK_CREATED:
      return (
        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600">
          <ListTodo className="mr-0.5 inline h-2.5 w-2.5" />
          Tasked
        </span>
      );
    default:
      return null;
  }
}

// ─── Session link button ────────────────────────────────────────────────────

function SessionLink({
  jsonlPath,
  timestamp,
  onOpenTranscript,
}: {
  jsonlPath: string;
  timestamp?: string;
  onOpenTranscript: (jsonlPath: string, timestamp?: string) => void;
}) {
  const hasTranscript = !!jsonlPath;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'rounded p-0.5 transition-colors',
            hasTranscript
              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
              : 'cursor-default text-muted-foreground/30',
          )}
          disabled={!hasTranscript}
          onClick={() => onOpenTranscript(jsonlPath, timestamp)}
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {hasTranscript ? 'View session transcript' : 'Transcript not found'}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Action buttons ──────────────────────────────────────────────────────────

const actionBtnClass = 'rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

function ErrorActions({
  error,
  onIgnore,
  onIgnoreTillNow,
  onSnooze,
  onReopen,
}: {
  error: ClaudeErrorRecord;
  onIgnore: (fp: string) => void;
  onIgnoreTillNow: (fp: string) => void;
  onSnooze: (fp: string, until: Date) => void;
  onReopen: (fp: string) => void;
}) {
  const fp = error.fingerprint;
  const isOpen = error.error_status === ErrorStatus.OPEN;

  return (
    <>
      {isOpen && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className={actionBtnClass} onClick={() => onIgnoreTillNow(fp)}>
                <Clock className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Ignore till now</TooltipContent>
          </Tooltip>
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button className={actionBtnClass}>
                    <AlarmClock className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Snooze</TooltipContent>
            </Tooltip>
            <PopoverContent side="bottom" align="end" className="w-28 p-1">
              {SNOOZE_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => onSnooze(fp, new Date(Date.now() + opt.ms))}
                >
                  {opt.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className={actionBtnClass} onClick={() => onIgnore(fp)}>
                <EyeOff className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Ignore permanently</TooltipContent>
          </Tooltip>
        </>
      )}
      {!isOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className={actionBtnClass} onClick={() => onReopen(fp)}>
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reopen</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

// ─── Error card (deduplicated view) ─────────────────────────────────────────

function ErrorCard({
  error,
  grouped,
  onOpenTranscript,
  onOpenHook,
  onIgnore,
  onIgnoreTillNow,
  onSnooze,
  onReopen,
  onCreateTask,
  onGoToSession,
}: {
  error: ClaudeErrorRecord;
  grouped?: boolean;
  onOpenTranscript: (jsonlPath: string, timestamp?: string) => void;
  onOpenHook: (hookName: string, eventType: string) => void;
  onIgnore: (fp: string) => void;
  onIgnoreTillNow: (fp: string) => void;
  onSnooze: (fp: string, until: Date) => void;
  onReopen: (fp: string) => void;
  onCreateTask: (error: ClaudeErrorRecord) => void;
  onGoToSession: (error: ClaudeErrorRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isHook = error.error_category === ErrorCategory.HOOK;
  const Icon = isHook ? AlertTriangle : OctagonAlert;
  const iconColor = isHook ? 'text-amber-400' : 'text-orange-400';

  return (
    <div className={cn(
      'rounded-md border border-border bg-card p-3',
      'border-l-2',
      isHook ? 'border-l-amber-500' : 'border-l-orange-500',
    )}>
      <div className="flex gap-2">
        <Icon className={cn('mt-1.5 h-4 w-4 shrink-0', iconColor)} />
        {/* Occurrence counter in grouped mode */}
        {grouped && error.occurrence_count > 1 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mt-1 flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-bold text-muted-foreground">
                {error.occurrence_count}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {error.occurrence_count} occurrences across {error.session_ids.length} session
              {error.session_ids.length !== 1 ? 's' : ''}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Left: text content */}
        <div className="min-w-0 flex-1">
          {/* Header: error message as title, status badge */}
          <div className="flex flex-wrap items-center gap-1">
            {isHook && <span className="text-xs font-medium">{error.hook}</span>}
            {isHook && error.event && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{error.event}</span>
            )}
            {statusBadge(error.error_status)}
          </div>

          {/* Error message (root cause) */}
          <p className={cn('mt-1 font-mono text-xs', isHook ? 'text-amber-400/90' : 'text-foreground/75')}>
            {error.error_msg}
          </p>

          {/* Hook events where this error occurs */}
          {isHook && (() => {
            // Use the record-level hooks list (accumulates all distinct hook names).
            // Fall back to the legacy single hook field for older records.
            const display: string[] =
              error.hooks?.length > 0
                ? error.hooks
                : error.hook
                  ? [error.hook]
                  : [];
            return display.length > 0 ? (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-muted-foreground">Hooks:</span>
                {display.map((h) => (
                  <span key={h} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {h}
                  </span>
                ))}
              </div>
            ) : null;
          })()}

          {/* Occurrence info */}
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Seen {error.occurrence_count} time{error.occurrence_count !== 1 ? 's' : ''} across{' '}
            {error.session_ids.length} session{error.session_ids.length !== 1 ? 's' : ''}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground/60">
            {error.first_seen && error.first_seen !== UNKNOWN_TIMESTAMP && (
              <span>
                First: {new Date(error.first_seen).toLocaleString()} ({timeAgo(new Date(error.first_seen))})
              </span>
            )}
            {error.first_seen &&
              error.first_seen !== UNKNOWN_TIMESTAMP &&
              error.last_seen &&
              error.last_seen !== UNKNOWN_TIMESTAMP && <span className="mx-1.5">·</span>}
            {error.last_seen && error.last_seen !== UNKNOWN_TIMESTAMP && (
              <span>
                Last: {new Date(error.last_seen).toLocaleString()} ({timeAgo(new Date(error.last_seen))})
              </span>
            )}
          </p>

          {/* Expandable traceback */}
          {error.traceback && error.traceback.length > 0 && (
            <button
              className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Traceback ({error.traceback.length} lines)
            </button>
          )}
          {expanded && error.traceback && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
              {error.traceback.join('\n')}
            </pre>
          )}
        </div>

        {/* Right: buttons */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <SessionLink
              jsonlPath={error.last_jsonl_path}
              timestamp={error.last_seen}
              onOpenTranscript={onOpenTranscript}
            />
            {isHook && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className={actionBtnClass} onClick={() => onOpenHook(error.hook, error.event)}>
                    <Webhook className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">View hook config</TooltipContent>
              </Tooltip>
            )}
            {error.error_status === ErrorStatus.TASK_CREATED && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className={actionBtnClass} onClick={() => onGoToSession(error)}>
                    <Terminal className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Go to session</TooltipContent>
              </Tooltip>
            )}
            <ErrorActions
              error={error}
              onIgnore={onIgnore}
              onIgnoreTillNow={onIgnoreTillNow}
              onSnooze={onSnooze}
              onReopen={onReopen}
            />
          </div>
          {error.error_status === ErrorStatus.OPEN && (
            <Button
              variant="default"
              size="sm"
              className="h-8 w-24 gap-1.5 border-0 bg-green-600 text-sm font-semibold text-white shadow-sm hover:bg-green-500 active:bg-green-700"
              onClick={() => onCreateTask(error)}
            >
              <Wrench className="h-3.5 w-3.5" />
              Fix It
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Occurrence card (expanded/individual view) ─────────────────────────────

function OccurrenceCard({
  occurrence,
  parentError,
  onOpenTranscript,
  onOpenHook,
  onIgnore,
  onIgnoreTillNow,
  onSnooze,
  onReopen,
  onCreateTask,
  onGoToSession,
}: {
  occurrence: ErrorOccurrence;
  parentError: ClaudeErrorRecord;
  onOpenTranscript: (jsonlPath: string, timestamp?: string) => void;
  onOpenHook: (hookName: string, eventType: string) => void;
  onIgnore: (fp: string) => void;
  onIgnoreTillNow: (fp: string) => void;
  onSnooze: (fp: string, until: Date) => void;
  onReopen: (fp: string) => void;
  onCreateTask: (error: ClaudeErrorRecord) => void;
  onGoToSession: (error: ClaudeErrorRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isHook = parentError.error_category === ErrorCategory.HOOK;
  const Icon = isHook ? AlertTriangle : OctagonAlert;
  const iconColor = isHook ? 'text-amber-400' : 'text-orange-400';

  return (
    <div className={cn(
      'rounded-md border border-border bg-card p-2.5',
      'border-l-2',
      isHook ? 'border-l-amber-500' : 'border-l-orange-500',
    )}>
      <div className="flex gap-2">
        <Icon className={cn('mt-1.5 h-3.5 w-3.5 shrink-0', iconColor)} />

        {/* Left: text content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            {statusBadge(parentError.error_status)}
            <span className="text-[10px] text-muted-foreground/60">{occurrence.session_id.slice(0, 12)}...</span>
          </div>

          {/* Error message (root cause) first */}
          <p className={cn('mt-1 font-mono text-xs', isHook ? 'text-amber-400/90' : 'text-foreground/75')}>
            {occurrence.error_msg}
          </p>

          {/* Hook where this occurrence happened */}
          {isHook && (occurrence.hook || parentError.hook) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {occurrence.hook || parentError.hook}
              </span>
            </div>
          )}
          {occurrence.timestamp && occurrence.timestamp !== UNKNOWN_TIMESTAMP && (
            <p className="mt-0.5 text-[10px] text-muted-foreground/60">
              {new Date(occurrence.timestamp).toLocaleString()} ({timeAgo(new Date(occurrence.timestamp))})
            </p>
          )}
          {occurrence.traceback && occurrence.traceback.length > 0 && (
            <button
              className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Traceback ({occurrence.traceback.length} lines)
            </button>
          )}
          {expanded && occurrence.traceback && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[10px] leading-relaxed text-muted-foreground">
              {occurrence.traceback.join('\n')}
            </pre>
          )}
        </div>

        {/* Right: buttons */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <SessionLink
              jsonlPath={occurrence.jsonl_path}
              timestamp={occurrence.timestamp}
              onOpenTranscript={onOpenTranscript}
            />
            {isHook && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className={actionBtnClass} onClick={() => onOpenHook(parentError.hook, parentError.event)}>
                    <Webhook className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">View hook config</TooltipContent>
              </Tooltip>
            )}
            {parentError.error_status === ErrorStatus.TASK_CREATED && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className={actionBtnClass} onClick={() => onGoToSession(parentError)}>
                    <Terminal className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Go to session</TooltipContent>
              </Tooltip>
            )}
            <ErrorActions
              error={parentError}
              onIgnore={onIgnore}
              onIgnoreTillNow={onIgnoreTillNow}
              onSnooze={onSnooze}
              onReopen={onReopen}
            />
          </div>
          {parentError.error_status === ErrorStatus.OPEN && (
            <Button
              variant="default"
              size="sm"
              className="h-8 w-24 gap-1.5 border-0 bg-green-600 text-sm font-semibold text-white shadow-sm hover:bg-green-500 active:bg-green-700"
              onClick={() => onCreateTask(parentError)}
            >
              <Wrench className="h-3.5 w-3.5" />
              Fix It
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main viewer ────────────────────────────────────────────────────────────

interface ClaudeErrorsViewerProps {
  initialStatusSlug?: string;
}

export function ClaudeErrorsViewer({ initialStatusSlug }: ClaudeErrorsViewerProps) {
  const {
    allErrors,
    filteredErrors,
    displayCount,
    openDisplayCount,
    statusCounts,
    timeSpan,
    setTimeSpan,
    statusFilter,
    setStatusFilter,
    deduplicate,
    setDeduplicate,
    spanMs,
    isLoading,
    refetch,
    ignoreAll,
    ignoreTillNow,
    ignoreUntil,
    reopenError,
    createTaskForError,
    clearAll,
  } = useClaudeErrorRecords();

  const { navigation } = useDockNavigation();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // Apply initial status slug from URL on mount
  useMemo(() => {
    if (initialStatusSlug) {
      const resolved = statusFilterFromSlug(initialStatusSlug);
      if (resolved !== statusFilter) setStatusFilter(resolved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStatusFilter = useCallback(
    (value: ErrorStatus | 'all') => {
      setStatusFilter(value);
      navigation.openLens('heartbeat', 'errors', slugFromStatusFilter(value));
    },
    [navigation, setStatusFilter],
  );

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void refetch().finally(() => setIsRefreshing(false));
  }, [refetch]);

  const handleClearAll = useCallback(async () => {
    setIsClearing(true);
    try {
      const result = await clearAll();
      if (!result) {
        toast({ title: 'Cleared' });
        return;
      }
      const parts: string[] = [];
      const totalDeleted = result.deleted_debug_logs + result.truncated_debug_logs;
      if (totalDeleted > 0) parts.push(`${totalDeleted} debug log${totalDeleted !== 1 ? 's' : ''}`);
      if (result.deleted_error_records > 0) parts.push(`${result.deleted_error_records} error record${result.deleted_error_records !== 1 ? 's' : ''}`);
      const msg = parts.length > 0 ? `Cleared ${parts.join(' and ')}` : 'Nothing to clear';
      const skipped = result.skipped_debug_logs.length;
      toast({
        title: msg,
        description: result.truncated_debug_logs > 0
          ? `${result.truncated_debug_logs} log${result.truncated_debug_logs !== 1 ? 's' : ''} from active sessions were emptied but not deleted. They will be removed after those sessions end.`
          : skipped > 0
            ? `${skipped} file${skipped !== 1 ? 's' : ''} could not be cleared. Retry after active sessions end.`
            : undefined,
      });
    } catch (e) {
      toast({ title: 'Failed to clear errors', description: String(e), variant: 'destructive' });
    } finally {
      setIsClearing(false);
    }
  }, [clearAll]);

  const handleOpenTranscript = useCallback(
    (jsonlPath: string, timestamp?: string) => {
      if (!jsonlPath) return;
      const parsed = parseTranscriptPath(jsonlPath);
      if (!parsed) return;
      const options: Record<string, string> = {};
      if (timestamp) options.ts = timestamp;
      navigation.openLens('claude', 'transcript', `${parsed.projectEncodedName}/${parsed.sessionId}`, options);
    },
    [navigation],
  );

  const handleOpenHook = useCallback(
    (hookName: string, eventType: string) => {
      navigation.openDock(
        new DockPointer(ViewType.HOOKS, undefined, {
          hookId: '',
          eventType: eventType || '',
        }),
      );
    },
    [navigation],
  );

  const handleCreateTask = useCallback(
    (error: ClaudeErrorRecord) => {
      void createTaskForError(error).then(({ taskId, shellId: shellId }) => {
        if (taskId && shellId) {
          toast({ title: 'Session started', description: 'Claude is investigating the error.' });
          void navigation.openSession(shellId, { skipPermissions: true });
        } else {
          toast({ title: 'Failed to start session', variant: 'destructive' });
        }
      });
    },
    [createTaskForError, navigation],
  );

  const handleGoToSession = useCallback(
    (error: ClaudeErrorRecord) => {
      if (!error.worker_session_id) return;
      void (async () => {
        let shell: Shell | null = null;
        try {
          shell = await Shell.getById<Shell>(error.worker_session_id);
        } catch {
          /* not found */
        }
        if (shell?.pty?.isLive) {
          void navigation.openSession(error.worker_session_id, { skipPermissions: true });
        } else if (error.claude_session_id) {
          void navigation.openShell(error.worker_session_id, {
            startCommand: `claude --resume ${error.claude_session_id} --dangerously-skip-permissions`,
            skipPermissions: true,
          });
        } else {
          void navigation.openSession(error.worker_session_id);
        }
      })();
    },
    [navigation],
  );

  // Wrap async triage actions as void callbacks for event handlers
  const handleIgnore = useCallback((fp: string) => void ignoreAll(fp), [ignoreAll]);
  const handleIgnoreTillNow = useCallback((fp: string) => void ignoreTillNow(fp), [ignoreTillNow]);
  const handleSnooze = useCallback((fp: string, until: Date) => void ignoreUntil(fp, until), [ignoreUntil]);
  const handleReopen = useCallback((fp: string) => void reopenError(fp), [reopenError]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <h2 className="text-sm font-medium">Session Errors</h2>
            {openDisplayCount > 0 && (
              <>
                <span className="rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold text-destructive-foreground">
                  {openDisplayCount}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {deduplicate ? 'grouped' : ''} open error{openDisplayCount !== 1 ? 's' : ''} in the last 24 hours
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Time span filter */}
            <div className="flex shrink-0 items-center rounded-md border bg-muted/50">
              {ERROR_TIME_SPANS.map((span, i) => (
                <Tooltip key={span.value}>
                  <TooltipTrigger asChild>
                    <button
                      className={cn(
                        'px-2 py-0.5 text-[10px] font-medium transition-colors',
                        timeSpan === span.value
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground',
                        i === 0 && 'rounded-l-[5px]',
                        i === ERROR_TIME_SPANS.length - 1 && 'rounded-r-[5px]',
                      )}
                      onClick={() => setTimeSpan(span.value)}
                    >
                      {span.label}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{span.tooltip}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
              Refresh
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1.5" disabled={isClearing}>
                  <Trash2 className={cn('h-3.5 w-3.5 -translate-y-px', isClearing && 'animate-pulse')} />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all debug data?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete all debug logs from <code className="rounded bg-muted px-1 text-xs">~/.claude/debug/</code> and
                    all parsed error records.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleClearAll}>Clear All</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Second row: status filter + deduplicate toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center rounded-md border bg-muted/50">
            {STATUS_SLUG_MAP.map((sf, i) => {
              const count = statusCounts[sf.value] ?? 0;
              return (
                <button
                  key={sf.value}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium transition-colors',
                    statusFilter === sf.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                    i === 0 && 'rounded-l-[5px]',
                    i === STATUS_SLUG_MAP.length - 1 && 'rounded-r-[5px]',
                  )}
                  onClick={() => handleStatusFilter(sf.value)}
                >
                  {sf.label}
                  {(sf.value === 'all' || count > 0) && (
                    <span
                      className={cn(
                        'inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-bold',
                        statusFilter === sf.value
                          ? 'bg-primary-foreground/20 text-primary-foreground'
                          : 'bg-muted-foreground/15 text-muted-foreground',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2">
            <Switch checked={deduplicate} onCheckedChange={setDeduplicate} />
            <span className="text-xs font-medium text-muted-foreground">Group Events</span>
          </label>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">Loading errors...</div>
        )}

        {!isLoading &&
          displayCount === 0 &&
          (() => {
            // Find the next wider time span that has errors matching the status filter
            const currentSpanIdx = ERROR_TIME_SPANS.findIndex((t) => t.value === timeSpan);
            let widerSpan: (typeof ERROR_TIME_SPANS)[number] | null = null;
            let widerCount = 0;
            for (let i = currentSpanIdx + 1; i < ERROR_TIME_SPANS.length; i++) {
              const span = ERROR_TIME_SPANS[i];
              const cutoff = Date.now() - span.ms;
              const count = allErrors.filter((e) => {
                const ts = e.last_seen ? new Date(e.last_seen).getTime() : 0;
                if (ts < cutoff) return false;
                if (statusFilter !== 'all' && e.error_status !== statusFilter) return false;
                return true;
              }).length;
              if (count > 0) {
                widerSpan = span;
                widerCount = count;
                break;
              }
            }
            return (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <CheckCircle2 className="mb-2 h-8 w-8 opacity-30" />
                <p className="text-sm font-medium">No errors found</p>
                <p className="mt-1 text-xs">
                  {statusFilter === ErrorStatus.OPEN && !widerSpan
                    ? 'All errors have been triaged.'
                    : 'No errors match the current filters.'}
                </p>
                {widerSpan && (
                  <button
                    className="mt-3 rounded bg-muted px-3 py-1 text-xs font-medium transition-colors hover:bg-muted/80"
                    onClick={() => setTimeSpan(widerSpan!.value)}
                  >
                    {widerCount} error{widerCount !== 1 ? 's' : ''} in the last {widerSpan.label} — switch
                  </button>
                )}
              </div>
            );
          })()}

        {!isLoading && displayCount > 0 && deduplicate && (
          <div className="space-y-2">
            {filteredErrors.map((error) => (
              <ErrorCard
                key={error.fingerprint}
                error={error}
                grouped
                onOpenTranscript={handleOpenTranscript}
                onOpenHook={handleOpenHook}
                onIgnore={handleIgnore}
                onIgnoreTillNow={handleIgnoreTillNow}
                onSnooze={handleSnooze}
                onReopen={handleReopen}
                onCreateTask={handleCreateTask}
                onGoToSession={handleGoToSession}
              />
            ))}
          </div>
        )}

        {!isLoading && displayCount > 0 && !deduplicate && (
          <div className="space-y-2">
            {filteredErrors
              .flatMap((error) =>
                error.occurrences
                  .filter((occ) => {
                    if (spanMs === Infinity) return true;
                    const cutoff = Date.now() - spanMs;
                    return !occ.timestamp || new Date(occ.timestamp).getTime() >= cutoff;
                  })
                  .map((occ, i) => ({ occ, error, key: `${error.fingerprint}-${occ.session_id}-${occ.timestamp}-${i}` })),
              )
              .sort((a, b) => b.occ.timestamp.localeCompare(a.occ.timestamp))
              .map(({ occ, error, key }) => (
                <OccurrenceCard
                  key={key}
                  occurrence={occ}
                  parentError={error}
                  onOpenTranscript={handleOpenTranscript}
                  onOpenHook={handleOpenHook}
                  onIgnore={handleIgnore}
                  onIgnoreTillNow={handleIgnoreTillNow}
                  onSnooze={handleSnooze}
                  onReopen={handleReopen}
                  onCreateTask={handleCreateTask}
                  onGoToSession={handleGoToSession}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
