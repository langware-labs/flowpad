/**
 * useFSRefContent `reloadKey` (edge-4 body re-read) + dirty-guard.
 *
 * reloadKey is fed the backing entity's `updated_date`; when a reindex advances
 * it, the body must re-read from disk — UNLESS the buffer is dirty, in which
 * case the user's unsaved edits win. A path change or explicit reload() always
 * reloads regardless of dirty.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useFSRefContent, type FsRef } from '@src/hooks/use-fs-ref-content';

/** In-memory FsRef whose read() returns the current `disk` value. */
function makeRef(path: string, initial: string) {
  const state = { path, disk: initial };
  const ref: FsRef = {
    path,
    read: vi.fn(async () => state.disk),
    write: vi.fn(async (c: string) => { state.disk = c; }),
    exists: vi.fn(async () => true),
  };
  return { ref, state };
}

describe('useFSRefContent reloadKey', () => {
  it('re-reads the body when reloadKey changes (clean buffer)', async () => {
    const { ref, state } = makeRef('/tmp/a.md', 'v1');
    const { result, rerender } = renderHook(
      ({ key }) => useFSRefContent(ref, { autoSave: false, reloadKey: key }),
      { initialProps: { key: 1 } },
    );
    await waitFor(() => expect(result.current.content).toBe('v1'));

    // Disk changed out-of-band, then the entity's updated_date advanced.
    state.disk = 'v2';
    rerender({ key: 2 });
    await waitFor(() => expect(result.current.content).toBe('v2'));
  });

  it('does NOT clobber unsaved edits on a reloadKey change (dirty guard)', async () => {
    const { ref, state } = makeRef('/tmp/b.md', 'v1');
    const { result, rerender } = renderHook(
      ({ key }) => useFSRefContent(ref, { autoSave: false, reloadKey: key }),
      { initialProps: { key: 1 } },
    );
    await waitFor(() => expect(result.current.content).toBe('v1'));

    // User types — buffer is now dirty.
    act(() => result.current.setContent('my unsaved edits'));
    await waitFor(() => expect(result.current.dirty).toBe(true));

    // External change lands while dirty — must be ignored.
    state.disk = 'v2-external';
    rerender({ key: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.content).toBe('my unsaved edits');
    expect(result.current.dirty).toBe(true);
  });

  it('reload() reloads even when dirty (explicit discard)', async () => {
    const { ref, state } = makeRef('/tmp/c.md', 'v1');
    const { result } = renderHook(() => useFSRefContent(ref, { autoSave: false, reloadKey: 1 }));
    await waitFor(() => expect(result.current.content).toBe('v1'));

    act(() => result.current.setContent('dirty'));
    await waitFor(() => expect(result.current.dirty).toBe(true));

    state.disk = 'v2';
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.content).toBe('v2'));
  });
});
