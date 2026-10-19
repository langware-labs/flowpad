import type { Terminal as XTerm } from '@xterm/xterm';

/**
 * Dispose an xterm together with its screen-resolution monitor: one MediaQueryList
 * listener and one window `resize` listener per opened terminal, which xterm (5.5.0)
 * does not register for disposal, so `term.dispose()` alone leaves both attached. The
 * monitor is reached through private fields, hence every step is optional: a terminal
 * that was never opened, or an xterm that moved the monitor, yields nothing.
 */
function disposeXterm(term: XTerm): void {
  const internals = term as unknown as {
    _core?: { _coreBrowserService?: { _screenDprMonitor?: { dispose?: () => void } } };
  };
  internals._core?._coreBrowserService?._screenDprMonitor?.dispose?.();
  term.dispose();
}

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
      disposeXterm(term);
    } catch (e) {
      onError?.(e);
    }
  }, 10);
}
