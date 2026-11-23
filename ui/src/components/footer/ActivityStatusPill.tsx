/**
 * The activity bar's one-liner: where the newest long job is, in one line, in the footer.
 *
 * `QA cycle · 1/2 · vitest API 2/3 › rca · 1 failed` while it runs; once the job ends the
 * line is gone. Clicking opens the details modal with the whole tree.
 *
 * It shows work reported to the BOX. An activity scoped to an agent's own process is that
 * agent's business and is already represented by its worker row in the chip, so it is
 * left out here the same way `PendingActionsChip` leaves it out.
 */

import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Loader2, PauseCircle } from 'lucide-react';
import { AgenticProcess } from '@sdk';
import { isTerminal, type ActivityProgressSpec } from '@sdk/activity';
import { cn } from '@src/lib/utils';
import { useActivities } from '@src/store/activity-store';
import { showActivityDetails } from '@src/store/use-activity-details-store';
import { activityOneLiner } from './activity-one-liner';

function forTheBox(spec: ActivityProgressSpec): boolean {
  return !spec.subject_entity?.startsWith(`${AgenticProcess.type}-`);
}

function open(spec: ActivityProgressSpec): void {
  showActivityDetails({ path: spec.path, subject_entity: spec.subject_entity ?? null });
}

export function ActivityStatusPill() {
  const { t } = useLingui();
  const all = useActivities();
  const live = useMemo(() => all.filter((s) => forTheBox(s) && !isTerminal(s)), [all]);

  const shown = live[0];
  if (!shown) return null;

  const line = activityOneLiner(shown);
  const blocked = shown.state === 'blocked';
  const Glyph = blocked ? PauseCircle : Loader2;

  return (
    <div
      className="flex min-w-0 items-center rounded-sm text-[10px]"
      data-testid="activity-status-pill"
      data-state={shown.state}
    >
      <button
        type="button"
        onClick={() => open(shown)}
        className="flex min-w-0 items-center gap-1 rounded-sm px-1.5 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
        title={t`${line} — click for details`}
        aria-label={line}
      >
        <Glyph
          className={cn('h-3.5 w-3.5 shrink-0', blocked ? 'text-amber-600 dark:text-amber-400' : 'animate-spin text-primary')}
        />
        <span className="min-w-0 truncate tabular-nums" data-testid="activity-status-line">
          {line}
        </span>
        {live.length > 1 && (
          <span className="shrink-0 text-muted-foreground" data-testid="activity-status-more">
            +{live.length - 1}
          </span>
        )}
      </button>
    </div>
  );
}
