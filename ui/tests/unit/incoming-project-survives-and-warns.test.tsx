/**
 * A shared project's set-up dialog, offered after sign-in, met the first-run
 * setup wizard: the wizard opened over it, the click into the wizard counted as
 * a click outside, and the dialog closed unseen — the project was never set up
 * and nothing said so. Two guarantees:
 *   - the dialog closes only through its own buttons;
 *   - a shared project with no files here is a footer warning that reopens its set-up.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ projects: [] as unknown[] }));

vi.mock('@src/components/agent-layout/agent-layout', () => ({ useAgentContext: () => ({ computeNode: null }) }));
vi.mock('@src/components/project-selector', () => ({
  useCloneGitProjectAndOpen: () => vi.fn(),
  useInstallSharedProjectAndOpen: () => vi.fn(),
}));
vi.mock('@src/hooks/use-projects', () => ({ useProjects: () => ({ projects: h.projects }) }));

import { IncomingProjectDialog } from '@src/components/task-receive/IncomingProjectDialog';
import { useSharedProjectWarnings } from '@src/components/task-receive/use-shared-project-warnings';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';

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

describe('a shared project not set up here is a warning', () => {
  beforeEach(() => useIncomingProjectStore.setState({ pendingProject: null }));

  it('one per file-less shared project — and its click reopens the set-up', () => {
    h.projects = [project(A)];

    const { result } = renderHook(() => useSharedProjectWarnings());

    expect(result.current).toHaveLength(1);
    expect(result.current[0].message).toContain('Course 1');
    act(() => result.current[0].onClick?.());
    expect(useIncomingProjectStore.getState().pendingProject).toMatchObject({ projectId: A, projectName: 'Course 1' });
  });

  it('none for a project set up here, an app-managed one, one with no origin, or the one on screen', () => {
    h.projects = [
      project(A, { fs_storage_mount_path: '/Users/me/course' }),
      project(B, { hidden: true }),
      project('33333333-3333-4333-8333-333333333333', { origin: null }),
      project('44444444-4444-4444-8444-444444444444'),
    ];
    useIncomingProjectStore.setState({
      pendingProject: {
        gitOrigin: ORIGIN as never,
        projectName: 'x',
        senderName: 'y',
        projectId: '44444444-4444-4444-8444-444444444444',
      },
    });

    const { result } = renderHook(() => useSharedProjectWarnings());

    expect(result.current).toEqual([]);
  });
});
