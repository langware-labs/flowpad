import { create } from 'zustand';
import type { NotificationData } from './types';

/**
 * The alert log behind the footer warnings popover.
 *
 * Every `warning`/`error` notification lands here in EVERY view mode. Outside
 * Dev the toast itself is suppressed (see `notify.ts`), so this list is the only
 * place a user meets it — a quiet, reviewable log instead of a stack of popups.
 * In Dev the toast still fires and the entry is logged here too, so a developer
 * loses nothing.
 *
 * Keyed by `id`, so a repeat emit upserts in place — the same dedupe sonner
 * does for live toasts. Newest first, capped: a failure loop that re-emits under
 * fresh ids can't grow the list without bound.
 *
 * These entries are dismissible; the derived `useWarnings()` warnings shown
 * alongside them are not — those describe a live condition and go away when the
 * condition does.
 */
const MAX_ALERTS = 50;

interface AlertState {
  alerts: NotificationData[];
  push: (alert: NotificationData) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  alerts: [],
  push: (alert) =>
    set((s) => ({
      alerts: [alert, ...s.alerts.filter((a) => a.id !== alert.id)].slice(0, MAX_ALERTS),
    })),
  dismiss: (id) =>
    set((s) => {
      const next = s.alerts.filter((a) => a.id !== id);
      return next.length === s.alerts.length ? s : { alerts: next };
    }),
  dismissAll: () => set({ alerts: [] }),
}));
