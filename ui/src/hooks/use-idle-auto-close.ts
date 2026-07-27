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
 *
 * Pass `idleMs: null` to opt OUT entirely — for a surface that owns its own
 * dismissal, e.g. a hover menu that closes on pointer-leave. Idle-close and
 * hover-close are genuinely opposed: this hook listens on the WINDOW, so a
 * pointer parked inside a panel to read it emits no `pointermove` and the panel
 * would close out from under the very pointer holding it open. That opt-out is
 * why the escape is structural rather than a big `idleMs` — and note a big one
 * cannot work anyway: `Infinity` is coerced to a 0ms delay by `setTimeout` and
 * would close instantly.
 */
export function useIdleAutoClose(
  active: boolean,
  onIdle: () => void,
  idleMs: number | null = IDLE_AUTO_CLOSE_MS,
): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!active || idleMs === null) return;

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
