import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { WorkerIcon, pickHistoryTitle, timeAgo } from '@src/components/entity-execution-panel/history-row';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Checkbox } from '@src/components/ui/checkbox';
import { ViewMode } from '@src/contexts/view-mode-context';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { ALL_SCOPE_FILTER, defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import {
  useRecentActivity,
  type RecentActivityItem,
} from './use-recent-activity';

interface VibeRecentSessionsProps {
  /** Optional caption in place of the default "Recent activity" title — the
   *  no-process workspace labels the list, because there it is the only content;
   *  the hero passes none (the composer above it is context enough). */
  heading?: ReactNode;
  /** Extra classes for the list container (e.g. a max-width on a narrow pane). */
  className?: string;
}

const RECENT_LIMIT = 5;
const COMPACT_FETCH_LIMIT = 10;
const FULL_PAGE_SIZE = 50;

function ActivityRows({
  items,
  openSession,
}: {
  items: readonly RecentActivityItem[];
  openSession: (entry: WorkerHistoryEntry) => void;
}) {
  const { navigation } = useDockNavigation();

  return (
    <div className="divide-y divide-border/60">
      {items.map((item) => {
        if (item.kind === 'session') {
          const proc = item.entry.agentic_process_id
            ? AgenticProcess.getByIdFromCache<AgenticProcess>(item.entry.agentic_process_id) ?? null
            : null;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => openSession(item.entry)}
              className="flex w-full items-center gap-2 px-3 py-2 text-start text-xs transition-colors hover:bg-accent"
              data-testid="vibe-recent-session"
            >
              <WorkerIcon workerType={item.entry.worker_type} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pickHistoryTitle(proc, item.entry)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {timeAgo(new Date(item.timestampMs).toISOString())}
              </span>
            </button>
          );
        }

        const Icon = iconForType(item.result.record_type);
        const title = item.result.name?.trim()
          || item.result.fts_title?.trim()
          || item.result.record_id;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => void navigateToResult(item.result, navigation)}
            className="flex w-full items-center gap-2 px-3 py-2 text-start text-xs transition-colors hover:bg-accent"
            data-testid="vibe-recent-entity"
          >
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {labelForType(item.result.record_type)} · {timeAgo(new Date(item.timestampMs).toISOString())}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RecentActivityDialog({
  scope,
  open,
  onOpenChange,
  openSession,
}: {
  scope: ScopeFilter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openSession: (entry: WorkerHistoryEntry) => void;
}) {
  const [fetchLimit, setFetchLimit] = useState(FULL_PAGE_SIZE);
  const [allProjects, setAllProjects] = useState(false);
  const activityScope = allProjects ? ALL_SCOPE_FILTER : scope;
  const { items, isLoading, error, hasMore } = useRecentActivity(activityScope, fetchLimit);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden p-0 sm:max-w-xl" data-testid="recent-activity-dialog">
        <DialogHeader className="px-4 pt-4">
          <div className="flex items-center gap-3 pr-7">
            <DialogTitle><Trans>Recent activity</Trans></DialogTitle>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                className="h-3.5 w-3.5"
                checked={allProjects}
                onCheckedChange={(checked) => setAllProjects(checked === true)}
                data-testid="recent-activity-all-projects"
              />
              <Trans>All projects</Trans>
            </label>
          </div>
          <DialogDescription className="sr-only">
            <Trans>Recently edited items and chat sessions</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto border-t border-border/60">
          {items.length > 0 ? (
            <>
              <ActivityRows items={items} openSession={openSession} />
              {error && (
                <p className="px-4 py-2 text-xs text-destructive">
                  <Trans>Edited items could not be loaded. Chat sessions are still shown.</Trans>
                </p>
              )}
              {hasMore && (
                <button
                  type="button"
                  className="w-full border-t border-border/60 px-4 py-3 text-center text-xs font-medium text-primary hover:bg-accent/50"
                  onClick={() => setFetchLimit((current) => current + FULL_PAGE_SIZE)}
                  disabled={isLoading}
                  data-testid="recent-activity-load-more"
                >
                  {isLoading ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
                </button>
              )}
            </>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {isLoading
                ? <Trans>Loading activity…</Trans>
                : error
                  ? <Trans>Recent activity could not be loaded</Trans>
                  : <Trans>No recent activity</Trans>}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRecentActivity({ projectId, heading, className }: { projectId: string } & VibeRecentSessionsProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [moreOpen, setMoreOpen] = useState(false);
  const busyRef = useRef(false);
  const scope = useMemo(() => defaultScopeFilter(projectId), [projectId]);
  const { items } = useRecentActivity(scope, COMPACT_FETCH_LIMIT);
  const recent = items.slice(0, RECENT_LIMIT);

  const openSession = useCallback(
    (entry: WorkerHistoryEntry) => {
      if (!entry.worker_id || busyRef.current) return;
      busyRef.current = true;
      void (async () => {
        try {
          const proc = await AgenticProcess.getByWorkerId(entry.worker_id, entry.worker_type);
          if (!proc) {
            notify.error({
              title: t`Session not found`,
              message: t`This chat has no resumable session.`,
              id: `session-not-found:${entry.worker_id}`,
            });
            return;
          }
          navigation.openDockPointer(proc.terminalDockPointer, { viewMode: ViewMode.Vibe });
        } catch (error) {
          console.error('[VibeRecentSessions] Failed to open session:', error);
        } finally {
          busyRef.current = false;
        }
      })();
    },
    [navigation, t],
  );

  if (recent.length === 0) return null;

  return (
    <>
      <section
        className={cn('w-full overflow-hidden rounded-lg border border-border/60 text-start', className)}
        data-testid="vibe-recent-sessions"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <h2 className="text-xs font-medium text-muted-foreground">{heading ?? <Trans>Recent activity</Trans>}</h2>
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="text-xs font-medium text-primary hover:underline"
            data-testid="vibe-recent-show-more"
          >
            <Trans>More</Trans>
          </button>
        </div>
        <ActivityRows items={recent} openSession={openSession} />
      </section>
      {moreOpen && (
        <RecentActivityDialog
          scope={scope}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          openSession={openSession}
        />
      )}
    </>
  );
}

/** Project-scoped mixed timeline for Vibe Home. Kept under its established
 * export name so callers do not need a parallel home-only activity surface. */
export function VibeRecentSessions({ heading, className }: VibeRecentSessionsProps = {}) {
  const { project } = useProject();
  return project?.id ? (
    <ProjectRecentActivity key={project.id} projectId={project.id} heading={heading} className={className} />
  ) : null;
}
