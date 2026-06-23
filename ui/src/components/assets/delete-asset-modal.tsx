/**
 * Imperative delete-asset confirmation modal — mirrors the cleanup-modal
 * pattern (external store + singleton component mounted at the app root).
 * Callers anywhere (sidebar toolbar actions, editor header buttons) can
 * trigger the same dialog without owning React state for it.
 *
 *   showDeleteAssetModal({
 *     name: 'foo.md',
 *     onConfirm: async () => { await entity.delete(); },
 *     onAfterDelete: () => navigation.openDock(...),
 *   });
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@src/components/ui/alert-dialog';

interface DeleteRequest {
  name: string;
  onConfirm: () => Promise<void>;
  onAfterDelete?: () => void;
  /** Overrides the default "removes the file from disk" warning copy. */
  description?: string;
}

interface ModalState {
  open: boolean;
  request: DeleteRequest | null;
  busy: boolean;
  error: string | null;
}

let state: ModalState = { open: false, request: null, busy: false, error: null };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function showDeleteAssetModal(request: DeleteRequest): void {
  state = { open: true, request, busy: false, error: null };
  notify();
}

function close(): void {
  state = { open: false, request: null, busy: false, error: null };
  notify();
}

async function runConfirm(): Promise<void> {
  const req = state.request;
  if (!req) return;
  state = { ...state, busy: true, error: null };
  notify();
  try {
    await req.onConfirm();
    const afterDelete = req.onAfterDelete;
    close();
    afterDelete?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { ...state, busy: false, error: message };
    notify();
  }
}

function useModalState(): ModalState {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const tick = () => forceTick((n) => n + 1);
    listeners.add(tick);
    return () => { listeners.delete(tick); };
  }, []);
  return state;
}

export function DeleteAssetModal() {
  const { open, request, busy, error } = useModalState();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) close();
      }}
    >
      <AlertDialogContent data-testid="delete-asset-modal">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {request?.name ?? 'asset'}?</AlertDialogTitle>
          <AlertDialogDescription>
            {request?.description ?? 'This permanently removes the file from disk. This cannot be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive" data-testid="delete-asset-modal-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void runConfirm();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="delete-asset-modal-confirm"
          >
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
