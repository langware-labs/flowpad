import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgenticProcess } from '@sdk';
import { cn } from '@src/lib/utils';
import { useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { HistoryModal } from '@src/components/terminal/HistoryModal';
import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';
import {
  WorkerIcon,
  pickHistoryTitle,
  timeAgo,
} from '@src/components/entity-execution-panel/history-row';
import { ViewMode } from '@src/contexts/view-mode-context';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { defaultScopeFilter } from '@src/lib/scope-filter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';

/** Rows shown inline on the hero; the rest live behind "Show more". */
const RECENT_LIMIT = 5;

/**
 * Fetch deeper than we render: the backend applies its cap by TRANSCRIPT
 * recency, while `useChatHistory` re-sorts by open-recency ("last active OR
 * last opened"). Fetching exactly RECENT_LIMIT would let a session that ranks
 * low by transcript time but was just opened get dropped before the re-sort
 * could promote it to row 1.
 */
const FETCH_LIMIT = 10;

/**
 * The last few sessions in the CURRENT PROJECT, listed under the vibe-home
 * composer — a one-click resume for "the thing I was just doing", which vibe
 * home otherwise has no affordance for at all. Scoped to the same project the
 * composer would start a new session in, so the list matches where `New` goes.
 * Anything older or in another project is one "Show more" away in the terminal's
 * HistoryModal (mounted here as a second, independent instance, and carrying its
 * own "All projects" toggle).
 *
 * Not vibe-only: a vibe process is indistinguishable from any other headless
 * chat at the data layer (no vibe flag is persisted, and a WorkerHistoryEntry
 * carries no vibe provenance), so this lists the project's recent sessions
 * whatever their origin, and opens each one INTO the vibe skin.
 *
 * Renders nothing when the project has no sessions — a fresh project keeps the
 * clean hero.
 */
interface VibeRecentSessionsProps {
  /** Optional caption above the rows. Rendered INSIDE the non-empty branch, so a
   *  project with no sessions shows neither the label nor an empty container.
   *  The hero passes none (the composer above it is context enough); the
   *  no-process workspace labels it, because there the list is the only content. */
  heading?: ReactNode;
  /** Extra classes for the list container (e.g. a max-width on a narrow pane). */
  className?: string;
}

export function VibeRecentSessions({ heading, className }: VibeRecentSessionsProps = {}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const [historyOpen, setHistoryOpen] = useState(false);
  // The resolve below is async; without this a double-click fires two
  // getByWorkerId + two navigations (same guard as useResumeInTerminal).
  const busyRef = useRef(false);

  const projectId = project?.id ?? null;
  // Project scope pushes the id to the backend so the per-project cap is computed
  // there — an under-active project's sessions would otherwise never make it into
  // the response to be filtered client-side.
  const filters = useMemo(
    () => ({ scope: defaultScopeFilter(projectId), search: '' }),
    [projectId],
  );
  const { buckets } = useChatHistory(filters, FETCH_LIMIT);
  // The hook groups into time buckets for the Chats side-menu; the hero wants a
  // flat top-N, already recency-sorted across buckets.
  const recent = useMemo(
    () => buckets.flatMap((b) => b.entries).slice(0, RECENT_LIMIT),
    [buckets],
  );

  const openRecent = useCallback(
    (entry: WorkerHistoryEntry) => {
      if (!entry.worker_id || busyRef.current) return;
      busyRef.current = true;
      void (async () => {
        try {
          // Resolve by the durable worker_id, NOT agentic_process_id: sessions
          // resumable from disk but never opened through this instance have no
          // process id yet, and getByWorkerId is what materializes one.
          const proc = await AgenticProcess.getByWorkerId(entry.worker_id, entry.worker_type);
          if (!proc) {
            notify.error({
              title: t`Session not found`,
              message: t`This chat has no resumable session.`,
              id: `session-not-found:${entry.worker_id}`,
            });
            return;
          }
          // Pin the skin: "Show more" can reach another project, and loading one
          // whose last_mode is Standard would otherwise drop the user out of vibe.
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

  // No project → nothing to scope to. Also covers "still loading" and "this
  // project has no sessions" — no skeleton, no wrapper.
  if (!projectId || recent.length === 0) return null;

  return (
    <>
      <div
        className={cn('w-full overflow-hidden rounded-lg border border-border/60 text-left', className)}
        data-testid="vibe-recent-sessions"
      >
        {heading ? (
          <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {heading}
          </div>
        ) : null}
        <div className="divide-y divide-border/60">
          {recent.map((entry) => {
            // Cached read only — never a fetch per row. The entity wins over the
            // history snapshot so a renamed session doesn't show a stale title.
            const proc = entry.agentic_process_id
              ? AgenticProcess.getByIdFromCache<AgenticProcess>(entry.agentic_process_id) ?? null
              : null;
            // `text-left` on the rows/footer is load-bearing: a button's UA
            // text-align is center, so it ignores the wrapper's alignment.
            return (
              <button
                key={entry.worker_id}
                type="button"
                onClick={() => openRecent(entry)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                data-testid="vibe-recent-session"
              >
                <WorkerIcon workerType={entry.worker_type} />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {pickHistoryTitle(proc, entry)}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {timeAgo(entry.last_active_time)}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-medium text-primary transition-colors hover:bg-accent/50"
            data-testid="vibe-recent-show-more"
          >
            <Trans>Show more</Trans>
          </button>
        </div>
      </div>
      <HistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onSelect={(entry) => {
          setHistoryOpen(false);
          openRecent(entry);
        }}
      />
    </>
  );
}
