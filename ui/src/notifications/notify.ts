import { toast as sonnerToast } from 'sonner';
import type { NotificationData, NotificationInput, NotificationLevel } from './types';
import { useBadgeStore } from './store';
import { renderToast } from './NotificationOutlet';

/**
 * The single notification dispatcher for the whole UI.
 *
 *   notify({ level, title, ... })           // raw
 *   notify.error({ title, message })         // level convenience
 *   notify.busy({ title })                   // spinner, sticky
 *   notify.dismiss(id)
 *
 * `id` dedupes: a second emit with the same id REPLACES the live toast / badge
 * instead of stacking. When omitted it is derived from level + title so trivial
 * call sites need no id (mirrors the old `TOAST_LIMIT = 1` title-collapse).
 *
 * `category` present → persistent sidebar badge (store). Absent → transient toast.
 */

const DEFAULT_DURATION_MS: Record<NotificationLevel, number | null> = {
  info: 6000,
  success: 4000,
  warning: 8000,
  error: null, // sticky until dismissed/replaced
};

/** Tiny synchronous string hash (djb2) for auto-derived ids. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function dispatch(input: NotificationInput): string {
  const id = input.id ?? `${input.level}:${djb2(input.title)}`;
  const data: NotificationData = { ...input, id, timestamp: Date.now() };

  // Persistent badge → sidebar feed; not a toast.
  if (data.category) {
    useBadgeStore.getState().upsert(data);
    return id;
  }

  // Transient toast via sonner.
  const ms = data.busy
    ? Infinity
    : data.durationMs === undefined
      ? DEFAULT_DURATION_MS[data.level]
      : data.durationMs;
  sonnerToast.custom((toastId) => renderToast(data, String(toastId)), {
    id,
    duration: ms === null ? Infinity : ms,
  });
  return id;
}

function dismiss(id: string): void {
  sonnerToast.dismiss(id);
  useBadgeStore.getState().remove(id);
}

type LevelInput = Omit<NotificationInput, 'level'>;
const withLevel = (level: NotificationLevel) => (input: LevelInput) => dispatch({ ...input, level });

export const notify = Object.assign(dispatch, {
  info: withLevel('info'),
  success: withLevel('success'),
  warning: withLevel('warning'),
  error: withLevel('error'),
  busy: (input: LevelInput) => dispatch({ ...input, level: 'info', busy: true }),
  dismiss,
});

export { dismiss };
