/**
 * A project shared while the recipient had no FlowPad reaches no push and no
 * deep link: installing FlowPad from the invite opened it on its home. Once a
 * session is signed in, `IncomingDeepLink` asks the backend for the hub projects
 * this desktop has never seen (`Project.newFromHub`) and offers each one's
 * set-up dialog, one at a time.
 *
 * Real `IncomingDeepLink` and the real incoming-project store. Stand-ins are the
 * boundaries: the signed-in user, the backend call, dock navigation, and the
 * dialog itself (its set-up flow is covered elsewhere).
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cloudUser: null as { id: string } | null }));

vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ cloudUser: h.cloudUser }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/components/task-receive/IncomingProjectDialog', () => ({ IncomingProjectDialog: () => null }));

import { Project } from '@sdk';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';

const ORIGIN = JSON.stringify({
  owner: 'acme',
  name: 'course',
  url: 'https://github.com/acme/course.git',
  rel_path: '',
});
const link = (id: string, title: string) => ({ project_id: id, git_origin: ORIGIN, title });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const pending = () => useIncomingProjectStore.getState().pendingProject;
const dismiss = () => act(() => useIncomingProjectStore.getState().setPendingProject(null));

describe('IncomingDeepLink — hub projects this desktop never saw', () => {
  beforeEach(() => {
    h.cloudUser = { id: 'user-1' };
    useIncomingProjectStore.setState({ pendingProject: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers each new project set-up, one dialog at a time', async () => {
    const newFromHub = vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A'), link(B, 'Course B')]);
    vi.spyOn(Project, 'getById').mockResolvedValue(null);

    render(<IncomingDeepLink />);

    await vi.waitFor(() => expect(pending()).toMatchObject({ projectId: A, projectName: 'Course A' }));
    expect(pending()?.gitOrigin).toMatchObject({ owner: 'acme', name: 'course' });
    dismiss();
    await vi.waitFor(() => expect(pending()).toMatchObject({ projectId: B }));
    dismiss();
    expect(pending()).toBeNull();
    expect(newFromHub).toHaveBeenCalledTimes(1);
  });

  it('signed out, asks nothing — and asks once the session signs in', async () => {
    h.cloudUser = null;
    const newFromHub = vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A')]);
    vi.spyOn(Project, 'getById').mockResolvedValue(null);

    const { rerender } = render(<IncomingDeepLink />);
    expect(newFromHub).not.toHaveBeenCalled();

    h.cloudUser = { id: 'user-1' };
    rerender(<IncomingDeepLink />);

    await vi.waitFor(() => expect(pending()).toMatchObject({ projectId: A }));
    expect(newFromHub).toHaveBeenCalledTimes(1);
  });

  it('a project a deep link already offered is not offered again', async () => {
    let answer: (links: ReturnType<typeof link>[]) => void = () => {};
    vi.spyOn(Project, 'newFromHub').mockReturnValue(new Promise((resolve) => (answer = resolve)));
    vi.spyOn(Project, 'getById').mockResolvedValue(null);

    render(<IncomingDeepLink />);
    act(() =>
      useIncomingProjectStore.getState().setPendingProject({
        gitOrigin: { owner: 'acme', name: 'course', url: '', rel_path: '' } as never,
        projectName: 'Course A',
        senderName: 'Dana',
        projectId: A,
      }),
    );
    await act(async () => {
      answer([link(A, 'Course A'), link(B, 'Course B')]);
      await Promise.resolve();
    });
    dismiss();

    await vi.waitFor(() => expect(pending()).toMatchObject({ projectId: B }));
    dismiss();
    expect(pending()).toBeNull();
  });

  it('a project set up here since the list was read — by a launch link — is not offered', async () => {
    vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A'), link(B, 'Course B')]);
    vi.spyOn(Project, 'getById').mockImplementation((id: string) =>
      Promise.resolve(
        id === A ? (new Project({ id: A, name: 'course-a', fs_storage_mount_path: '/w/course-a' }) as never) : null,
      ),
    );

    render(<IncomingDeepLink />);

    await vi.waitFor(() => expect(pending()).toMatchObject({ projectId: B }));
    dismiss();
    expect(pending()).toBeNull();
  });
});
