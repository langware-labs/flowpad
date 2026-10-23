/**
 * Timers and DOM signals around `freezeReducer` (see close-freeze.ts).
 */
import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import { FREEZE_IDLE, FREEZE_IDLE_MS, FREEZE_LEAVE_DELAY_MS, freezeReducer } from '@src/components/tabs/close-freeze';

/**
 * @param keys  the tab keys in row order
 * @param stripRef  the strip element; its width changing releases the freeze
 * @param maxPx  a tab's full width
 */
export function useCloseFreeze(keys: string[], stripRef: RefObject<HTMLElement | null>, maxPx: number) {
  const [state, dispatch] = useReducer(freezeReducer, FREEZE_IDLE);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Tabs closed by the mouse that have not left `keys` yet. */
  const closing = useRef(new Set<string>());
  const frozen = state.frozenPx !== null;

  const release = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    leaveTimer.current = idleTimer.current = null;
    closing.current.clear();
    dispatch({ type: 'release' });
  }, []);

  /** Call from the close button, before the owner removes the tab. */
  const closeByMouse = useCallback(
    (key: string, chip: HTMLElement) => {
      closing.current.add(key);
      dispatch({
        type: 'closeByMouse',
        tabPx: chip.getBoundingClientRect().width,
        maxPx,
        index: keys.indexOf(key),
        count: keys.length,
      });
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(release, FREEZE_IDLE_MS);
    },
    [keys, maxPx, release],
  );

  // Any change to the tab list other than the mouse-closed tabs leaving it
  // (a new tab, a reorder, a batch or keyboard close) restores normal widths.
  const prevKeys = useRef(keys);
  useEffect(() => {
    const prev = prevKeys.current;
    prevKeys.current = keys;
    if (prev === keys) return;
    const expected = prev.filter((k) => !closing.current.has(k));
    const onlyClosedLeft = expected.length === keys.length && expected.every((k, i) => k === keys[i]);
    if (onlyClosedLeft) {
      for (const k of prev) if (!keys.includes(k)) closing.current.delete(k);
    } else if (frozen) {
      release();
    }
  }, [keys, frozen, release]);

  // The strip changing width means the tabs share a different space.
  useEffect(() => {
    const strip = stripRef.current;
    if (!frozen || !strip) return;
    const start = strip.clientWidth;
    const observer = new ResizeObserver(() => {
      if (strip.clientWidth !== start) release();
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [frozen, stripRef, release]);

  const onPointerLeave = useCallback(() => {
    if (!frozen) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(release, FREEZE_LEAVE_DELAY_MS);
  }, [frozen, release]);

  const onPointerEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);

  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  return { frozenPx: state.frozenPx, leadPad: state.leadPad, closeByMouse, onPointerLeave, onPointerEnter };
}
