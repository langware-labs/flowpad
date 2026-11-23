/**
 * A tool's own working folder (`scratch`: a mockify mock project) has open tabs like
 * any project, but it is not one the user works in — the menu leaves its row out.
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

function bucket(projectId: string, name: string, scratch: boolean): TabProjectBucket {
  return {
    projectId,
    project: { id: projectId, displayName: name, system: false, scratch } as unknown as TabProjectBucket['project'],
    state: 'live',
    tabCount: 1,
    recover: () => Promise.resolve(null),
    closeAll: async () => {},
  };
}

describe('project list and a scratch project', () => {
  it('lists the project the user works in and leaves the scratch one out', () => {
    buckets = [bucket('p1', 'bridge', false), bucket('p2', 'mocks · bridge', true)];
    const { result } = renderHook(() => useProjectListMenu({ currentProjectId: 'p1' }));
    render(<ProjectListPopoverContent menu={result.current} />);

    expect(screen.queryByText('bridge')).not.toBeNull();
    expect(screen.queryByText('mocks · bridge')).toBeNull();
  });
});
