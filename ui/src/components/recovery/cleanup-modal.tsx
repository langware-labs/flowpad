/**
 * Cleanup modal — shown after `loadNextProcess` cleans up multiple invalid
 * sessions in a single pass. Single-cleanup events go through `toast` instead
 * (see `handleCleanups` in load-shell.ts).
 *
 * The state is held outside React (a tiny external store) so non-component
 * code (route loaders) can call `showCleanupModal({count})` and have the
 * `<CleanupModal />` instance — mounted once at the app root — render.
 */

import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';

interface CleanupState {
  open: boolean;
  count: number;
}

let state: CleanupState = { open: false, count: 0 };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function showCleanupModal(opts: { count: number }): void {
  state = { open: true, count: opts.count };
  notify();
}

function closeCleanupModal(): void {
  state = { open: false, count: state.count };
  notify();
}

function useCleanupState(): CleanupState {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const tick = () => forceTick((n) => n + 1);
    listeners.add(tick);
    return () => {
      listeners.delete(tick);
    };
  }, []);
  return state;
}

export function CleanupModal() {
  const { open, count } = useCleanupState();
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) closeCleanupModal(); }}>
      <AlertDialogContent data-testid="cleanup-modal">
        <AlertDialogHeader>
          <AlertDialogTitle><Trans>Cleaned invalid sessions</Trans></AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>We skipped {count} session{count === 1 ? '' : 's'} that couldn't be restored.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={closeCleanupModal} data-testid="cleanup-modal-ok">
            <Trans>OK</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
