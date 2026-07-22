// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EventBus } from '@sdk';
import { useOnTopic } from '@sdk/react/hooks';

describe('useOnTopic — subscription lifetime is component lifetime', () => {
  beforeEach(() => EventBus.clear());

  it('delivers while mounted, unsubscribes on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useOnTopic('app.page.signal', handler));

    EventBus.emit('app.page.signal', 'next');
    expect(handler).toHaveBeenCalledTimes(1);

    unmount();
    EventBus.emit('app.page.signal', 'next');
    expect(handler).toHaveBeenCalledTimes(1); // no leak past unmount
  });

  it('pattern change swaps the subscription (old await unhooks first)', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ pattern }) => useOnTopic(pattern, handler), {
      initialProps: { pattern: 'app.step.one' },
    });

    rerender({ pattern: 'app.step.two' });
    EventBus.emit('app.step.one', 't');
    expect(handler).not.toHaveBeenCalled();
    EventBus.emit('app.step.two', 't');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('latest handler fires without resubscribing per render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ h }) => useOnTopic('a.b', h), { initialProps: { h: first } });

    rerender({ h: second });
    EventBus.emit('a.b', 't');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1); // one delivery, latest closure
  });

  it('target filter change re-keys the subscription', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ target }) => useOnTopic('app.entity.created', handler, { target }), {
      initialProps: { target: 'agent:*' },
    });

    EventBus.emit('app.entity.created', 'artifact:1');
    expect(handler).not.toHaveBeenCalled();

    rerender({ target: 'artifact:*' });
    EventBus.emit('app.entity.created', 'artifact:1');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
