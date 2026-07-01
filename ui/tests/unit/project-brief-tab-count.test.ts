/**
 * Projects-counter chip vs. the project brief: the chip must count only REAL
 * open tabs (terminals/content), never the project-view "brief" host tab that
 * navigating to `DockPointer.forProject` materializes.
 *
 * Bug: `useTabProjectBuckets` buckets tabs KIND-AGNOSTICALLY by `project_id`
 * (useTabs.ts grouped loop), so the visible `project`-target tab minted for the
 * brief (target_type === Project.type) is counted as "1 tab". Result: after the
 * last real tab closes, the terminal-only brief shows "no tabs" while the chip
 * still lists the project with a phantom "1 tab" badge — "being in the list ==
 * you have at least one active tab" is violated.
 *
 * These drive the REAL bucket hook over REAL Tab shapes (as `list_all` returns
 * them), no mocks of the logic under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Project, Shell, Tab, type ITab } from '@sdk';
import { applyAllTabs, getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { useTabProjectBuckets } from '@src/tabs/useTabs';

// The unit tier has no backend, so the store's one-time `refreshAllTabs()` GET
// would 503 and surface as an unhandled rejection. Pin the transport to return
// the seeded snapshot (exactly what `list_all` returns in the real scenario) so
// the REAL bucket logic runs over the REAL data — the boundary being pinned is
// the network fetch, never the bucketization under test.
beforeEach(() => {
  vi.spyOn(Tab, 'listAll').mockImplementation(async () => getAllTabsSnapshot());
});

const PROJECT = '11111111-1111-4111-8111-111111111111';

/** A visible Tab in PROJECT, as `list_all` returns it. The bucket derivation
 *  reads only `project_id` + `target_type`; other fields are stable defaults. */
function tab(id: string, targetType: string): ITab {
  return {
    id,
    pointer: '',
    target_type: targetType,
    target_id: id,
    project_id: PROJECT,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: 0,
    last_active_at: null,
    status: null,
    is_disabled: false,
    visible: true,
  };
}

/** The `project`-view host tab the brief navigation (`forProject`) materializes:
 *  its target IS the project itself (target_type === Project.type). */
const briefHostTab = () => tab('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Project.type);

/** A real terminal session tab (a process started from the brief). */
const terminalTab = () => tab('cccccccc-cccc-4ccc-8ccc-cccccccccccc', Shell.type);

afterEach(() => {
  applyAllTabs([]);
  vi.restoreAllMocks();
});

describe('projects-chip buckets ignore the project-brief host tab', () => {
  it('1. last real tab removed → chip does NOT list the project (only the brief host remains)', () => {
    // End-state after closing the last terminal tab and landing on the brief:
    // the only surviving visible tab for the project is its own brief/landing host.
    applyAllTabs([briefHostTab()]);

    const { result } = renderHook(() => useTabProjectBuckets());

    // The project must not appear in the chip — there is no real tab.
    expect(result.current.buckets.find((b) => b.projectId === PROJECT)).toBeUndefined();
  });

  it('2. process started from the brief → project reappears, counted once (not double with the host)', () => {
    // Store now holds the brief host tab AND the freshly-started process tab.
    applyAllTabs([briefHostTab(), terminalTab()]);

    const { result } = renderHook(() => useTabProjectBuckets());
    const bucket = result.current.buckets.find((b) => b.projectId === PROJECT);

    // The chip re-earns its slot because of the REAL process...
    expect(bucket).toBeDefined();
    // ...and counts only that process — the brief host is not a tab.
    expect(bucket?.tabCount).toBe(1);
  });
});
