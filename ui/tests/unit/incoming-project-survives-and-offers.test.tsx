/**
 * A shared project's set-up dialog, offered after sign-in, met the first-run
 * setup wizard: the wizard opened over it, the click into the wizard counted as
 * a click outside, and the dialog closed unseen — the project was never set up
 * and nothing said so. Two guarantees:
 *   - the dialog closes only through its own buttons;
 *   - a shared project with no files here is not a warning: opening it offers its
 *     set-up, and the nav bar's glowing key reopens it.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ projects: [] as unknown[], current: null as { id: string } | null }));

vi.mock('@src/components/agent-layout/agent-layout', () => ({ useAgentContext: () => ({ computeNode: null }) }));
vi.mock('@src/components/project-selector', () => ({
  useCloneGitProjectAndOpen: () => vi.fn(),
  useInstallSharedProjectAndOpen: () => vi.fn(),
}));
vi.mock('@src/components/project-selector/use-ensure-project', () => ({ useSelectExistingProject: () => vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/hooks/use-projects', () => ({ useProjects: () => ({ projects: h.projects }) }));
vi.mock('@sdk/react/hooks/useContext', () => ({ useContext: () => ({ project: h.current }) }));

import { IncomingProjectDialog } from '@src/components/task-receive/IncomingProjectDialog';
import {
  useOfferSharedProjectSetUpOnOpen,
  useSharedProjectSetUp,
} from '@src/components/task-receive/use-shared-project-set-up';
import { ProjectSetupButton } from '@src/components/top-nav-bar/ProjectSetupButton';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { declineSetup, useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { dataContext, RuntimeKind } from '@sdk';

const ORIGIN = {
  owner: 'acme',
  name: 'course',
  url: 'https://github.com/acme/course.git',
  branch: 'main',
  rel_path: '',
};
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Course ${id[0]}`,
  fs_storage_mount_path: null,
  hidden: false,
  origin: ORIGIN,
  ...over,
});

afterEach(() => cleanup());

describe('the shared-project set-up dialog', () => {
  it('stays open when another dialog takes the clicks and the focus', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">the wizard over it</button>
        <IncomingProjectDialog
          open
          gitOrigin={ORIGIN as never}
          projectName="Course"
          senderName="Dana"
          projectId={A}
          onClose={onClose}
        />
      </>,
    );
    const wizard = screen.getByText('the wizard over it');
    // Radix arms its outside-click listener a tick after the dialog mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    fireEvent.pointerDown(wizard);
    fireEvent.focusIn(wizard);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('incoming-project-dialog')).toBeTruthy();
  });

  it('closes through its own Cancel', () => {
    const onClose = vi.fn();
    render(
      <IncomingProjectDialog
        open
        gitOrigin={ORIGIN as never}
        projectName="Course"
        senderName="Dana"
        projectId={A}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a shared project not set up here', () => {
  const C = '33333333-3333-4333-8333-333333333333';
  const D = '44444444-4444-4444-8444-444444444444';
  const pending = () => useIncomingProjectStore.getState().pendingProject;

  beforeEach(() => {
    useIncomingProjectStore.setState({ pendingProject: null });
    window.localStorage.clear();
    h.current = null;
  });

  it('has a set-up — none once set up here, app-managed, or with no origin', () => {
    h.projects = [
      project(A),
      project(B, { fs_storage_mount_path: '/Users/me/course' }),
      project(C, { hidden: true }),
      project(D, { origin: null }),
    ];
    const setUpOf = (id: string) => renderHook(() => useSharedProjectSetUp(id)).result.current;

    expect(setUpOf(A)).toMatchObject({ projectId: A, projectName: 'Course 1' });
    expect([B, C, D].map(setUpOf)).toEqual([null, null, null]);
  });

  it('opening it offers its set-up — again on each visit, not again while it stays open', () => {
    h.projects = [project(A), project(B, { fs_storage_mount_path: '/Users/me/other' })];
    h.current = { id: A };
    const { rerender } = renderHook(() => useOfferSharedProjectSetUpOnOpen());
    expect(pending()).toMatchObject({ projectId: A, projectName: 'Course 1' });

    act(() => useIncomingProjectStore.setState({ pendingProject: null }));
    rerender();
    expect(pending()).toBeNull();

    h.current = { id: B };
    rerender();
    h.current = { id: A };
    rerender();
    expect(pending()).toMatchObject({ projectId: A });
  });

  it('is not offered after "Don\'t ask me again", nor over another set-up', () => {
    h.projects = [project(A), project(C)];
    declineSetup(A);
    h.current = { id: A };
    const { rerender } = renderHook(() => useOfferSharedProjectSetUpOnOpen());
    expect(pending()).toBeNull();

    const other = { gitOrigin: ORIGIN as never, projectName: 'x', projectId: D };
    act(() => useIncomingProjectStore.setState({ pendingProject: other }));
    h.current = { id: C };
    rerender();
    expect(pending()).toBe(other);
  });

  it('lights the glowing key, whose click opens its set-up', () => {
    h.projects = [project(A)];
    render(
      <TooltipProvider>
        <ProjectSetupButton project={{ id: A, name: 'Course 1' } as never} />
      </TooltipProvider>,
    );
    const key = screen.getByTestId('top-nav-project-setup');
    expect(key).toHaveClass('animate-setup-glow');

    fireEvent.click(key);

    expect(pending()).toMatchObject({ projectId: A });
  });

  describe('only where a project can be set up', () => {
    afterEach(() => {
      dataContext.bootstrapInfo = null as never;
    });
    const asRuntime = (kind: RuntimeKind) => {
      dataContext.bootstrapInfo = { runtime: { kind } } as never;
    };

    it.each([RuntimeKind.HUB, RuntimeKind.AGENT])('none on %s — no disk or nobody at it', (kind) => {
      asRuntime(kind);
      h.projects = [project(A)];

      expect(renderHook(() => useSharedProjectSetUp(A)).result.current).toBeNull();
    });

    it.each([RuntimeKind.DESKTOP, RuntimeKind.BROWSER, RuntimeKind.SANDBOX])('offered on %s', (kind) => {
      asRuntime(kind);
      h.projects = [project(A)];

      expect(renderHook(() => useSharedProjectSetUp(A)).result.current).not.toBeNull();
    });
  });
});
