/**
 * The project home's Dependencies card: every declared dependency with where it
 * stands here, Install on an optional one that is not installed, and Remove on
 * the project's own.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { dataManager, Project as SdkProject, type DependencyState, type Project } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { ProjectDependenciesCard } from '@src/components/project-home/ProjectDependenciesCard';

function dep(name: string, extra: Partial<DependencyState> = {}): DependencyState {
  return {
    name,
    source: `git+https://github.com/acme/${name}#main`,
    required: true,
    path: '.',
    state: 'ready',
    local_path: `/w/${name}`,
    reason: null,
    via: null,
    dismissed: false,
    ...extra,
  };
}

const PID = '0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4c';

function makeProject(dependencies: DependencyState[], warnings: DependencyState[] = []) {
  return {
    id: PID,
    include_dirs: [],
    context_dir_infos: [],
    dependencies: vi.fn(() => Promise.resolve({ dependencies, warnings, resolving: false })),
    installDependency: vi.fn((name: string) => Promise.resolve(dep(name))),
    removeDependency: vi.fn(() => Promise.resolve([])),
    resolveDependencies: vi.fn(() => Promise.resolve([])),
  };
}

function renderCard(project: ReturnType<typeof makeProject>) {
  return render(
    <TooltipProvider>
      <ProjectDependenciesCard project={project as unknown as Project} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ProjectDependenciesCard', () => {
  it('renders nothing for a project with no dependencies', async () => {
    const project = makeProject([]);
    renderCard(project);
    await waitFor(() => expect(project.dependencies).toHaveBeenCalled());
    expect(screen.queryByTestId('project-dependencies-card')).toBeNull();
  });

  it('lists each dependency with its state', async () => {
    const project = makeProject([
      dep('docs'),
      dep('specs', { state: 'unreachable', reason: 'Repository not found' }),
      dep('extras', { required: false, state: 'not_installed', local_path: null }),
    ]);
    renderCard(project);

    expect(await screen.findByTestId('project-dependencies-card')).toBeInTheDocument();
    const rows = screen.getAllByTestId('dependency-row');
    expect(rows.map((r) => [r.getAttribute('data-dependency-name'), r.getAttribute('data-state')])).toEqual([
      ['docs', 'ready'],
      ['specs', 'unreachable'],
      ['extras', 'not_installed'],
    ]);
    expect(screen.getByText('1 optional dependency not installed')).toBeInTheDocument();
  });

  it('installs an optional dependency that is not installed, and only that one', async () => {
    const user = userEvent.setup();
    const project = makeProject([
      dep('docs'),
      dep('extras', { required: false, state: 'not_installed', local_path: null }),
    ]);
    renderCard(project);

    const installs = await screen.findAllByTestId('dependency-install');
    expect(installs).toHaveLength(1);
    await user.click(installs[0]);
    await waitFor(() => expect(project.installDependency).toHaveBeenCalledWith('extras'));
    // (The re-read after it lands is the SDK's change notification — see
    // "refreshes when a dependency changes from any other surface".)
  });

  it('removes a dependency by name, never one another dependency declared', async () => {
    const user = userEvent.setup();
    const project = makeProject([dep('docs'), dep('inner', { via: 'docs' })]);
    renderCard(project);

    const removes = await screen.findAllByTestId('dependency-remove');
    expect(removes).toHaveLength(1);
    await user.click(removes[0]);
    await waitFor(() => expect(project.removeDependency).toHaveBeenCalledWith('docs'));
  });

  it('offers to fetch what is missing when there are warnings', async () => {
    const user = userEvent.setup();
    const missing = dep('docs', { state: 'missing', local_path: null });
    const project = makeProject([missing], [missing]);
    renderCard(project);

    await user.click(await screen.findByTestId('dependency-resolve'));
    await waitFor(() => expect(project.resolveDependencies).toHaveBeenCalled());
  });

  it('offers Install again on an optional dependency whose install failed, with the reason', async () => {
    const project = makeProject([
      dep('extras', { required: false, state: 'unreachable', local_path: null, reason: 'Hub project not reachable' }),
    ]);
    renderCard(project);

    const row = await screen.findByTestId('dependency-row');
    expect(row).toHaveAttribute('data-state', 'unreachable');
    expect(screen.getByTestId('dependency-reason')).toHaveTextContent('Hub project not reachable');
    expect(screen.getByTestId('dependency-install')).toBeInTheDocument();
  });

  it('refreshes when a dependency changes from any other surface', async () => {
    const project = makeProject([dep('docs')]);
    renderCard(project);
    await screen.findByTestId('project-dependencies-card');
    expect(project.dependencies).toHaveBeenCalledTimes(1);

    // Another surface (a dialog, the navigator) holds its own Project instance
    // for the same project and adds through the SDK.
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependency: dep('legal'), include_dirs: [] });
    const other = new SdkProject({ id: PID, type: 'project', name: 'other' } as Partial<SdkProject>);
    await act(async () => {
      await other.addDependency('hub:00000000-0000-4000-8000-0000000000aa', { optional: true });
    });

    await waitFor(() => expect(project.dependencies).toHaveBeenCalledTimes(2));
  });
});
