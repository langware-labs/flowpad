/**
 * The missing-required-dependencies dialog raised when the open project needs a
 * dependency that is not on this machine.
 *
 * "Don't show again until Flowpad restarts" is the BACKEND's memory
 * (`dismiss-dependency-warning`): the dialog asks it to dismiss each warning and
 * then trusts `warnings` — so after a backend restart the warning simply comes
 * back, with nothing on this side to clear.
 */
import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DependencyState } from '@sdk';

const h = vi.hoisted(() => ({
  project: null as null | Record<string, unknown>,
  openProjectSetup: vi.fn(),
}));

vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: h.project }) }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: h.project }) }));
vi.mock('@src/components/project-setup/project-setup-store', () => ({ openProjectSetup: h.openProjectSetup }));

import { TooltipProvider } from '@src/components/ui/tooltip';
import {
  MissingDependenciesDialogRoot,
  resetMissingDependenciesSeen,
} from '@src/components/project-home/MissingDependenciesDialog';

const PID = '0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const MISSING: DependencyState = {
  name: 'vendor-skills',
  source: 'git+https://github.com/acme/skills#main',
  required: true,
  path: '.',
  state: 'unreachable',
  local_path: null,
  reason: 'Repository not found',
  via: null,
  dismissed: false,
};

/** A project whose backend dismisses warnings the way the real one does —
 *  in memory, until `restart()`. */
function makeProject() {
  const dismissed = new Set<string>();
  const project = {
    id: PID,
    name: 'Demo',
    include_dirs: [],
    context_dir_infos: [],
    dependencies: vi.fn(() =>
      Promise.resolve({
        dependencies: [MISSING],
        warnings: dismissed.has(MISSING.name) ? [] : [MISSING],
        resolving: false,
      }),
    ),
    dismissDependencyWarning: vi.fn((name: string) => {
      dismissed.add(name);
      return Promise.resolve();
    }),
    restart: () => dismissed.clear(),
  };
  return project;
}

function renderRoot() {
  return render(
    <TooltipProvider>
      <MissingDependenciesDialogRoot />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  resetMissingDependenciesSeen();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.project = null;
});

describe('MissingDependenciesDialog', () => {
  it('lists each missing required dependency with its reason', async () => {
    h.project = makeProject();
    renderRoot();

    expect(await screen.findByTestId('missing-dependencies-dialog')).toBeInTheDocument();
    const row = screen.getByTestId('missing-dependency');
    expect(row).toHaveAttribute('data-dependency-name', 'vendor-skills');
    expect(screen.getByText('Repository not found')).toBeInTheDocument();
  });

  it('dismisses each warning on the backend and does not come back this session', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    h.project = project;
    const view = renderRoot();

    await screen.findByTestId('missing-dependencies-dialog');
    await user.click(screen.getByTestId('missing-dependencies-dont-show'));
    await user.click(screen.getByTestId('missing-dependencies-not-now'));

    await waitFor(() => expect(project.dismissDependencyWarning).toHaveBeenCalledWith('vendor-skills'));
    await waitFor(() => expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull());

    // The project is opened again (a fresh mount reads the warnings again):
    // the backend still remembers, so nothing shows.
    view.unmount();
    renderRoot();
    await waitFor(() => expect(project.dependencies).toHaveBeenCalledTimes(3));
    expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();
  });

  it('comes back once the backend restarts and forgets the dismissal', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    h.project = project;
    const view = renderRoot();

    await screen.findByTestId('missing-dependencies-dialog');
    await user.click(screen.getByTestId('missing-dependencies-dont-show'));
    await user.click(screen.getByTestId('missing-dependencies-not-now'));
    await waitFor(() => expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull());

    view.unmount();
    act(() => project.restart());
    renderRoot();
    expect(await screen.findByTestId('missing-dependencies-dialog')).toBeInTheDocument();
  });

  it('"Not now" without the checkbox dismisses nothing on the backend', async () => {
    const user = userEvent.setup();
    const project = makeProject();
    h.project = project;
    renderRoot();

    await screen.findByTestId('missing-dependencies-dialog');
    await user.click(screen.getByTestId('missing-dependencies-not-now'));

    await waitFor(() => expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull());
    expect(project.dismissDependencyWarning).not.toHaveBeenCalled();
  });

  it('"Fix…" opens the project setup', async () => {
    const user = userEvent.setup();
    h.project = makeProject();
    renderRoot();

    await screen.findByTestId('missing-dependencies-dialog');
    await user.click(screen.getByTestId('missing-dependencies-fix'));

    expect(h.openProjectSetup).toHaveBeenCalledWith({ projectId: PID, projectName: 'Demo' });
    await waitFor(() => expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull());
  });

  it('shows nothing when no required dependency is missing', async () => {
    const project = makeProject();
    project.dependencies = vi.fn(() => Promise.resolve({ dependencies: [], warnings: [], resolving: false }));
    h.project = project;
    renderRoot();
    await waitFor(() => expect(project.dependencies).toHaveBeenCalled());
    expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();
  });

  it('stays closed while the backend is still resolving, then decides on the settled answer', async () => {
    vi.useFakeTimers();
    try {
      const project = makeProject();
      // Opening the project started a resolve: twice "still resolving", then settled.
      let calls = 0;
      project.dependencies = vi.fn(() => {
        calls += 1;
        return Promise.resolve({ dependencies: [MISSING], warnings: [MISSING], resolving: calls < 3 });
      });
      h.project = project;
      renderRoot();

      await act(async () => {
        await Promise.resolve();
      });
      expect(project.dependencies).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();

      // Re-read while resolving — still nothing shown.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(project.dependencies).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();

      // The resolve finished and the dependency is still not here: now it's a warning.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(project.dependencies).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('missing-dependencies-dialog')).toBeInTheDocument();

      // Settled: no more polling.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(project.dependencies).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never opens when the resolve fetched what was missing', async () => {
    vi.useFakeTimers();
    try {
      const project = makeProject();
      let calls = 0;
      project.dependencies = vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls < 2
            ? { dependencies: [MISSING], warnings: [MISSING], resolving: true }
            : { dependencies: [{ ...MISSING, state: 'ready' as const }], warnings: [], resolving: false },
        );
      });
      h.project = project;
      renderRoot();

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(project.dependencies).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('missing-dependencies-dialog')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
