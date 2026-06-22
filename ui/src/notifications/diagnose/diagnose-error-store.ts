import { create } from 'zustand';

/**
 * Global host state for the "diagnose this error" modal. A failed-request toast
 * (or any error notification) carries a small stethoscope icon; clicking it
 * calls `open(errorText)` here, which surfaces the confirmation modal mounted
 * once in App. Confirming runs the Flowpad self-diagnosis seeded with the error.
 */
interface DiagnoseErrorState {
  /** The error detail to diagnose; `null` when the modal is closed. */
  errorText: string | null;
  open: (errorText: string) => void;
  close: () => void;
}

export const useDiagnoseErrorStore = create<DiagnoseErrorState>((set) => ({
  errorText: null,
  open: (errorText) => set({ errorText }),
  close: () => set({ errorText: null }),
}));
