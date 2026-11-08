/**
 * Dependencies Flowpad cloned that are behind their remote: the top bar's key glows blue (yellow with a
 * blue dot when setup is also owed), and the setup dialog offers one "Pull dependencies to latest".
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DependencyState } from '@sdk';

const h = vi.hoisted(() => ({
  left: 0,
  updates: 0,
  deps: [] as DependencyState[],
  resolve: vi.fn(),
  recheck: vi.fn(),
}));
vi.mock('@sdk/react/hooks/use-project-readiness', () => ({
  useProjectSetupLeft: () => h.left,
  useProjectUpdatesPending: () => h.updates,
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => false }));
vi.mock('@src/hooks/entity-hooks/useEntity', () => ({ useEntity: () => ({ data: { id: 'p1' } }) }));
vi.mock('@src/hooks/use-project-dependencies', () => ({
  useProjectDependencies: () => ({ dependencies: h.deps, resolve: h.resolve }),
}));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  recheckProjectReadiness: h.recheck,
}));

import { TooltipProvider } from '@src/components/ui/tooltip';
import { ProjectSetupButton } from '@src/components/top-nav-bar/ProjectSetupButton';
import { DependencyUpdatesStrip } from '@src/components/project-setup/DependencyUpdatesStrip';

const PROJECT = { id: 'p1', name: 'demo-app' } as never;

function dep(name: string, extra: Partial<DependencyState>): DependencyState {
  return { name, source: `git+https://example.com/${name}.git#main`, required: true, path: '.', state: 'ready', dismissed: false, ...extra };
}

function renderButton() {
  return render(
    <TooltipProvider>
      <ProjectSetupButton project={PROJECT} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.left = 0;
  h.updates = 0;
  h.deps = [];
  vi.clearAllMocks();
});

describe('ProjectSetupButton — updates', () => {
  it('is absent when nothing is owed and nothing is behind', () => {
    renderButton();
    expect(screen.queryByTestId('top-nav-project-setup')).toBeNull();
  });

  it('glows blue when only updates are waiting', () => {
    h.updates = 2;
    renderButton();
    const button = screen.getByTestId('top-nav-project-setup');
    expect(button).toHaveClass('animate-updates-glow');
    expect(button).not.toHaveClass('animate-setup-glow');
    expect(button).toHaveAttribute('aria-label', 'Dependency updates available');
    expect(screen.queryByTestId('top-nav-project-updates-dot')).toBeNull();
  });

  it('stays yellow with a blue dot when setup is owed too', () => {
    h.left = 1;
    h.updates = 2;
    renderButton();
    expect(screen.getByTestId('top-nav-project-setup')).toHaveClass('animate-setup-glow');
    expect(screen.getByTestId('top-nav-project-updates-dot')).toBeInTheDocument();
  });
});

describe('DependencyUpdatesStrip', () => {
  it('is absent when nothing is behind', () => {
    h.deps = [dep('kit', { behind: 0 })];
    render(<DependencyUpdatesStrip projectId="p1" />);
    expect(screen.queryByTestId('project-setup-dependency-updates')).toBeNull();
  });

  it('lists each dependency behind, and Pull brings them to latest then re-reads readiness', async () => {
    h.deps = [dep('assistant', { behind: 3 }), dep('kit', { behind: 7 }), dep('fine', { behind: 0 })];
    let finish!: () => void;
    h.resolve.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<DependencyUpdatesStrip projectId="p1" />);

    expect(screen.getByText('2 dependencies are behind')).toBeInTheDocument();
    expect(screen.getByTestId('project-setup-dependency-update-assistant')).toHaveTextContent('3 commits behind');
    expect(screen.queryByTestId('project-setup-dependency-update-fine')).toBeNull();

    fireEvent.click(screen.getByTestId('project-setup-pull-dependencies'));
    expect(h.resolve).toHaveBeenCalledWith({ update: true });
    expect(screen.getByTestId('project-setup-pull-dependencies')).toBeDisabled();
    await act(() => {
      finish();
      return Promise.resolve();
    });
    await waitFor(() => expect(h.recheck).toHaveBeenCalled());
    expect(screen.getByTestId('project-setup-pull-dependencies')).not.toBeDisabled();
  });

  it('says why a dependency could not be pulled', () => {
    h.deps = [dep('assistant', { behind: 1, pull_error: "Has local changes — can't pull without losing them" })];
    render(<DependencyUpdatesStrip projectId="p1" />);
    expect(screen.getByTestId('project-setup-dependency-update-assistant')).toHaveTextContent('Has local changes');
  });
});
