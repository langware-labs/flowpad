import { fsManager } from '../../services/fsService';
import type { TypeId } from '../../models/TypeId';
import { useEffect, useRef, useState } from 'react';

/**
 * Call `onChange` whenever the file changes on disk, while mounted.
 *
 * Watches on mount and unwatches on unmount (or when the file changes), through
 * `fsManager.watchFile` → the entity `fs/watch` action → `file_changed_msg`.
 * The latest `onChange` is always the one called, so it need not be stable.
 * Watches are expensive, so a hidden window unwatches; coming back calls
 * `onChange` once to catch up on whatever changed meanwhile.
 */
export function useFileWatch(
  typeid: TypeId | null | undefined,
  path: string | null | undefined,
  onChange: () => void,
): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = typeid ? typeid.toString() : '';
  const shown = useWindowShown();
  const wasShown = useRef(shown);
  useEffect(() => {
    if (!typeid || !path || !shown) return;
    if (!wasShown.current) latest.current();
    wasShown.current = true;
    return fsManager.watchFile(typeid, path, () => latest.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id string, not the TypeId object
  }, [key, path, shown]);
  useEffect(() => { if (!shown) wasShown.current = false; }, [shown]);
}

function useWindowShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return shown;
}
