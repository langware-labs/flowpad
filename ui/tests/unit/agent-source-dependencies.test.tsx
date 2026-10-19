import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DataSource, type DependencyState } from '@sdk';
import { SourceDependencyRows } from '@src/components/agent-resources/AgentDataSourcesSection';

vi.mock('@src/components/data-sources/use-source-specs', () => ({ useSourceSpecs: () => ({ specFor: () => undefined }), isMessageDriverSpec: () => false }));
vi.mock('@src/components/setup-wizard/SetupStagesButton', () => ({ SetupStagesButton: () => null }));
vi.mock('@src/components/data-sources/SourceSetupButton', () => ({ SourceSetupButton: () => null }));
afterEach(cleanup);

it('renders C with B/A provenance, distinguishes sync state, and removes only C', async () => {
  const sources = ['Personal', 'Team', 'Company'].map((name, i) => new DataSource({
    id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, '0')}`,
    name, provider: 'gdrive', status: 'active', health: i === 1 ? 'never_synced' : 'ok',
  }));
  const states: DependencyState[] = sources.map((source, i) => ({
    name: ['personal', 'team', 'company'][i], source: source.typeId.toString(), typeid: source.typeId.toString(),
    state: 'ready', required: true, dismissed: false, path: '.',
    local_path: `/cache/${source.name}`,
    via_path: [[], ['personal'], ['personal', 'team']][i],
  }));
  const remove = vi.fn();
  const open = vi.fn();
  render(<SourceDependencyRows states={states} sources={sources} onOpen={open} isOpen={() => false} onRemove={remove} />);
  expect(screen.getByText('Personal')).toBeVisible();
  expect(screen.getByText('Team')).toBeVisible();
  expect(screen.getByText('Company')).toBeVisible();
  expect(screen.getByText('Via Personal · Never synced')).toBeVisible();
  expect(screen.getByText('Via Personal → Team · Running')).toBeVisible();
  expect(screen.getAllByRole('button', { name: /Remove .* from agent/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Remove Personal from agent' }));
  expect(remove).toHaveBeenCalledWith('personal');
  await userEvent.click(screen.getByTestId(`agent-dependency-source-${sources[1].id}`));
  expect(open).toHaveBeenCalledWith(sources[1].typeId.toString());
});

it('discards a previous agent response when the resource scope changes', async () => {
  const { act, renderHook } = await import('@testing-library/react');
  const { Project } = await import('@sdk');
  const { useProjectDependencies } = await import('@src/hooks/use-project-dependencies');
  const project = new Project({ id: '77777777-7777-4777-8777-000000000010', name: 'Policies' });
  type Result = Awaited<ReturnType<Project['dependencies']>>;
  let first!: (value: Result) => void;
  let second!: (value: Result) => void;
  vi.spyOn(project, 'dependencies')
    .mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { second = resolve; }));
  const { result, rerender } = renderHook(({ asset }) => useProjectDependencies(project, { asset }), { initialProps: { asset: 'first' } });
  rerender({ asset: 'second' });
  await act(async () => { second({ dependencies: [], warnings: [], resolving: false }); await Promise.resolve(); });
  await act(async () => { first({ dependencies: [{ name: 'stale' } as DependencyState], warnings: [], resolving: false }); await Promise.resolve(); });
  expect(result.current.dependencies).toEqual([]);
  expect(result.current.isLoading).toBe(false);
});

it('shows source health for ready API dependencies without local files and preserves resolution failures', () => {
  const source = new DataSource({
    id: '77777777-7777-4777-8777-000000000021', name: 'Read-only Gmail',
    provider: 'gmail', read_only: true, status: 'active', health: 'ok',
  });
  const state: DependencyState = {
    name: 'mail', source: source.typeId.toString(), typeid: source.typeId.toString(),
    state: 'ready', required: true, dismissed: false, path: '.', local_path: null,
  };
  const props = { sources: [source], onOpen: vi.fn(), isOpen: () => false };
  const { rerender } = render(<SourceDependencyRows states={[state]} {...props} />);
  expect(screen.getByText('Added directly · Running')).toBeVisible();
  expect(screen.queryByText(/Files not available/)).toBeNull();
  rerender(<SourceDependencyRows states={[{ ...state, state: 'missing', reason: 'Source cannot be resolved' }]} {...props} />);
  expect(screen.getByText('Added directly · Source cannot be resolved')).toBeVisible();
});
