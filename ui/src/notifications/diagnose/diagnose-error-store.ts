import { create } from 'zustand';

/** What is being diagnosed — drives the modal's wording and tint. */
export type DiagnoseKind = 'error' | 'warning';

/**
 * Global host state for the "diagnose this error / warning" modal. A failed-request
 * toast, an error/warning notification, or a derived warning in the warnings
 * popover carries a small stethoscope icon; clicking it calls `open(detail, kind)`
 * here, which surfaces the confirmation modal mounted once in App. Confirming runs
 * the Flowpad self-diagnosis seeded with that detail.
 */
interface DiagnoseErrorState {
  /** The detail to diagnose; `null` when the modal is closed. */
  detail: string | null;
  kind: DiagnoseKind;
  open: (detail: string, kind: DiagnoseKind) => void;
  close: () => void;
}

export const useDiagnoseErrorStore = create<DiagnoseErrorState>((set) => ({
  detail: null,
  kind: 'error',
  open: (detail, kind) => set({ detail, kind }),
  close: () => set({ detail: null }),
}));
