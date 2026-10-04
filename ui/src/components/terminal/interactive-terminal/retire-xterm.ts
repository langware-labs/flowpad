import type { Terminal as XTerm } from '@xterm/xterm';

/**
 * Take an xterm out of its view NOW, dispose it a beat later.
 *
 * The dispose stays deferred (it has been since the first release), but the
 * terminal's DOM leaves the container at once: the effect that retires it is
 * the same one that opens its replacement in that container, so a deferred
 * removal left TWO terminals in one panel until the timer fired — a remount
 * (StrictMode's double effect, a session change) showed both.
 */
export function retireXterm(term: XTerm, onError?: (e: unknown) => void): void {
  term.element?.remove();
  setTimeout(() => {
    try {
      term.dispose();
    } catch (e) {
      onError?.(e);
    }
  }, 10);
}
