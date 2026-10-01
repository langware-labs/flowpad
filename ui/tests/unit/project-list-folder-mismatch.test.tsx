/**
 * A project renamed away from its folder shows the folder's name as a chip on its
 * row. A rename changes the name, never the folder (the path keys sessions, records
 * and discovery), so the backend publishes `folder_name_mismatch` and the list only
 * reads it — no second copy of the comparison here.
 */
import { ProjectListPopoverContent, useProjectListMenu } from '@src/components/terminal/project-list-menu';
import type { TabProjectBucket } from '@src/tabs/use-tab-manager';
import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock: vi.fn(), closeDock: vi.fn() } }),
}));
vi.mock('@src/tabs/project-entry', () => ({
  dockForGlobalEntry: vi.fn(() => Promise.resolve('GLOBAL_DOCK')),
  dockForProjectEntry: vi.fn(async () => 'PROJECT_DOCK'),
  globalHomeDock: () => 'GLOBAL_HOME',
  leaveProjectScope: vi.fn(async () => 'GLOBAL_DOCK'),
}));

let buckets: TabProjectBucket[] = [];
vi.mock('@src/tabs/use-tab-manager', () => ({
  useTabProjectBuckets: () => ({ buckets, globalTabCount: 0, closeGlobal: vi.fn() }),
}));

function bucket(projectId: string, name: string, folderNameMismatch: string | null): TabProjectBucket {
  return {
    projectId,
    project: {
      id: projectId,
      displayName: name,
      system: false,
      folderNameMismatch,
    } as unknown as TabProjectBucket['project'],
    state: 'live',
    tabCount: 1,
    recover: () => Promise.resolve(null),
    closeAll: async () => {},
  };
}

describe('project row folder-mismatch chip', () => {
  it('names the folder on a renamed project, and stays off a matching one', () => {
    buckets = [bucket('p1', 'gtm-studio', 'marketing'), bucket('p2', 'waha', null)];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: 'p1' }));
    render(<ProjectListPopoverContent menu={result.current} />);

    const chip = screen.getByTestId('project-folder-mismatch-p1');
    expect(chip.textContent).toBe('marketing');
    expect(chip.getAttribute('title')).toContain('marketing');
    expect(screen.queryByTestId('project-folder-mismatch-p2')).toBeNull();
  });
});
