/**
 * A hub project offered after sign-in (`Project.newFromHub`) whose name is already
 * a project here could not be mirrored — the sweep used to answer 500 and offer
 * nothing at all. It is offered with the choice instead: open the project that
 * holds the name, or set the shared one up under another (`Project.installFromHub`).
 *
 * Real `IncomingProjectDialog`. Stand-ins are the boundaries: dock navigation, the
 * landing, the backend call, and the set-up hooks this branch never runs.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openDock: vi.fn(), land: vi.fn() }));

vi.mock('@src/components/agent-layout/agent-layout', () => ({ useAgentContext: () => ({ computeNode: null }) }));
vi.mock('@src/components/project-selector', () => ({
  useCloneGitProjectAndOpen: () => vi.fn(),
  useInstallSharedProjectAndOpen: () => vi.fn(),
}));
vi.mock('@src/components/project-selector/use-ensure-project', () => ({ useSelectExistingProject: () => h.land }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

import { Project } from '@sdk';
import { IncomingProjectDialog } from '@src/components/task-receive/IncomingProjectDialog';

const ORIGIN = {
  owner: 'acme',
  name: 'course',
  url: 'https://github.com/acme/course.git',
  branch: 'main',
  rel_path: '',
};
const SHARED = '11111111-1111-4111-8111-111111111111';
const MINE = '22222222-2222-4222-8222-222222222222';

const nameTaken = (attempted: string, suggested: string) =>
  Object.assign(new Error('Request failed with status code 409'), {
    response: {
      status: 409,
      data: {
        status: 'FAIL',
        message: `you already have a project named '${attempted}'`,
        data: {
          project_name_conflict: true,
          attempted_name: attempted,
          suggested_name: suggested,
          existing_project_id: MINE,
        },
      },
    },
  });

function renderDialog(onClose = vi.fn()) {
  render(
    <IncomingProjectDialog
      open
      gitOrigin={ORIGIN as never}
      projectName="course"
      senderName="Dana"
      projectId={SHARED}
      nameTaken={{ existingProjectId: MINE, suggestedName: 'course-2' }}
      onClose={onClose}
    />,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  h.openDock.mockReset();
  h.land.mockReset();
  vi.restoreAllMocks();
});

describe('a shared project whose name is already a project here', () => {
  it('opens on the choice, not on set-up', () => {
    renderDialog();

    expect(screen.getByText(/You already have a project named/)).toBeTruthy();
    expect(screen.getByDisplayValue('course-2')).toBe(screen.getByTestId('incoming-project-new-name'));
    expect(screen.queryByTestId('incoming-project-install')).toBeNull();
  });

  it('Open my project lands in the project that holds the name', () => {
    const onClose = renderDialog();

    fireEvent.click(screen.getByTestId('incoming-project-open-existing'));

    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${MINE}`);
    expect(onClose).toHaveBeenCalled();
  });

  it('Set up as this name installs the shared project under it, then lands there', async () => {
    const installed = new Project({ id: SHARED, name: 'course (shared)' } as Partial<Project>);
    const install = vi.spyOn(Project, 'installFromHub').mockResolvedValue(installed);
    renderDialog();

    fireEvent.change(screen.getByTestId('incoming-project-new-name'), { target: { value: 'course (shared)' } });
    fireEvent.click(screen.getByTestId('incoming-project-install-as-name'));

    await waitFor(() => expect(h.land).toHaveBeenCalledWith(installed));
    expect(install).toHaveBeenCalledWith(SHARED, 'course (shared)');
  });

  it('a name taken too asks again, with the next free one', async () => {
    vi.spyOn(Project, 'installFromHub').mockRejectedValue(nameTaken('course-2', 'course-3'));
    renderDialog();

    fireEvent.click(screen.getByTestId('incoming-project-install-as-name'));

    await waitFor(() => expect(screen.getByText(/is taken too/)).toBeTruthy());
    expect(screen.getByDisplayValue('course-3')).toBe(screen.getByTestId('incoming-project-new-name'));
    expect(h.land).not.toHaveBeenCalled();
  });
});
