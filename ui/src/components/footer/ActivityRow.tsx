/**
 * One activity in the footer chip's list.
 *
 * What it has to convey, in the order someone scans it: what the work is, how far along,
 * how long it has been going, and whether anything went wrong. Three rules are not
 * cosmetic:
 *
 * * An unknown total renders a COUNT, never a 0% bar. A scan discovers as it goes; a bar
 *   pinned at zero for ten minutes is a lie about a job that is working fine.
 * * `errors_count` is shown whenever it is non-zero. It crossed the wire on every tick of
 *   the old mechanism and was rendered nowhere, so a run with 300 errors looked clean.
 * * Elapsed comes from the hook's own clock, so it keeps moving when the activity does
 *   not — which is exactly when someone is watching.
 */

import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import type { ActivityProgressSpec } from '@sdk/activity';
import { fraction } from '@sdk/activity';
import { cn } from '@src/lib/utils';
import { humanizeSeconds } from '@src/utils/duration';
import { iconForActivity } from './activity-icon';
import { useElapsedMs } from '@src/hooks/useActivity';

/**
 * `1204/5000 (24%)`, or a bare `1,204` when the total is unknown.
 *
 * Takes the already-computed share rather than recomputing it — the caller needs it for
 * the bar anyway, and `fraction` walks the children.
 */
export function formatProgress(spec: ActivityProgressSpec, pct: number | null): string {
  const done = spec.done.toLocaleString();
  if (spec.total == null) return done;
  return `${done}/${spec.total.toLocaleString()}${pct === null ? '' : ` (${Math.round(pct * 100)}%)`}`;
}

const STATE_TONE: Record<string, string> = {
  blocked: 'text-amber-600 dark:text-amber-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-amber-600 dark:text-amber-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
};

export const ActivityRow = memo(function ActivityRow({
  spec,
  onPick,
  depth = 0,
}: {
  spec: ActivityProgressSpec;
  onPick?: (spec: ActivityProgressSpec) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // Each row reads the SHARED clock: a list renders in a `.map`, where the parent cannot
  // call a hook per row. Only the top level shows it — elapsed on every child is noise.
  const elapsedMs = useElapsedMs(depth === 0 ? spec : null);
  // Resolving a glyph walks the registry; without this it would re-run on every clock tick.
  const Icon = useMemo(() => iconForActivity(spec), [spec.icon, spec.scope]);
  const pct = fraction(spec);
  const hasChildren = spec.children.length > 0;

  return (
    <li data-testid="activity-row" data-path={spec.path} data-state={spec.state}>
      <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" style={{ paddingLeft: 8 + depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-muted-foreground"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            data-testid="activity-expand"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className={cn('h-3.5 w-3.5 shrink-0', STATE_TONE[spec.state] ?? 'text-muted-foreground')} />
        <button
          type="button"
          onClick={() => onPick?.(spec)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{spec.label || spec.name}</span>
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground" data-testid="activity-progress">
              {formatProgress(spec, pct)}
            </span>
            {elapsedMs > 0 && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground" data-testid="activity-elapsed">
                {humanizeSeconds(elapsedMs / 1000)}
              </span>
            )}
            {spec.errors_count > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10px] text-destructive"
                data-testid="activity-errors"
                title={spec.errors.map((e) => (e.ref ? `${e.ref}: ${e.message}` : e.message)).join('\n')}
              >
                <TriangleAlert className="h-3 w-3" />
                {spec.errors_count}
              </span>
            )}
          </span>
          {(spec.current || spec.message) && (
            <span className="w-full truncate text-[10px] text-muted-foreground" data-testid="activity-current">
              {spec.current || spec.message}
            </span>
          )}
        </button>
      </div>
      {/* A determinate bar only when there is something determinate to show. */}
      {pct !== null && (
        <div className="mx-2 mb-1 h-0.5 overflow-hidden rounded bg-muted" style={{ marginLeft: 8 + depth * 12 }}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
      {expanded && hasChildren && (
        <ul className="flex flex-col">
          {/* Keyed by PATH: an index key reshuffles rows the moment a child appears
              mid-run, which is exactly when someone is looking at the list. */}
          {spec.children.map((child) => (
            <ActivityRow key={child.path} spec={child} onPick={onPick} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
});
