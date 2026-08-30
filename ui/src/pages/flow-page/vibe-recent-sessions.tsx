import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { useProject } from '@sdk/react/hooks';
import { Trans } from '@lingui/react/macro';
import { WorkerIcon, pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { formatTimeAgoShort } from '@src/utils/format-time-ago';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Checkbox } from '@src/components/ui/checkbox';
import { ViewMode } from '@src/contexts/view-mode-context';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { ALL_SCOPE_FILTER, defaultScopeFilter, type ScopeFilter } from '@src/lib/scope-filter';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useResumeInTerminal } from '@src/hooks/use-resume-in-terminal';
import { useRecentActivity, type RecentActivityItem } from './use-recent-activity';

interface VibeRecentSessionsProps {
  /** Optional caption in place of the default "Recent activity" title — the
   *  no-process workspace labels the list, because there it is the only content;
   *  the hero passes none (the composer above it is context enough). */
  heading?: ReactNode;
  /** Extra classes for the list container (e.g. a max-width on a narrow pane). */
  className?: string;
}

/** One row shape for both kinds — see {@link ActivityRows}. */
const ROW_CLASS = 'flex w-full items-center gap-2 px-3 py-2 text-start text-xs transition-colors hover:bg-accent';

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
        const EntityIcon = item.kind === 'session' ? null : iconForType(item.result.record_type);
        // A session row and an edited-entity row are the SAME row — icon,
        // truncated title, right-aligned muted meta — differing only in what
        // fills those three slots and where a click goes. Derived here rather
        // than written twice, so the shared shape cannot drift between them.
        const when = formatTimeAgoShort(new Date(item.timestampMs).toISOString());
        const row =
          item.kind === 'session'
            ? {
                testId: 'vibe-recent-session',
                icon: <WorkerIcon workerType={item.entry.worker_type} />,
                // Cached read only — never a fetch per row. The entity wins over
                // the history snapshot so a renamed session shows its new title.
                title: pickHistoryTitle(
                  item.entry.agentic_process_id
                    ? (AgenticProcess.getByIdFromCache<AgenticProcess>(item.entry.agentic_process_id) ?? null)
                    : null,
                  item.entry,
                ),
                meta: when,
                onClick: () => openSession(item.entry),
              }
            : {
                testId: 'vibe-recent-entity',
                icon: EntityIcon ? <EntityIcon className="h-3 w-3 shrink-0 text-muted-foreground" /> : null,
                title: item.result.name?.trim() || item.result.fts_title?.trim() || item.result.record_id,
                meta: `${labelForType(item.result.record_type)} · ${when}`,
                onClick: () => void navigateToResult(item.result, navigation),
              };

        return (
          <button key={item.key} type="button" onClick={row.onClick} className={ROW_CLASS} data-testid={row.testId}>
            {row.icon}
            <span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{row.meta}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Rendered ONLY while open (the caller mounts it behind `moreOpen`), which is
 *  what gives each open a fresh fetch limit and scope toggle. */
function RecentActivityDialog({
  scope,
  onOpenChange,
  openSession,
}: {
  scope: ScopeFilter;
  onOpenChange: (open: boolean) => void;
  openSession: (entry: WorkerHistoryEntry) => void;
}) {
  const [fetchLimit, setFetchLimit] = useState(FULL_PAGE_SIZE);
  const [allProjects, setAllProjects] = useState(false);
  const activityScope = allProjects ? ALL_SCOPE_FILTER : scope;
  const { items, isLoading, error, hasMore } = useRecentActivity(activityScope, fetchLimit);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-hidden p-0 sm:max-w-xl" data-testid="recent-activity-dialog">
        <DialogHeader className="px-4 pt-4">
          <div className="flex items-center gap-3 pr-7">
            <DialogTitle>
              <Trans>Recent activity</Trans>
            </DialogTitle>
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
              {isLoading ? (
                <Trans>Loading activity…</Trans>
              ) : error ? (
                <Trans>Recent activity could not be loaded</Trans>
              ) : (
                <Trans>No recent activity</Trans>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRecentActivity({ projectId, heading, className }: { projectId: string } & VibeRecentSessionsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const scope = useMemo(() => defaultScopeFilter(projectId), [projectId]);
  const { items } = useRecentActivity(scope, COMPACT_FETCH_LIMIT);
  const recent = items.slice(0, RECENT_LIMIT);

  // The shared resume path — same worker lookup, same re-entry latch, same
  // not-found notification. This file used to carry its own copy, which meant
  // two components emitting the same `session-not-found:<id>` toast id.
  const { resumeInTerminal } = useResumeInTerminal();
  const openSession = useCallback(
    (entry: WorkerHistoryEntry) => {
      resumeInTerminal(entry.worker_id, undefined, undefined, entry.worker_type, { viewMode: ViewMode.Vibe });
    },
    [resumeInTerminal],
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
      {moreOpen && <RecentActivityDialog scope={scope} onOpenChange={setMoreOpen} openSession={openSession} />}
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
