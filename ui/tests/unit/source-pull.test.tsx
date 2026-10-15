/**
 * A person's Pull reads the source NOW and says what it found — one answer for every source family, read off the
 * generic report only (no provider, no family): counts, "Up to date", or why it did not run.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SyncReport } from '@sdk';
import { pullNow, pullSummary, useSourcePull } from '@src/components/data-sources/source-parts';
import { fakeSource } from './fake-source';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
import { notify } from '@src/notifications';

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  ran: true, created: 0, updated: 0, unchanged: 0, removed: 0, health: 'ok', status: 'active', ...over,
});

describe('pullSummary', () => {
  it('counts what changed — new, updated, removed — whatever the family', () => {
    expect(pullSummary(report({ created: 2, updated: 1 }))).toEqual({ ok: true, text: '2 new · 1 updated' });
    expect(pullSummary(report({ removed: 3 }))).toEqual({ ok: true, text: '3 removed' });
  });
  it('says "Up to date" when nothing changed', () => {
    expect(pullSummary(report({ unchanged: 5 }))).toEqual({ ok: true, text: 'Up to date' });
  });
  it("says why a source was not read, in the source's own sentence", () => {
    expect(pullSummary(report({ ran: false, status: 'setup', detail: 'Needs GitHub sign-in' }))).toEqual({
      ok: false, text: 'Needs GitHub sign-in',
    });
  });
  it('reports a failed cycle with its error', () => {
    expect(pullSummary(report({ health: 'config_error', error_detail: 'token refused' }))).toEqual({
      ok: false, text: 'token refused',
    });
  });
});

describe('pullNow / useSourcePull', () => {
  it('runs a cycle now (syncNow), never just queues one (pollNow)', async () => {
    const source = fakeSource('s', 'github_pr', { status: 'active' });
    const sync = vi.spyOn(source, 'syncNow').mockResolvedValue(report({ created: 1 }));
    const poll = vi.spyOn(source, 'pollNow');
    expect(await pullNow(source)).toEqual({ ok: true, text: '1 new' });
    expect([sync.mock.calls.length, poll.mock.calls.length]).toEqual([1, 0]);
  });
  it('a thrown request is an answer, not an exception', async () => {
    const source = fakeSource('s', 'github_pr', { status: 'active' });
    vi.spyOn(source, 'syncNow').mockRejectedValue(new Error('offline'));
    expect(await pullNow(source)).toEqual({ ok: false, text: 'offline' });
  });
  it('holds `pulling` for the whole cycle and toasts the result', async () => {
    const source = fakeSource('s', 'github_pr', { status: 'active' });
    let finish!: (r: SyncReport) => void;
    vi.spyOn(source, 'syncNow').mockReturnValue(new Promise((r) => (finish = r)));
    const { result } = renderHook(() => useSourcePull(source));
    let running!: Promise<void>;
    act(() => {
      running = result.current.pull();
    });
    expect(result.current.pulling).toBe(true);
    await act(async () => {
      finish(report({ created: 2 }));
      await running;
    });
    expect(result.current.pulling).toBe(false);
    expect(notify.success).toHaveBeenCalledWith(expect.objectContaining({ message: '2 new' }));
  });
});
