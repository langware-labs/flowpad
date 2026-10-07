/**
 * A member whose only access is a project shared with them has no compute node,
 * and the picker listed "projects discovered on a compute node" — so the hub held
 * the project and the picker said "No projects found". On a hub-only server the
 * picker now lists the projects the hub lists for the signed-in user, and opening
 * one is a navigation to its page on the hub (a hub project has no folder).
 *
 * Real `OpenProjectComponent`, real mapper. Stand-ins are the boundaries: the
 * runtime, the hub's project list, the machine scan, the opener hook and dock
 * navigation.
 */
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hub: true,
  hubProjects: [] as unknown[],
  scanned: [] as unknown[],
  openDock: vi.fn(),
  useAllProjectsArgs: vi.fn(),
  useProjectsArgs: vi.fn(),
}));

vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hub }));
vi.mock('@sdk', async (orig) => ({ ...(await orig<object>()), isHubOnly: () => h.hub }));
vi.mock('@src/hooks/use-projects', () => ({
  useProjects: (opts: unknown) => {
    h.useProjectsArgs(opts);
    return { projects: h.hubProjects, isLoading: false };
  },
}));
vi.mock('@src/hooks/use-all-projects', () => ({
  useAllProjects: (opts: unknown) => {
    h.useAllProjectsArgs(opts);
    return { projects: h.scanned, isLoading: false };
  },
}));
vi.mock('@src/hooks/use-preference', () => ({ usePreference: () => [false] }));
vi.mock('@src/tabs/use-tab-manager', () => ({ useTabProjectBuckets: () => ({ buckets: [] }) }));
vi.mock('@sdk/react/hooks', () => ({ useProject: () => ({ data: null }) }));
vi.mock('@src/navigation/useDockNavigation', async (orig) => ({
  ...(await orig<object>()),
  useDockNavigation: () => ({ navigation: { openDock: h.openDock, openLens: vi.fn() }, currentDock: null }),
  useIsHomeSurface: () => false,
}));
vi.mock('@src/components/open-project-component/use-open-project', () => ({
  normalizePath: (p: string) => p,
  useProjectOpener: () => ({
    computeNode: null,
    ensureProjectAndSetContext: vi.fn(),
    pickFolder: vi.fn(),
  }),
}));

import OpenProjectComponent from '@src/components/open-project-component/open-project-component';
import { hubProjectListItems } from '@src/components/open-project-component/hub-project-list';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const A = '269b8338-cc1f-43c2-a656-2be892e5a6a0';
const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'ai-course-lesson-1',
  hidden: false,
  updated_date: '2026-10-05T12:35:21Z',
  ...over,
});

describe('hubProjectListItems', () => {
  it('maps a hub project to a folder-less picker row', () => {
    expect(hubProjectListItems([project(A) as never], false)).toEqual([
      expect.objectContaining({ id: A, name: 'ai-course-lesson-1', cwd: null, session_count: 0 }),
    ]);
  });

  it('keeps app-managed projects out unless asked', () => {
    const rows = [project(A), project('other', { hidden: true })] as never[];
    expect(hubProjectListItems(rows, false).map((r) => r.id)).toEqual([A]);
    expect(hubProjectListItems(rows, true).map((r) => r.id)).toEqual([A, 'other']);
  });

  it('is empty before the list loads', () => {
    expect(hubProjectListItems(undefined, false)).toEqual([]);
  });
});

describe('the project picker on a hub-only server', () => {
  beforeEach(() => {
    h.hub = true;
    h.hubProjects = [project(A)];
    h.scanned = [];
    h.openDock.mockReset();
    h.useAllProjectsArgs.mockReset();
    h.useProjectsArgs.mockReset();
  });
  afterEach(() => cleanup());

  it('lists the project the hub returns even with no compute node', () => {
    render(<OpenProjectComponent open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId(`switch-project-row-${A}`)).toBeTruthy();
    expect(screen.queryByText('No projects found')).toBeNull();
  });

  it('opens a project by navigating to its page on the hub', () => {
    const onOpenChange = vi.fn();
    const onProjectChanged = vi.fn();
    render(<OpenProjectComponent open onOpenChange={onOpenChange} onProjectChanged={onProjectChanged} />);

    fireEvent.click(screen.getByTestId(`switch-project-row-${A}`));

    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${A}`);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain('/hub/');
    expect(onProjectChanged).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not run the machine scan', () => {
    render(<OpenProjectComponent open onOpenChange={vi.fn()} />);

    expect(h.useAllProjectsArgs).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(h.useProjectsArgs).toHaveBeenCalledWith({ enabled: true });
  });

  it('still says "No projects found" when the hub lists none', () => {
    h.hubProjects = [];

    render(<OpenProjectComponent open onOpenChange={vi.fn()} />);

    expect(screen.getByText('No projects found')).toBeTruthy();
  });
});

describe('the project picker on the desktop', () => {
  beforeEach(() => {
    h.hub = false;
    h.hubProjects = [project(A)];
    h.scanned = [];
    h.useAllProjectsArgs.mockReset();
    h.useProjectsArgs.mockReset();
  });
  afterEach(() => cleanup());

  it('keeps reading the machine scan and ignores the hub list', () => {
    render(<OpenProjectComponent open onOpenChange={vi.fn()} />);

    expect(h.useAllProjectsArgs).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(h.useProjectsArgs).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByTestId(`switch-project-row-${A}`)).toBeNull();
  });
});
