/**
 * Perf hunt 2026-11-07 (B3): every chat message rendered twice on mount. ``useDataStreamText``
 * reset its cached snapshot in an effect after the first render, so useSyncExternalStore saw a
 * new object and rendered again — a 379-message chat paid ~0.4 s of extra markdown on open.
 * The stream must still update on chunks and readiness, and start clean for a new FlowData.
 */
import { act, renderHook } from '@testing-library/react';
import { FlowData, FlowElementTypes } from '@sdk';
import { useDataStreamText } from '@sdk/react/hooks';
import { describe, expect, it } from 'vitest';

describe('useDataStreamText', () => {
  it('renders once on mount, then follows chunks, readiness and a new FlowData', () => {
    const first = new FlowData(FlowElementTypes.CHAT, 'hello');
    let renders = 0;
    const { result, rerender } = renderHook(
      ({ fd }) => {
        renders++;
        return useDataStreamText(fd);
      },
      { initialProps: { fd: first } },
    );
    expect(renders).toBe(1);

    act(() => first.appendContent(' world'));
    expect(result.current.partialContent).toBe('hello world');

    act(() => first.markReady());
    expect(result.current.isComplete).toBe(true);

    const second = new FlowData(FlowElementTypes.CHAT, 'next');
    rerender({ fd: second });
    expect(result.current.partialContent).toBe('next');
  });
});
