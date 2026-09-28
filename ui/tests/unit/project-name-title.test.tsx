/**
 * `ProjectNameTitle` — renaming a project from its home.
 *
 * The component only sets `name` and calls `project.save()`; whether the name
 * also reaches the hub is the save path's decision (`remote` → `Hub-Reflect`).
 * What it owns: a no-op rename sends nothing, and a refused rename reverts.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@sdk';

import { ProjectNameTitle } from '@src/components/project-home/ProjectNameTitle';

const mocks = vi.hoisted(() => ({
  refreshByTypeId: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, dataManager: { refreshByTypeId: mocks.refreshByTypeId } };
});

vi.mock('@src/notifications', () => ({
  notify: { error: mocks.error, success: vi.fn(), info: vi.fn() },
}));

function makeProject(save: () => Promise<unknown>) {
  const project = {
    typeId: { type: 'project', id: 'p1', toString: () => 'project:p1' },
    name: 'marketing',
    get displayName() {
      return this.name;
    },
    save: vi.fn(save),
  };
  return project;
}

async function rename(to: string) {
  await userEvent.click(screen.getByTestId('project-name'));
  const input = screen.getByTestId('project-name-input');
  await userEvent.clear(input);
  await userEvent.type(input, `${to}{Enter}`);
}

describe('ProjectNameTitle', () => {
  beforeEach(() => {
    mocks.refreshByTypeId.mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the project name and saves the new one', async () => {
    const project = makeProject(async () => undefined);
    render(<ProjectNameTitle project={project as unknown as Project} />);
    expect(screen.getByTestId('project-name')).toHaveTextContent('marketing');

    await rename('Growth');

    expect(project.save).toHaveBeenCalledTimes(1);
    expect(project.name).toBe('Growth');
  });

  it('sends nothing when the name did not change', async () => {
    const project = makeProject(async () => undefined);
    render(<ProjectNameTitle project={project as unknown as Project} />);

    await rename('marketing');

    expect(project.save).not.toHaveBeenCalled();
  });

  it('reverts and reports a refused rename', async () => {
    const project = makeProject(async () => {
      throw new Error('403: not allowed');
    });
    render(<ProjectNameTitle project={project as unknown as Project} />);

    await rename('Growth');

    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1));
    expect(project.name).toBe('marketing');
    expect(mocks.refreshByTypeId).toHaveBeenCalledWith(project.typeId);
  });
});
