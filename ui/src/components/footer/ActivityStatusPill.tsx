/**
 * The activity bar's one-liner: where the newest long job is, in one line, in the footer.
 *
 * `QA cycle · 1/2 · vitest API 2/3 › rca · 1 failed` while it runs; its receipt
 * (`QA cycle — 1 PASS · 1 RED`) once it ends, until dismissed. Clicking opens the
 * details modal with the whole tree.
 *
 * It shows work reported to the BOX. An activity scoped to an agent's own process is that
 * agent's business and is already represented by its worker row in the chip, so it is
 * left out here the same way `PendingActionsChip` leaves it out.
 */

import { useMemo } from 'react';
import { CheckCircle2, Loader2, PauseCircle, X, XCircle } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import { isTerminal, type ActivityProgressSpec } from '@sdk/activity';
import { cn } from '@src/lib/utils';
import { dismissActivityReceipt, useActivities, useActivityReceipt } from '@src/store/activity-store';
import { showActivityDetails } from '@src/store/use-activity-details-store';
import { activityOneLiner, errorsInTree } from './activity-one-liner';

function forTheBox(spec: ActivityProgressSpec): boolean {
  return !spec.subject_entity?.startsWith(`${AgenticProcess.type}-`);
}

function open(spec: ActivityProgressSpec): void {
  showActivityDetails({ path: spec.path, subject_entity: spec.subject_entity ?? null });
}

export function ActivityStatusPill() {
  const all = useActivities();
  const receipt = useActivityReceipt();
  const live = useMemo(() => all.filter((s) => forTheBox(s) && !isTerminal(s)), [all]);

  const shown = live[0] ?? (receipt && forTheBox(receipt) ? receipt : null);
  if (!shown) return null;

  const line = activityOneLiner(shown);
  const ended = isTerminal(shown);
  const red = shown.state === 'failed' || (ended && errorsInTree(shown) > 0);
  const Glyph = ended ? (red ? XCircle : CheckCircle2) : shown.state === 'blocked' ? PauseCircle : Loader2;
  const tone = ended
    ? red
      ? 'text-red-500'
      : 'text-emerald-600 dark:text-emerald-400'
    : shown.state === 'blocked'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-primary';

  return (
    <div
      className={cn(
        'flex min-w-0 items-center rounded-sm text-[10px]',
        ended && red && 'border-l-2 border-red-500 bg-red-500/15',
      )}
      data-testid="activity-status-pill"
      data-state={shown.state}
    >
      <button
        type="button"
        onClick={() => open(shown)}
        className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
        title={`${line} — click for details`}
        aria-label={line}
      >
        <Glyph className={cn('h-3.5 w-3.5 shrink-0', tone, !ended && shown.state !== 'blocked' && 'animate-spin')} />
        <span className="min-w-0 truncate tabular-nums" data-testid="activity-status-line">
          {line}
        </span>
        {live.length > 1 && (
          <span className="shrink-0 text-muted-foreground" data-testid="activity-status-more">
            +{live.length - 1}
          </span>
        )}
      </button>
      {ended && (
        <button
          type="button"
          onClick={dismissActivityReceipt}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
          data-testid="activity-status-dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
