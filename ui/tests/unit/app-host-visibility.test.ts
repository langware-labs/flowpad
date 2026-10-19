/**
 * A served app is parked, not unloaded, when its tab is not shown — hidden with CSS, which the
 * browser does not count as hidden. So the host says when it parks and shows the frame, and the SDK
 * folds that into the app's own `document.hidden`: code that already rests when the page is hidden
 * rests when parked too, and no app polls behind every other tab.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VISIBILITY_MESSAGE, VISIBILITY_PLEASE_MESSAGE, adoptHostVisibility } from '@sdk/apps/host';

const tell = (hidden: unknown) => window.dispatchEvent(new MessageEvent('message', { data: { type: VISIBILITY_MESSAGE, hidden } }));

describe('a served app adopts the host\'s visibility', () => {
  const post = vi.fn();
  beforeAll(() => {
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window);
    adoptHostVisibility();
    adoptHostVisibility(); // installed once
  });
  afterAll(() => vi.restoreAllMocks());

  it('asks the host once whether it is on screen, and starts visible', () => {
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: VISIBILITY_PLEASE_MESSAGE }, '*');
    expect(document.hidden).toBe(false);
    expect(document.visibilityState).toBe('visible');
  });

  it('parked by the host: document.hidden is true and visibilitychange fired once', () => {
    const changes = vi.fn();
    document.addEventListener('visibilitychange', changes);
    tell(true);
    expect(document.hidden).toBe(true);
    expect(document.visibilityState).toBe('hidden');
    tell(true); // said again: nothing changed, nothing fired
    expect(changes).toHaveBeenCalledTimes(1);
    tell(false);
    expect(document.hidden).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    document.removeEventListener('visibilitychange', changes);
  });

  it('ignores a message that is not the host\'s', () => {
    tell('yes');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'flowpad:theme', hidden: true } }));
    expect(document.hidden).toBe(false);
  });
});
