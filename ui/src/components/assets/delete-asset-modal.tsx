/**
 * Imperative delete-asset confirmation modal — the external-store
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

import { useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { Checkbox } from '@src/components/ui/checkbox';
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

export interface DeleteOption {
  /** The key this option's answer is submitted under. */
  key: string;
  label: string;
  description?: string;
  /** Shown, as a warning, only while the option is checked. */
  warning?: string;
  defaultChecked: boolean;
}

interface DeleteRequest {
  name: string;
  /** Receives each option's answer by its key; `{}` when there are none. */
  onConfirm: (checked: Record<string, boolean>) => Promise<void>;
  onAfterDelete?: () => void;
  /** Overrides the default "removes the file from disk" warning copy. */
  description?: string;
  checkboxes?: DeleteOption[];
  /** The confirm button's label for the current answers; "Delete" when absent. */
  confirmLabel?: (checked: Record<string, boolean>) => string;
}

interface ModalState {
  open: boolean;
  request: DeleteRequest | null;
  busy: boolean;
  error: string | null;
  checked: Record<string, boolean>;
}

const CLOSED_STATE: ModalState = { open: false, request: null, busy: false, error: null, checked: {} };
let state = CLOSED_STATE;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ModalState {
  return state;
}

function notify() {
  for (const l of listeners) l();
}

export function showDeleteAssetModal(request: DeleteRequest): void {
  // Every open starts from the defaults: a choice never carries over to the next delete.
  const checked = Object.fromEntries((request.checkboxes ?? []).map((option) => [option.key, option.defaultChecked]));
  state = { ...CLOSED_STATE, open: true, request, checked };
  notify();
}

function close(): void {
  state = CLOSED_STATE;
  notify();
}

async function runConfirm(): Promise<void> {
  const req = state.request;
  if (!req) return;
  state = { ...state, busy: true, error: null };
  notify();
  try {
    await req.onConfirm(state.checked);
    const afterDelete = req.onAfterDelete;
    close();
    afterDelete?.();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = { ...state, busy: false, error: message };
    notify();
  }
}

export function DeleteAssetModal() {
  const { open, request, busy, error, checked } = useSyncExternalStore(subscribe, getSnapshot);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) close();
      }}
    >
      <AlertDialogContent data-testid="delete-asset-modal">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Delete {request?.name ?? 'asset'}?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {request?.description ?? <Trans>This permanently removes the file from disk. This cannot be undone.</Trans>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {request?.checkboxes?.map((option) => (
          <div key={option.key} className="flex items-start gap-3">
            <Checkbox
              id={`delete-asset-option-${option.key}`}
              checked={checked[option.key] ?? false}
              disabled={busy}
              onCheckedChange={(value) => {
                state = { ...state, checked: { ...state.checked, [option.key]: value === true } };
                notify();
              }}
            />
            <div className="grid gap-1">
              <label htmlFor={`delete-asset-option-${option.key}`} className="text-sm font-medium">
                {option.label}
              </label>
              {option.description && <p className="text-sm text-muted-foreground">{option.description}</p>}
              {option.warning && checked[option.key] && (
                <p className="text-sm text-destructive" role="alert">
                  {option.warning}
                </p>
              )}
            </div>
          </div>
        ))}
        {error && (
          <p className="text-sm text-destructive" data-testid="delete-asset-modal-error">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void runConfirm();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="delete-asset-modal-confirm"
          >
            {busy ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : null}
            {request?.confirmLabel ? request.confirmLabel(checked) : <Trans>Delete</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
