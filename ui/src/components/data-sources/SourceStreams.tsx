/**
 * The per-stream breakdown of one source.
 *
 * Presentational: the rows arrive as a prop. `DataSourcesView` loads every
 * cursor in ONE query and groups them, rather than each card querying its own —
 * cursors are instance-global, so N cards asking separately is N queries for
 * data one query already has, and the count is wanted on collapsed cards too.
 */
import { Trans } from '@lingui/react/macro';
import { DataSourceCursor } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince } from '@src/utils/duration';
import { healthStyle } from './health-style';

export function SourceStreams({ cursors }: { cursors: readonly DataSourceCursor[] }) {
  const Icon = iconForType(DataSourceCursor.type);
  if (cursors.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        <Trans>No streams yet — this source has not polled.</Trans>
      </p>
    );
  }

  return (
    <ul className="space-y-1 pt-1">
      {cursors.map((cursor) => {
        const health = healthStyle(cursor.health);
        return (
          <li key={cursor.id} className="flex items-center gap-2 text-xs">
            <Icon className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={cursor.segment_key}>
              {cursor.segment_label || cursor.segment_key}
            </span>
            {/* A failing stream is the reason a healthy-looking source returns
                nothing, so the count is worth its own chip. */}
            {cursor.consecutive_failures > 0 && (
              <span className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                {cursor.consecutive_failures}×
              </span>
            )}
            <span className={`rounded px-1 py-0.5 text-[10px] ${health.chip}`}>{health.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {timeSince(cursor.last_synced_at)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
