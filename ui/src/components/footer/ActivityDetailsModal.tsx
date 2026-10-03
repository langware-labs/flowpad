/**
 * The whole tree of one long job: every step with its state, counts, counters, the
 * failures with their refs, and what is in hand right now. Opened from the activity pill.
 *
 * Reads the LIVE tree by address, and falls back to the receipt once the root has ended
 * and left the live list — the modal must not go blank at the moment the verdict lands.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { useActivityReceipt, useActivitySpec } from '@src/store/activity-store';
import { useActivityDetailsStore } from '@src/store/use-activity-details-store';
import { useElapsedMs } from '@src/hooks/useActivity';
import { humanizeSeconds } from '@src/utils/duration';
import { ActivityRow } from './ActivityRow';
import { activityOneLiner } from './activity-one-liner';

export function ActivityDetailsModalRoot() {
  const open = useActivityDetailsStore((s) => s.open);
  const payload = useActivityDetailsStore((s) => s.payload);
  const setOpen = useActivityDetailsStore((s) => s.setOpen);
  const live = useActivitySpec(payload?.path ?? '', payload?.subject_entity ?? null);
  const receipt = useActivityReceipt();
  const spec =
    live ??
    (receipt && payload && receipt.path === payload.path && (receipt.subject_entity ?? null) === payload.subject_entity
      ? receipt
      : null);
  const elapsedMs = useElapsedMs(spec);

  return (
    <Dialog open={open && !!payload} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl" data-testid="activity-details-modal">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">{spec ? spec.label || spec.name : payload?.path}</DialogTitle>
          {spec && (
            <p className="text-xs text-muted-foreground" data-testid="activity-details-summary">
              {activityOneLiner(spec)}
              {elapsedMs > 0 && ` · ${humanizeSeconds(elapsedMs / 1000)}`}
            </p>
          )}
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto pe-1">
          {spec ? (
            <ul className="flex flex-col">
              <ActivityRow spec={spec} detail />
            </ul>
          ) : (
            <p className="px-3 py-2 text-xs italic text-muted-foreground">Nothing is running at this address anymore.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
