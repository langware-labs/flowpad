import { RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import type { SystemActivity } from '@sdk';
import { ActivityIndicator } from './ActivityIndicator';

/**
 * Footer pill. Active: spinner + progress label, click opens the progress
 * modal. Idle: refresh icon + "indexed Xm ago", click opens Records Scanner.
 * Refetches index-status on activity→idle so the label updates without a
 * remount.
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
  const { currentActivity } = useSystemTools();
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

  // Active: defer to the shared indicator (opens the singleton modal on click).
  if (currentActivity) {
    return <ActivityIndicator variant="pill" />;
  }

  // Idle: never render during the initial fetch to avoid flicker.
  if (indexStatus.phase !== 'ready') return null;

  const iso = indexStatus.status.last_indexed_at;
  return (
    <button
      type="button"
      onClick={() => navigation.openDock(DockPointer.forFsRecordsScanner())}
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
