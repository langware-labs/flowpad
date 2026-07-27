/**
 * Session-scoped "the user explicitly closed the journey" memory.
 *
 * `closeJourney` sets it, `showJourney` clears it, and the auto-launch
 * load-redirect respects it — otherwise the very next home load re-enters the
 * journey and the X looks like it did nothing. sessionStorage on purpose: a
 * fresh browser session gets auto-launched again; the badge remains the way
 * back within this one.
 */
const KEY = 'flowpad.journey.dismissed';

export function markJourneyDismissed(): void {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // private mode / quota — auto-launch may re-enter; badge still works.
  }
}

export function clearJourneyDismissed(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function isJourneyDismissed(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
