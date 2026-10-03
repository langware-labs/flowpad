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
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, PauseCircle, TriangleAlert, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
  let { done, total } = spec;
  // A parent that only orchestrates reads its children's rolled-up count, the same
  // children `fraction` rolls up for its bar — not a bare "0" of its own.
  if (total == null) {
    const counted = spec.children.filter((c) => c.total);
    if (counted.length > 0) {
      total = counted.reduce((sum, c) => sum + (c.total ?? 0), 0);
      done = counted.reduce((sum, c) => sum + c.done, 0);
    }
  }
  // Nothing counted yet and nothing to count against: say nothing rather than "0".
  if (total == null && done === 0) return '';
  if (total == null) return done.toLocaleString();
  return `${done.toLocaleString()}/${total.toLocaleString()}${pct === null ? '' : ` (${Math.round(pct * 100)}%)`}`;
}

// Tones color ICONS only. Text stays foreground: red text on the dark theme is unreadable,
// so a failure is a tinted row with a red edge, never red words.
const STATE_TONE: Record<string, string> = {
  blocked: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-500',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-amber-600 dark:text-amber-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
};

/** The details view's per-state glyph: what a step IS doing, readable without color. */
const STATE_GLYPH: Record<string, { Icon: LucideIcon; tone: string; spin?: boolean }> = {
  pending: { Icon: Circle, tone: 'text-muted-foreground' },
  running: { Icon: Loader2, tone: 'text-primary', spin: true },
  paused: { Icon: PauseCircle, tone: 'text-muted-foreground' },
  blocked: { Icon: PauseCircle, tone: 'text-amber-600 dark:text-amber-400' },
  completed: { Icon: CheckCircle2, tone: 'text-emerald-600 dark:text-emerald-400' },
  failed: { Icon: XCircle, tone: 'text-red-500' },
  cancelled: { Icon: XCircle, tone: 'text-muted-foreground' },
  interrupted: { Icon: TriangleAlert, tone: 'text-amber-600 dark:text-amber-400' },
};

export const ActivityRow = memo(function ActivityRow({
  spec,
  onPick,
  depth = 0,
  detail = false,
}: {
  spec: ActivityProgressSpec;
  onPick?: (spec: ActivityProgressSpec) => void;
  depth?: number;
  /** The details modal: expanded, a glyph per state, counters, message AND current, and
   *  the error list in the open — the chip's compact row hides all of that. */
  detail?: boolean;
}) {
  const [expanded, setExpanded] = useState(detail);
  // Each row reads the SHARED clock: a list renders in a `.map`, where the parent cannot
  // call a hook per row. Only the top level shows it — elapsed on every child is noise.
  const elapsedMs = useElapsedMs(depth === 0 ? spec : null);
  // Resolving a glyph walks the registry; without this it would re-run on every clock tick.
  const Icon = useMemo(() => iconForActivity(spec), [spec.icon, spec.subject_entity]);
  const pct = fraction(spec);
  const progressText = formatProgress(spec, pct);
  const hasChildren = spec.children.length > 0;
  const glyph = STATE_GLYPH[spec.state] ?? STATE_GLYPH.pending;
  const counters = Object.entries(spec.counters ?? {}).filter(([, n]) => n > 0);

  return (
    <li data-testid="activity-row" data-path={spec.path} data-state={spec.state}>
      <div
        className={cn(
          'flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent',
          detail && spec.state === 'failed' && 'border-l-2 border-red-500 bg-red-500/15',
          detail && spec.state === 'pending' && 'opacity-60',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
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
        {detail ? (
          <glyph.Icon
            className={cn('h-3.5 w-3.5 shrink-0', glyph.tone, glyph.spin && 'animate-spin')}
            data-testid="activity-state-glyph"
          />
        ) : (
          <Icon className={cn('h-3.5 w-3.5 shrink-0', STATE_TONE[spec.state] ?? 'text-muted-foreground')} />
        )}
        <button
          type="button"
          onClick={() => onPick?.(spec)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={spec.label || spec.name}>
              {spec.label || spec.name}
            </span>
            {detail &&
              counters.map(([name, n]) => (
                <span
                  key={name}
                  className="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
                  data-testid="activity-counter"
                >
                  {name} {n}
                </span>
              ))}
            {progressText && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground" data-testid="activity-progress">
                {progressText}
              </span>
            )}
            {elapsedMs > 0 && (
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground" data-testid="activity-elapsed">
                {humanizeSeconds(elapsedMs / 1000)}
              </span>
            )}
            {spec.errors_count > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10px] text-foreground"
                data-testid="activity-errors"
                title={spec.errors.map((e) => (e.ref ? `${e.ref}: ${e.message}` : e.message)).join('\n')}
              >
                <TriangleAlert className="h-3 w-3 text-red-500" />
                {spec.errors_count}
              </span>
            )}
          </span>
          {detail ? (
            <>
              {spec.message && (
                <span className="w-full truncate text-[11px] text-foreground/80" data-testid="activity-message">
                  {spec.message}
                </span>
              )}
              {spec.current && (
                <span className="w-full truncate font-mono text-[10px] text-muted-foreground" data-testid="activity-current">
                  {spec.current}
                </span>
              )}
            </>
          ) : (
            (spec.current || spec.message) && (
              <span className="w-full truncate text-[10px] text-muted-foreground" data-testid="activity-current">
                {spec.current || spec.message}
              </span>
            )
          )}
        </button>
      </div>
      {/* A determinate bar only when there is something determinate to show. */}
      {pct !== null && (
        <div className="mx-2 mb-1 h-0.5 overflow-hidden rounded bg-muted" style={{ marginLeft: 8 + depth * 12 }}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
      {detail && spec.errors.length > 0 && (
        <ul className="mb-1 flex flex-col gap-0.5" style={{ marginLeft: 28 + depth * 12 }} data-testid="activity-error-list">
          {spec.errors.map((e, i) => (
            <li
              key={`${e.ref ?? ''}:${i}`}
              className="flex min-w-0 items-start gap-1.5 rounded-sm border-l-2 border-red-500 bg-red-500/15 px-2 py-0.5 text-[11px] text-foreground"
            >
              <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
              <span className="min-w-0 flex-1">
                {e.ref && <span className="block truncate font-mono text-[10px] text-foreground/80">{e.ref}</span>}
                <span className="block break-words">{e.message}</span>
              </span>
            </li>
          ))}
          {spec.errors_count > spec.errors.length && (
            <li className="px-2 text-[10px] text-muted-foreground">
              +{(spec.errors_count - spec.errors.length).toLocaleString()} more
            </li>
          )}
        </ul>
      )}
      {expanded && hasChildren && (
        <ul className="flex flex-col">
          {/* Keyed by PATH: an index key reshuffles rows the moment a child appears
              mid-run, which is exactly when someone is looking at the list. */}
          {spec.children.map((child) => (
            <ActivityRow key={child.path} spec={child} onPick={onPick} depth={depth + 1} detail={detail} />
          ))}
        </ul>
      )}
    </li>
  );
});
