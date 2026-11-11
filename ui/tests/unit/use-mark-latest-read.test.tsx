import { renderHook } from '@testing-library/react';
import { SenderKind, type FlowMessage } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateMessage = vi.fn(() => Promise.resolve());
vi.mock('@src/components/stream-inbox-view/stream-inbox-api', () => ({ updateMessage }));

const { useMarkLatestRead } = await import('@src/components/conversation/useMarkLatestRead');

function message(id: string, senderId: string, is_read = false): FlowMessage {
  return { id, is_read, sender: { kind: SenderKind.User, id: senderId } } as unknown as FlowMessage;
}

describe('useMarkLatestRead', () => {
  beforeEach(() => {
    updateMessage.mockClear();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('marks a received latest message read, once', () => {
    const { rerender } = renderHook(({ m }) => useMarkLatestRead(m, 'me-cloud', 'me-local'), {
      initialProps: { m: message('m1', 'ami') },
    });
    rerender({ m: message('m1', 'ami') });
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledWith('m1', { is_read: true }, undefined);
  });

  it('leaves our own, already-read and backgrounded messages alone', () => {
    renderHook(() => useMarkLatestRead(message('m2', 'me-cloud'), 'me-cloud', 'me-local'));
    renderHook(() => useMarkLatestRead(message('m3', 'ami', true), 'me-cloud', 'me-local'));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderHook(() => useMarkLatestRead(message('m4', 'ami'), 'me-cloud', 'me-local'));
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('marks a new latest reply as it arrives', () => {
    const { rerender } = renderHook(({ m }) => useMarkLatestRead(m, 'me-cloud', 'me-local'), {
      initialProps: { m: message('r1', 'ami') },
    });
    rerender({ m: message('r2', 'ami') });
    expect(updateMessage.mock.calls.map((c) => c[0])).toEqual(['r1', 'r2']);
  });
});
