import { ConnectionManager, dataManager, hubModeReady, StreamInboxManager, isHubOnly, TypeId } from '@sdk';
import { useEffect, useRef, useState } from 'react';
import { useEntity } from './entity-hooks/useEntity';

/**
 * The ONE reader of the backend-owned unread count.
 *
 * `StreamInboxManager.unread` is computed and published exclusively by the backend
 * (`flow_sdk/stream_inbox` reconcile); every unread surface (sidebar pip, Unread
 * pill, OS badge) renders this hook's value and never computes its own.
 *
 * Hides three non-obvious hydration requirements:
 *  1. Force-GET the `@local` alias first — DataManager drops UPDATEs for
 *     entities absent from its cache, so the row must be hydrated before the
 *     first data_op arrives.
 *  2. Subscribe/watch by the RAW UUID — data_ops arrive under the UUID and do
 *     not notify `@local`-alias subscriptions.
 *  3. Refetch on WS reconnect — DataManager re-registers watches on `on_open`,
 *     but updates missed while disconnected are not replayed.
 */
export function useStreamInboxManager(): { unread: number } {
  const [uuid, setUuid] = useState<string | null>(null);

  const { data, refetch } = useEntity<StreamInboxManager>(uuid ? new TypeId(StreamInboxManager.type, uuid) : null, { watch: true });
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    let listening = false;
    const cm = ConnectionManager.getInstance();
    const onOpen = () => void refetchRef.current?.();

    void (async () => {
      // `stream_inbox_manager` is a desktop-only type — the hub backend rejects it
      // with 422, and the WS-reconnect refetch would re-probe it endlessly.
      // This hook mounts at app root, before bootstrap seeds the signal, so
      // await readiness before deciding (see utils/hub-runtime.ts).
      await hubModeReady();
      if (cancelled || isHubOnly()) return;

      dataManager
        .getByTypeId(new TypeId(StreamInboxManager.type, '@local'))
        .then((entity) => {
          if (!cancelled && entity?.id) setUuid(entity.id);
        })
        .catch(() => {
          // Backend without the stream_inbox_manager type (older server) — count stays 0.
        });

      cm.on('on_open', onOpen);
      listening = true;
    })();

    return () => {
      cancelled = true;
      if (listening) cm.off('on_open', onOpen);
    };
  }, []);

  return { unread: (data as StreamInboxManager | null)?.unread ?? 0 };
}

/**
 * Mirror the reflected unread count to the OS dock/launcher badge (Electron
 * only; no-op in a browser tab). The badge is STATE driven by the StreamInboxManager
 * entity — it does not ride `desktop_notify` events. Mount once at app root.
 */
export function useSyncOsBadge(): void {
  const { unread } = useStreamInboxManager();
  useEffect(() => {
    (window as unknown as { electronAPI?: { setBadge?: (n: number) => void } }).electronAPI?.setBadge?.(unread);
  }, [unread]);
}
