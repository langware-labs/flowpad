import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackKeyboardInset } from '@src/components/phone-shell/keyboard-inset';

const read = (name: string) => document.documentElement.style.getPropertyValue(name);

describe('trackKeyboardInset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('style');
  });

  it('publishes the visible area when the keyboard opens, and ignores a pinch-zoom', () => {
    const listeners: Array<() => void> = [];
    const vv = {
      height: 714,
      offsetTop: 0,
      scale: 1,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    };
    const frames: Array<() => void> = [];
    // An event, then the frame it asked for.
    const fire = () => {
      listeners.forEach((fn) => fn());
      frames.splice(0).forEach((fn) => fn());
    };
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn));
    trackKeyboardInset();

    Object.assign(vv, { height: 384, offsetTop: 330 });
    fire();
    expect([read('--vvt'), read('--vvh')]).toEqual(['330px', '384px']);

    Object.assign(vv, { height: 200, offsetTop: 50, scale: 2 });
    fire();
    expect([read('--vvt'), read('--vvh')]).toEqual(['330px', '384px']);

    Object.assign(vv, { height: 714, offsetTop: 0, scale: 1 });
    fire();
    expect([read('--vvt'), read('--vvh')]).toEqual(['0px', '714px']);
  });
});
