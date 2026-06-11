import { useEffect } from 'react';
import { APIEntity, ActionInfo, dataManager, TypeId } from '@sdk';

/**
 * Fires the backend ``reconcile-context`` action once per holder, on view-open,
 * to prune context references whose target is gone both locally AND on the hub
 * (origin-gated: the backend only mutates local-origin holders). This is the
 * durable counterpart to the muted "unavailable" chip — the chip stops the 404
 * spam cosmetically; reconcile removes the dead reference for good.
 *
 * Guarded once-per-holder per session so re-renders / re-mounts don't re-hit the
 * hub. On the holder's ``context_refs_cleaned`` event we invalidate each removed
 * typeid so any cached "not found" ref is dropped and the chips disappear live.
 */
const reconciledHolders = new Set<string>();

export function useReconcileContext(holder: APIEntity<any> | null | undefined): void {
  const holderKey = holder?.typeId?.toString() ?? null;
  const hasRefs =
    (holder?.sharedContextEntities?.length ?? 0) > 0 ||
    (holder?.privateContextEntities?.length ?? 0) > 0;

  useEffect(() => {
    if (!holder || !holderKey || !hasRefs) return;

    // Subscribe first so we never miss the event the reconcile may emit.
    const onEvent = (event: string, payload: Record<string, unknown>) => {
      if (event !== 'context_refs_cleaned') return;
      const removed = (payload?.removed as string[] | undefined) ?? [];
      for (const raw of removed) {
        try {
          dataManager.invalidateCacheByTypeId(new TypeId(raw));
        } catch {
          /* malformed typeid from the wire — ignore */
        }
      }
    };
    const unsubscribe = holder.on('entity_event', onEvent);

    if (!reconciledHolders.has(holderKey)) {
      reconciledHolders.add(holderKey);
      const info = new ActionInfo('reconcile-context', holder.typeId.type, holder.typeId.id, 'POST');
      void dataManager.callAction(info).catch((err) => {
        // Non-fatal: a failed reconcile just leaves the muted chips in place.
        // Drop the guard so a later mount can retry.
        reconciledHolders.delete(holderKey);
        console.warn('[reconcile-context] failed (non-fatal):', err);
      });
    }

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holderKey, hasRefs]);
}
