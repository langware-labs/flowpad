/**
 * A retired xterm leaves its panel at once (its replacement opens in the same
 * container in the same effect), while the dispose itself stays deferred.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retireXterm } from '@src/components/terminal/interactive-terminal/retire-xterm';

afterEach(() => vi.useRealTimers());

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
});
