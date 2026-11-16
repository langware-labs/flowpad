/**
 * The one pause/resume verb every surface shares. The switch only says on or off
 * (`setEnabled`); where a resumed source lands is the backend's answer, which the row takes.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { notify } from '@src/notifications';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import type { DataSource } from '@sdk';

/** A source whose `setEnabled` lands where `lands` says, as the SDK's does with the backend's answer. */
function fakeSource(status: string, lands?: { status: string; setup_detail?: string } | Error) {
  const source = {
    status,
    setup_detail: '',
    name: 'Team Slack',
    provider: 'slack',
    get isActive() {
      return this.status === 'active';
    },
    get needsSetup() {
      return this.status === 'setup';
    },
    setEnabled: vi.fn(async (on: boolean) => {
      if (lands instanceof Error) throw lands;
      Object.assign(source, lands ?? { status: on ? 'active' : 'disabled' });
    }),
    markEdit: vi.fn(),
  };
  return source as unknown as DataSource & Pick<typeof source, 'setEnabled' | 'markEdit'>;
}

describe('useSourceToggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['active', false, 'disabled'],
    ['setup', false, 'disabled'],
    ['disabled', true, 'active'],
  ])('%s: asks enabled=%s and lands on %s', async (from, enabled, to) => {
    const source = fakeSource(from);
    const { result } = renderHook(() => useSourceToggle(source));
    await act(() => result.current.toggle());
    expect(source.status).toBe(to);
    expect(source.setEnabled).toHaveBeenCalledWith(enabled);
    expect(source.markEdit).toHaveBeenCalledTimes(1);
    expect(notify.success).toHaveBeenCalledTimes(1);
  });

  it('a resumed source that still owes its setup reads as setup in the words the backend gave, and is not announced as resumed', async () => {
    const source = fakeSource('disabled', { status: 'setup', setup_detail: 'Invite the bot.' });
    const { result } = renderHook(() => useSourceToggle(source));
    await act(() => result.current.toggle());
    expect([source.status, source.setup_detail]).toEqual(['setup', 'Invite the bot.']);
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('a failed call leaves the row as it was', async () => {
    const source = fakeSource('active', new Error('offline'));
    const { result } = renderHook(() => useSourceToggle(source));
    await act(() => result.current.toggle());
    expect(source.status).toBe('active');
    expect(source.markEdit).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });
});
