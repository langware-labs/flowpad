import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAsyncSdkInit } from '@src/hooks/use-async-sdk-init';
import { PrimaryContentProvider, PrimaryContentRegion, usePrimaryContentPending } from '@sdk/react/primary-content';

const start = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@sdk', () => ({ asyncSdkInit: start }));
afterEach(() => { vi.restoreAllMocks(); start.mockClear(); });

function paints() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++id, callback); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(key => { frames.delete(key); });
  return () => act(() => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
  });
}

it('waits through the primary read waterfall and a paint, including StrictMode cleanup', () => {
  const paint = paints();
  const wrapper = ({ children }: { children: ReactNode }) =>
    <StrictMode><PrimaryContentProvider navigationKey="one"><PrimaryContentRegion>{children}</PrimaryContentRegion></PrimaryContentProvider></StrictMode>;
  const mounted = renderHook(({ pending }) => { usePrimaryContentPending(pending); useAsyncSdkInit(); }, {
    wrapper, initialProps: { pending: true },
  });
  paint(); paint();
  expect(start).not.toHaveBeenCalled();
  mounted.rerender({ pending: false });
  paint();
  expect(start).not.toHaveBeenCalled();
  mounted.rerender({ pending: true }); // Child's content read follows resolved parent identity.
  paint(); paint();
  expect(start).not.toHaveBeenCalled();
  mounted.rerender({ pending: false }); // Empty and failed reads release the same way as success.
  paint(); paint();
  expect(start).toHaveBeenCalledTimes(1);
  mounted.unmount();
});

it('cancels scheduled prefetch when the view unmounts', () => {
  const paint = paints();
  const mounted = renderHook(() => useAsyncSdkInit(), {
    wrapper: ({ children }) => <PrimaryContentProvider navigationKey="one">{children}</PrimaryContentProvider>,
  });
  paint(); mounted.unmount(); paint();
  expect(start).not.toHaveBeenCalled();
});
