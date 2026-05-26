import { soundService } from '@sdk';
import { useSettings } from '@sdk/react/hooks/use-settings';
import { usePendingActions } from '@src/store/pending-actions-store';
import { useEffect, useRef } from 'react';
import { soundByKey } from '@src/assets/sounds/notification/manifest';

/**
 * Fire one notification sound each time an agentic process becomes ready
 * for input during the current session.
 *
 * Mount this once at app scope (footer). Renders nothing.
 *
 * Cold-reload safety: we gate the ping on the server-stamped
 * `ready_for_input_since` being strictly newer than this hook's mount time.
 * Items the store hydrates from WS after first render whose `readyAt`
 * predates mount are part of the user's backlog from before the reload —
 * not "new news" — and stay silent. Only true mid-session transitions ping.
 */
export function usePendingCompletionSound(): void {
  const pending = usePendingActions();
  const { settings } = useSettings();
  const mountedAtRef = useRef<number>(Date.now());
  // processId -> readyAt of the last time we observed/announced this id.
  // Re-arming (TTL expiry → re-ready with a fresh server timestamp) shows
  // up as a different readyAt for the same id, which is correctly treated
  // as a new transition.
  const seenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let hasNew = false;
    const currentIds = new Set<string>();
    for (const e of pending) {
      currentIds.add(e.processId);
      if (seenRef.current.get(e.processId) === e.readyAt) continue;
      seenRef.current.set(e.processId, e.readyAt);
      if (e.readyAt > mountedAtRef.current) hasNew = true;
    }
    // Drop entries no longer pending so a future re-arm with a fresh
    // readyAt is always treated as new (defensive — readyAt comparison
    // already handles it, but keeps the map from growing unbounded).
    for (const id of seenRef.current.keys()) {
      if (!currentIds.has(id)) seenRef.current.delete(id);
    }
    if (!hasNew) return;
    if (!settings.notificationSoundEnabled) return;
    const sound = soundByKey(settings.notificationSoundKey);
    if (!sound) return;
    void soundService.play(sound.url);
  }, [pending, settings.notificationSoundEnabled, settings.notificationSoundKey]);
}
