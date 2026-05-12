import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import type { IndexProgressTable, SystemActivity } from '@sdk';

/**
 * Single footer-pill replacement for the old StatusBar IndexingIndicator
 * (active-only, opens modal) AND the standalone "last indexed" pill
 * (idle-only, opens scanner page). One surface, one click target.
 *
 * Active state: spinner + `Scanning N · type` / `Indexing N/M (P%) · type`.
 * Idle state:   refresh icon + `indexed Xm ago` / `never indexed`.
 *
 * Refetches index-status whenever activity transitions to idle so the
 * label catches up without a page navigation.
 */

function phaseLabel(activity: SystemActivity): string {
  switch (activity) {
    case 'archive': return 'Archiving';
    case 'clear': return 'Clearing index';
    case 'load_from_archive': return 'Restoring';
    case 'scan': return 'Scanning';
    case 'index': return 'Indexing';
  }
}

function activeLabel(activity: SystemActivity, table: IndexProgressTable | null): string {
  const phase = phaseLabel(activity);
  if (!table) return phase;
  const current = table.current ?? '…';
  if (table.total > 0) {
    const pct = Math.round((table.done / table.total) * 100);
    return `${phase} ${table.done}/${table.total} (${pct}%) · ${current}`;
  }
  return `${phase} ${table.done} · ${current}`;
}

function idleLabel(iso: string | null): string {
  const ago = formatTimeAgo(iso);
  return ago ? `indexed ${ago}` : 'never indexed';
}

function idleTooltip(iso: string | null): string {
  return iso
    ? `Last indexed: ${new Date(iso).toLocaleString()} — click to open Indexing info`
    : 'Never indexed — click to open Indexing info';
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

  const onClick = () => navigation.openDock(DockPointer.forFsRecordsScanner());

  // Active: spinner + live progress label.
  if (currentActivity) {
    const label = activeLabel(currentActivity, progressTable);
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={`${label} — click to open Indexing info`}
        aria-label={label}
        data-testid="footer-indexer-status"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="max-w-[320px] truncate tabular-nums">{label}</span>
      </button>
    );
  }

  // Idle: never render during the initial fetch to avoid flicker.
  if (indexStatus.phase !== 'ready') return null;

  const iso = indexStatus.status.last_indexed_at;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-sm px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={idleTooltip(iso)}
      aria-label={idleTooltip(iso)}
      data-testid="footer-indexer-status"
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" />
      <span>{idleLabel(iso)}</span>
    </button>
  );
}
