/**
 * Imperative text-input prompt modal — mirrors the delete-asset-modal pattern
 * (external store + singleton component mounted at the app root). Callers
 * anywhere (e.g. tree toolbar actions) can prompt for a name without owning
 * React state for it.
 *
 *   showInputPrompt({
 *     title: 'Create File',
 *     placeholder: 'Enter file name',
 *     onConfirm: async (name) => { await fsManager.writeFile(...); },
 *   });
 */

import { useEffect, useState } from 'react';
import { InputDialog } from '@src/components/ui/input-dialog';

interface PromptRequest {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
}

interface ModalState {
  open: boolean;
  request: PromptRequest | null;
}

let state: ModalState = { open: false, request: null };
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function showInputPrompt(request: PromptRequest): void {
  state = { open: true, request };
  notify();
}

function close(): void {
  state = { open: false, request: null };
  notify();
}

function useModalState(): ModalState {
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

export function InputPromptModal() {
  const { open, request } = useModalState();
  return (
    <InputDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={request?.title ?? ''}
      placeholder={request?.placeholder}
      defaultValue={request?.defaultValue}
      confirmLabel={request?.confirmLabel}
      onConfirm={(value) => {
        const req = state.request;
        close();
        void req?.onConfirm(value);
      }}
    />
  );
}
