import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import type { SystemActivity } from '@sdk';
import { activityFooterLabel } from './activity-labels';

/**
 * Footer pill. Always navigates to Records Scanner on click — the destination
 * page renders the live activity bar, so the user lands on a single screen
 * that surfaces both in-progress jobs and historical index status. Active:
 * spinner + progress label. Idle: refresh icon + "indexed Xm ago". Refetches
 * index-status on activity→idle so the label updates without a remount.
 */

function idleLabel(iso: string | null): string {
  const ago = formatTimeAgo(iso);
  return ago ? `indexed ${ago}` : 'never indexed';
}

function idleTooltip(iso: string | null): string {
  return iso
    ? `Last indexed: ${new Date(iso).toLocaleString()}`
    : 'Never indexed';
}

export function IndexerStatusPill() {
  const { currentActivity, progressTable } = useSystemTools();
  const { state: indexStatus, refresh } = useIndexStatus();
  const { navigation } = useDockNavigation();

  // Activity → idle transition: refetch last_indexed_at so the label updates
  // the moment a run completes. Without this, the pill stays stale until the
  // user navigates and remounts the hook.
  const prevActivity = useRef<SystemActivity | null>(currentActivity);
  useEffect(() => {
    if (prevActivity.current !== null && currentActivity === null) {
      refresh();
    }
    prevActivity.current = currentActivity;
  }, [currentActivity, refresh]);

  const openScanner = () => navigation.openDock(DockPointer.forFsRecordsScanner());

  if (currentActivity) {
    const label = activityFooterLabel(currentActivity, progressTable);
    return (
      <button
        type="button"
        onClick={openScanner}
        className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={`${label} — click to open Records Scanner`}
        aria-label={label}
        data-testid="footer-indexing-indicator"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="max-w-[320px] truncate tabular-nums">{label}</span>
      </button>
    );
  }

  if (indexStatus.phase === 'loading') return <Loader2 aria-label="Loading index status" className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if (indexStatus.phase === 'error') return <button type="button" onClick={refresh}
    className="px-1.5 text-[10px] text-muted-foreground" title={indexStatus.error.message}>
    Index status unavailable · Retry
  </button>;

  const iso = indexStatus.status.last_indexed_at;
  return (
    <button
      type="button"
      onClick={openScanner}
      className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`${idleTooltip(iso)} — click to open Records Scanner`}
      aria-label={`${idleLabel(iso)} — open Records Scanner`}
      data-testid="footer-indexing-indicator"
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" />
      <span>{idleLabel(iso)}</span>
    </button>
  );
}
