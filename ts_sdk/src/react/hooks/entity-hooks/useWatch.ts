import { dataManager } from '../../../APIEntity';
import { TypeId } from '../../../models/TypeId';
import { releaseWhenWatched } from '../../../process/watch-lease';
import { useEffect } from 'react';

export function useWatch(typeId: TypeId | null, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled || !typeId) return;

    const watching = dataManager.watch(typeId);

    return () => {
      setTimeout(() => releaseWhenWatched(watching), 100);
    };
  }, [enabled, typeId]);
}
