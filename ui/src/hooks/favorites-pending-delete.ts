import { t } from '@lingui/core/macro';
import { registerCommand } from '@src/notifications/commands';
import { notify } from '@src/notifications/notify';
import { useSyncExternalStore } from 'react';

/**
 * The favorites UNDO window — one shared store for every favorites surface.
 *
 * A confirmed remove/delete is not written at once: its rows are hidden here,
 * an "Undo" toast is shown, and the server delete runs when the window closes.
 * Undo just un-hides — nothing was written, so nothing has to be restored.
 *
 * Module state, not hook state, on purpose: the bookmarks menu closes on the
 * very navigation that follows a remove, and every surface (menu, desktop grid,
 * star) opens its own `useFavorites()`. A per-hook hide would die with the menu,
 * differ between surfaces, and could be cleared by a WS refetch mid-window.
 *
 * ONE pending delete at a time: a second delete commits the first and takes the
 * toast over, so the single Undo always means "the thing you just removed".
 *
 * A committed delete un-hides only after its own refetch, when the rows are
 * already gone — so the hidden set is empty again whenever nothing is pending.
 */

/** How long a removal can be undone. A UX window, not a wait on anything. */
export const FAVORITES_UNDO_MS = 5000;
const TOAST_ID = 'favorites-undo';
const UNDO_COMMAND = 'favorites.undo';

interface Pending {
  ids: string[];
  commit: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

let pending: Pending | null = null;
let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function setHidden(next: ReadonlySet<string>): void {
  hidden = next;
  for (const l of listeners) l();
}

function hide(ids: string[]): void {
  setHidden(new Set([...hidden, ...ids]));
}

function unhide(ids: string[]): void {
  const next = new Set(hidden);
  for (const id of ids) next.delete(id);
  setHidden(next);
}

/** Write the pending delete now. Safe to call with nothing pending. */
export async function flushPendingFavoriteDelete(): Promise<void> {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  // The toast's own timer pauses on hover and in a hidden tab, so it can
  // outlive this window — take it down now, or its Undo would be a dead button.
  notify.dismiss(TOAST_ID);
  try {
    await p.commit();
  } catch (e) {
    notify.info({ id: TOAST_ID, title: t`Couldn't remove — restored`, message: String(e) });
  } finally {
    unhide(p.ids);
  }
}

/** Cancel the pending delete and bring its rows back. */
function undoPendingFavoriteDelete(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);
  unhide(p.ids);
  notify.dismiss(TOAST_ID);
}

/**
 * Hide `ids` now and delete them after the undo window. `commit` performs the
 * server writes; it runs at most once.
 */
export function scheduleFavoriteDelete({
  ids,
  title,
  commit,
}: {
  ids: string[];
  title: string;
  commit: () => Promise<void>;
}): void {
  void flushPendingFavoriteDelete();
  hide(ids);
  pending = { ids, commit, timer: setTimeout(() => void flushPendingFavoriteDelete(), FAVORITES_UNDO_MS) };
  notify.info({
    id: TOAST_ID,
    title: t`Removed “${title}”`,
    durationMs: FAVORITES_UNDO_MS,
    actions: [{ label: t`Undo`, command: UNDO_COMMAND }],
  });
}

registerCommand(UNDO_COMMAND, () => undoPendingFavoriteDelete());

// A confirmed delete is never lost to a closing window.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushPendingFavoriteDelete());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Bookmark ids hidden by a pending (or just-committed) favorites delete. */
export function useHiddenFavoriteIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => hidden);
}
