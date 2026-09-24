import { fsManager, type TypeId } from '../..';
import { useEffect, useRef } from 'react';

/**
 * Call `onChange` whenever the file changes on disk, while mounted.
 *
 * Watches on mount and unwatches on unmount (or when the file changes), through
 * `fsManager.watchFile` → the entity `fs/watch` action → `file_changed_msg`.
 * The latest `onChange` is always the one called, so it need not be stable.
 */
export function useFileWatch(typeid: TypeId | null | undefined, path: string | null | undefined, onChange: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = typeid ? typeid.toString() : '';
  useEffect(() => {
    if (!typeid || !path) return;
    return fsManager.watchFile(typeid, path, () => latest.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id string, not the TypeId object
  }, [key, path]);
}
