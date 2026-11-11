/**
 * A project shared while the recipient had no FlowPad reaches no push and no
 * deep link. Once a session is signed in, `IncomingDeepLink` asks the backend
 * for the hub projects this desktop has never seen (`Project.newFromHub`) and
 * announces each in a toast — it never opens the set-up dialog on its own.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cloudUser: null as { id: string } | null,
  info: vi.fn(),
}));

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ cloudUser: h.cloudUser }),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/notifications/notify', () => ({ notify: { info: h.info, error: vi.fn(), warning: vi.fn() } }));
vi.mock('@src/components/task-receive/IncomingProjectDialog', () => ({ IncomingProjectDialog: () => null }));
vi.mock('@src/components/task-receive/LaunchDialog', () => ({ LaunchDialog: () => null }));

import { dataContext, Project, RuntimeKind } from '@sdk';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';

const ORIGIN = JSON.stringify({
  owner: 'acme',
  name: 'course',
  url: 'https://github.com/acme/course.git',
  rel_path: '',
});
const link = (id: string, title: string, sender_name?: string) => ({
  project_id: id,
  git_origin: ORIGIN,
  title,
  sender_name,
});
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const pending = () => useIncomingProjectStore.getState().pendingProject;

describe('IncomingDeepLink — hub projects this desktop never saw', () => {
  beforeEach(() => {
    h.cloudUser = { id: 'user-1' };
    h.info.mockReset();
    useIncomingProjectStore.setState({ pendingProject: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    dataContext.bootstrapInfo = null as never;
  });

  it.each([RuntimeKind.HUB, RuntimeKind.AGENT])('asks nothing on %s', async (kind) => {
    dataContext.bootstrapInfo = { runtime: { kind } } as never;
    const newFromHub = vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A')]);
    render(<IncomingDeepLink />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(newFromHub).not.toHaveBeenCalled();
  });

  it('toasts each new project and never pops the set-up dialog', async () => {
    vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A', 'Gadi'), link(B, 'Course B')]);
    vi.spyOn(Project, 'getById').mockResolvedValue(null);

    render(<IncomingDeepLink />);

    await vi.waitFor(() => expect(h.info).toHaveBeenCalledTimes(2));
    expect(h.info.mock.calls[0][0]).toMatchObject({ title: 'Gadi shared Course A with you' });
    expect(h.info.mock.calls[1][0]).toMatchObject({ title: 'Course B was shared with you' });
    expect(pending()).toBeNull();
  });

  it('a project already set up here is not announced', async () => {
    vi.spyOn(Project, 'newFromHub').mockResolvedValue([link(A, 'Course A'), link(B, 'Course B')]);
    vi.spyOn(Project, 'getById').mockImplementation((id: string) =>
      Promise.resolve(id === A ? (new Project({ id: A, name: 'a', fs_storage_mount_path: '/w/a' }) as never) : null),
    );
    render(<IncomingDeepLink />);
    await vi.waitFor(() => expect(h.info).toHaveBeenCalledTimes(1));
    expect(h.info.mock.calls[0][0].title).toContain('Course B');
  });
});
