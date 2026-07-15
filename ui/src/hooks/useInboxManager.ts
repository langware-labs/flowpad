import { ConnectionManager, dataManager, InboxManager, TypeId } from '@sdk';
import { useEffect, useRef, useState } from 'react';
import { useEntity } from './entity-hooks/useEntity';

/**
 * The ONE reader of the backend-owned unread count.
 *
 * `InboxManager.unread` is computed and published exclusively by the backend
 * (`flow_sdk/inbox.reconcile`); every unread surface (sidebar pip, Unread
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
export function useInboxManager(): { unread: number } {
  const [uuid, setUuid] = useState<string | null>(null);

  const { data, refetch } = useEntity<InboxManager>(
    uuid ? new TypeId(InboxManager.type, uuid) : null,
    { watch: true },
  );
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    dataManager
      .getByTypeId(new TypeId(InboxManager.type, '@local'))
      .then((entity) => {
        if (!cancelled && entity?.id) setUuid(entity.id);
      })
      .catch(() => {
        // Backend without the inbox_manager type (older server) — count stays 0.
      });

    const cm = ConnectionManager.getInstance();
    const onOpen = () => void refetchRef.current?.();
    cm.on('on_open', onOpen);
    return () => {
      cancelled = true;
      cm.off('on_open', onOpen);
    };
  }, []);

  return { unread: (data as InboxManager | null)?.unread ?? 0 };
}

/**
 * Mirror the reflected unread count to the OS dock/launcher badge (Electron
 * only; no-op in a browser tab). The badge is STATE driven by the InboxManager
 * entity — it does not ride `desktop_notify` events. Mount once at app root.
 */
export function useSyncOsBadge(): void {
  const { unread } = useInboxManager();
  useEffect(() => {
    (window as unknown as { electronAPI?: { setBadge?: (n: number) => void } })
      .electronAPI?.setBadge?.(unread);
  }, [unread]);
}
