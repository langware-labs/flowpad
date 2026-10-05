import { AgenticProcess, dataManager, webUrlFromPointer, type TypeId } from '@sdk';
import { useEffect } from 'react';
import { forgetWebpageStatus } from './useWebpageStatus';

/**
 * Refresh when the backend shows THIS page again.
 *
 * The check behind the "Couldn't reach" popup runs once per URL, and nothing on
 * the page changes when the server behind it comes back. The backend knows: a
 * `navigate` op that repaired a dead server (an `auto_open` op's agent rung) shows
 * the same place again — a live `on_show` event carrying the same `web-app`
 * pointer. That is exactly "look again", so it forgets the cached check, re-checks
 * and reloads the frame.
 */
export function useReshowRefresh(url: string, refresh: () => void): void {
  useEffect(() => {
    const onEntityEvent = (typeId: TypeId, event: string, payload: Record<string, unknown>): void => {
      if (event !== 'on_show' || typeId.type !== AgenticProcess.type) return;
      if (payload?.kind !== 'dock' || payload.view_type !== 'web-app') return;
      if (webUrlFromPointer(payload.pointer as string | undefined) !== url) return;
      // First, and synchronously: the same show often remounts this display, and a
      // remounted one must not read the old verdict back from the check cache.
      forgetWebpageStatus(url);
      refresh();
    };
    dataManager.on('on_entity_event', onEntityEvent);
    return () => {
      dataManager.off('on_entity_event', onEntityEvent);
    };
  }, [url, refresh]);
}
