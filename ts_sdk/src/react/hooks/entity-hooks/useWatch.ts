import { dataManager, TypeId } from '@sdk';
import { useEffect } from 'react';

export function useWatch(typeId: TypeId | null, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled || !typeId) return;

    let unwatch: () => Promise<void>;

    const setupWatch = async () => {
      unwatch = await dataManager.watch(typeId);
    };

    void setupWatch();

    return () => {
      if (unwatch) setTimeout(() => void unwatch(), 100);
    };
  }, [enabled, typeId]);
}
