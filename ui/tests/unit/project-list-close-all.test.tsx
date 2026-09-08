/**
 * The project row's close-all (the X beside every project in the chip menu).
 *
 * Closing a project's tabs is the ONLY thing that removes its row: the menu is
 * built from open tabs (`projectTabCounts` groups on the raw `project_id`), so a
 * project with no tabs simply stops being listed. These tests pin the behaviour
 * that isn't obvious from the markup:
 *   - the close verb reaches the bucket's own `closeAll` (the durable batch path
 *     the strip's "Close all" uses), and leaves other buckets alone;
 *   - clearing the CURRENT scope navigates away BEFORE closing, not after —
 *     closing first strands the URL on a tab that no longer exists;
 *   - clearing a non-current project never navigates;
 *   - a MISSING bucket can be closed. That is its only exit: recovery reads a
 *     `workdir` off a shell/agentic_process dependent, so an orphan that has
 *     none (e.g. a stale conversation tab) can never be recovered, and the row
 *     would otherwise be permanent.
 */
import { useProjectListMenu } from '@src/components/terminal/project-list-menu';
import type { TabProjectBucket } from '@src/tabs/use-tab-manager';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openDock = vi.fn();
const dockForGlobalEntry = vi.fn(async () => 'GLOBAL_DOCK');

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock, closeDock: vi.fn() } }),
}));
vi.mock('@src/tabs/project-entry', () => ({
  dockForGlobalEntry: (...args: unknown[]) => dockForGlobalEntry(...(args as [])),
  dockForProjectEntry: vi.fn(async () => 'PROJECT_DOCK'),
}));

let buckets: TabProjectBucket[] = [];
vi.mock('@src/tabs/use-tab-manager', () => ({
  useTabProjectBuckets: () => ({ buckets, globalTabCount: 0 }),
}));

/** A bucket whose `closeAll` records the order it ran in, against `calls`. */
const calls: string[] = [];
function bucket(projectId: string, state: TabProjectBucket['state'] = 'live'): TabProjectBucket {
  return {
    projectId,
    project:
      state === 'live'
        ? ({ id: projectId, displayName: projectId, system: false } as unknown as TabProjectBucket['project'])
        : null,
    state,
    tabCount: 2,
    recover: () => Promise.resolve(null),
    closeAll: async () => {
      calls.push(`closeAll:${projectId}`);
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  openDock.mockReset();
  openDock.mockImplementation((dock: unknown) => calls.push(`openDock:${String(dock)}`));
  dockForGlobalEntry.mockClear();
});

describe('project row close-all', () => {
  it('closes that project only, and does not navigate when it is not current', async () => {
    buckets = [bucket('p1'), bucket('p2')];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: 'p1' }));

    await act(async () => {
      await result.current.handleCloseProject(result.current.buckets[1]);
    });

    expect(calls).toEqual(['closeAll:p2']);
    expect(openDock).not.toHaveBeenCalled();
  });

  it('navigates away BEFORE closing when clearing the current scope', async () => {
    buckets = [bucket('p1')];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: 'p1' }));

    await act(async () => {
      await result.current.handleCloseProject(result.current.buckets[0]);
    });

    // Order is the assertion: leaving first keeps the destination resolvable
    // from live rows (URL-first); closing first would strand the URL.
    expect(calls).toEqual(['openDock:GLOBAL_DOCK', 'closeAll:p1']);
  });

  it('closes a MISSING bucket — the only exit for an unrecoverable orphan', async () => {
    buckets = [bucket('proj-123', 'missing')];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: null }));

    await act(async () => {
      await result.current.handleCloseProject(result.current.buckets[0]);
    });

    expect(calls).toEqual(['closeAll:proj-123']);
  });

  it('reports the in-flight bucket and clears it when the close settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = bucket('p1');
    slow.closeAll = () => gate;
    buckets = [slow];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: null }));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleCloseProject(result.current.buckets[0]);
    });
    await waitFor(() => expect(result.current.closingId).toBe('p1'));

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.closingId).toBeNull();
  });

  it('surfaces a failed close and still clears the in-flight marker', async () => {
    const failing = bucket('p1');
    failing.closeAll = () => Promise.reject(new Error('backend said no'));
    buckets = [failing];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: null }));

    await act(async () => {
      await result.current.handleCloseProject(result.current.buckets[0]);
    });

    // The close must not leave the row wedged in a permanent spinner.
    expect(result.current.closingId).toBeNull();
  });
});
