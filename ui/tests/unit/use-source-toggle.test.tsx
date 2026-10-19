/**
 * The one pause/resume verb every surface shares. Pins the asymmetry the
 * backend relies on: pausing is `disabled`, but resuming is `new` — never
 * `active` — so a source paused mid-setup gets its setup step back.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { notify } from '@src/notifications';
import { useSourceToggle } from '@src/components/data-sources/use-source-toggle';
import type { DataSource } from '@sdk';

function fakeSource(status: string, save = vi.fn(async () => undefined)) {
  return {
    status,
    name: 'Team Slack',
    provider: 'slack',
    get isActive() {
      return this.status === 'active';
    },
    get needsSetup() {
      return this.status === 'setup';
    },
    save,
    markEdit: vi.fn(),
  } as unknown as DataSource & { save: typeof save; markEdit: ReturnType<typeof vi.fn> };
}

describe('useSourceToggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['active', 'disabled'],
    ['setup', 'disabled'],
    ['disabled', 'new'],
  ])('%s → %s, saved then marked edited', async (from, to) => {
    const source = fakeSource(from);
    const { result } = renderHook(() => useSourceToggle(source));
    await act(() => result.current.toggle());
    expect(source.status).toBe(to);
    expect(source.save).toHaveBeenCalledTimes(1);
    expect(source.markEdit).toHaveBeenCalledTimes(1);
    expect(notify.success).toHaveBeenCalledTimes(1);
  });

  it('rolls the status back when the save fails', async () => {
    const source = fakeSource('active', vi.fn(async () => { throw new Error('offline'); }));
    const { result } = renderHook(() => useSourceToggle(source));
    await act(() => result.current.toggle());
    expect(source.status).toBe('active');
    expect(source.markEdit).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });
});
