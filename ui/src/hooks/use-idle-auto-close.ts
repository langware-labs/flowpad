import { useEffect, useRef } from 'react';

/** Default idle window before an auto-closing surface dismisses itself. This is
 *  a product spec (the left slider closes after 5s of no interaction), NOT a
 *  latency band-aid — keep it a named constant, don't widen it to paper over
 *  anything. */
export const IDLE_AUTO_CLOSE_MS = 5000;

/**
 * Fire `onIdle` after `idleMs` of no user interaction while `active` is true.
 *
 * Any pointer movement, pointer/key press, or wheel anywhere in the window
 * resets the timer ("no user input/movement"). Disarms when `active` flips
 * false and on unmount. `onIdle` is read through a ref so a caller needn't
 * memoize it to avoid re-arming.
 */
export function useIdleAutoClose(active: boolean, onIdle: () => void, idleMs: number = IDLE_AUTO_CLOSE_MS): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!active) return;

    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), idleMs);
    };

    const events: Array<keyof WindowEventMap> = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    for (const ev of events) window.addEventListener(ev, arm, { passive: true });
    arm();

    return () => {
      clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, arm);
    };
  }, [active, idleMs]);
}
