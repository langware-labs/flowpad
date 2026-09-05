import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAsyncSdkInit } from '@src/hooks/use-async-sdk-init';

const start = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@sdk', () => ({ asyncSdkInit: start }));
afterEach(() => { vi.restoreAllMocks(); start.mockClear(); });

it('starts after a paint opportunity and cancels StrictMode/unmounted frames', () => {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(key => { frames.delete(key); });
  const paint = () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  });
  const mounted = renderHook(() => useAsyncSdkInit(), { wrapper: StrictMode });
  expect(frames.size).toBe(1);
  paint();
  expect(start).not.toHaveBeenCalled();
  paint();
  expect(start).toHaveBeenCalledTimes(1);
  mounted.unmount();

  const cancelled = renderHook(() => useAsyncSdkInit());
  paint();
  cancelled.unmount();
  paint();
  expect(start).toHaveBeenCalledTimes(1);
});
