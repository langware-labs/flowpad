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
  /** The window is showing a run started elsewhere ("Check first"), with nothing to seed it. */
  watching: boolean;
  /** The warnings-list entry being diagnosed, so a fix can be marked on it. */
  alertId: string | null;
  open: (detail: string, kind: DiagnoseKind, alertId?: string) => void;
  watch: () => void;
  close: () => void;
}

export const useDiagnoseErrorStore = create<DiagnoseErrorState>((set) => ({
  detail: null,
  kind: 'error',
  watching: false,
  alertId: null,
  open: (detail, kind, alertId) => set({ detail, kind, alertId: alertId ?? null }),
  watch: () => set({ detail: null, watching: true, alertId: null }),
  close: () => set({ detail: null, watching: false, alertId: null }),
}));
