/**
 * A retired xterm leaves its panel at once (its replacement opens in the same
 * container in the same effect), while the dispose itself stays deferred.
 */
import { Terminal as XTerm } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retireXterm } from '@src/components/terminal/interactive-terminal/retire-xterm';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom has no matchMedia: a stand-in that counts the listeners still attached. */
function countingMatchMedia() {
  const live = new Set<unknown>();
  const matchMedia = (media: string) => ({
    media,
    matches: false,
    addListener: (listener: unknown) => live.add(listener),
    removeListener: (listener: unknown) => live.delete(listener),
  });
  return { live, matchMedia };
}

/** Net `resize` listeners on `window`, counted through the real add/remove. */
function countWindowResizeListeners() {
  const live = new Set<unknown>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: unknown, options?: unknown) => {
    if (type === 'resize') live.add(listener);
    add(type, listener as EventListener, options as AddEventListenerOptions);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener: unknown, options?: unknown) => {
    if (type === 'resize') live.delete(listener);
    remove(type, listener as EventListener, options as EventListenerOptions);
  });
  return live;
}

describe('retireXterm', () => {
  it('removes the terminal from its container immediately and disposes it later', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const element = document.createElement('div');
    element.className = 'terminal xterm';
    container.appendChild(element);
    const dispose = vi.fn();
    const term = { element, dispose } as unknown as Parameters<typeof retireXterm>[0];

    retireXterm(term);

    expect(container.querySelectorAll('.xterm')).toHaveLength(0); // one panel, one terminal
    expect(dispose).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a dispose error instead of throwing', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const term = {
      element: undefined,
      dispose: () => {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof retireXterm>[0];
    retireXterm(term, onError);
    vi.runAllTimers();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // xterm's screen-resolution monitor is not disposed by `term.dispose()`; a
  // retired terminal must leave nothing attached to the window. This runs the
  // real xterm, so an upgrade that moves the monitor fails here.
  it('leaves no screen-resolution listener behind', () => {
    const media = countingMatchMedia();
    vi.stubGlobal('matchMedia', media.matchMedia);
    const resize = countWindowResizeListeners();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const term = new XTerm({ cols: 20, rows: 5 });
    term.open(container);
    expect(media.live.size).toBe(1);
    expect(resize.size).toBeGreaterThan(0);

    vi.useFakeTimers();
    const onError = vi.fn();
    retireXterm(term, onError);
    vi.runAllTimers();

    expect(onError).not.toHaveBeenCalled();
    expect.soft(media.live.size).toBe(0);
    expect.soft(resize.size).toBe(0);
    container.remove();
  });
});
