/**
 * `list-projects` is a disk scan of every historical worker cwd. Nothing may
 * ask for it until a surface actually shows its result: not app startup, and
 * not Home until a search renders results.
 */

import { ContextEntitiesEnum, dataContext, dataManager, LazyAsset, lazyAssets } from '@sdk';
import { scopeProjectIds } from '@sdk/utils/scope-filter';
import { prefetchStartupAssets } from '@sdk/lazy/startup';
import { useGlobalSearchScope } from '@src/hooks/use-global-search-scope';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/contexts/agent-context', () => ({
  useAgentContext: () => ({ computeNode: { id: '@local' } }),
}));

afterEach(() => {
  lazyAssets.setScope(Math.random().toString());
  vi.restoreAllMocks();
});

const isListProjects = (action: unknown) => (action as { name?: string })?.name === 'list-projects';
const listProjectsCalls = (calls: unknown[][]) => calls.filter(([action]) => isListProjects(action));

describe('project list on demand', () => {
  it('startup prefetch does not scan projects', async () => {
    const real = dataContext.getContextEntity.bind(dataContext);
    vi.spyOn(dataContext, 'getContextEntity').mockImplementation((key) =>
      key === ContextEntitiesEnum.CurrentComputeNodeTypeId ? ({ id: '@local' } as never) : real(key),
    );
    expect(dataContext.computeNode?.id).toBe('@local');
    const prefetch = vi.spyOn(lazyAssets, 'prefetch').mockResolvedValue(undefined as never);

    await prefetchStartupAssets();

    const assets = prefetch.mock.calls.map((args) => args[0]);
    // The desktop branch ran, so the absence below is not a hub-only skip.
    expect(assets).toContain(LazyAsset.AssetStats);
    expect(assets).not.toContain(LazyAsset.DiscoveredProjects);
  });

  it('search scope fetches only once enabled, and keeps disk-only project ids', async () => {
    const diskOnly = 'dddddddd-dddd-5ddd-8ddd-dddddddddddd';
    const call = vi.spyOn(dataManager, 'callAction').mockImplementation(async (action) =>
      isListProjects(action)
        ? ({ projects: [{ id: diskOnly, cwd: '/work/never-opened', system: false }], total_count: 1 } as never)
        : (undefined as never),
    );

    const hook = renderHook(({ enabled }) => useGlobalSearchScope({ enabled }), {
      initialProps: { enabled: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listProjectsCalls(call.mock.calls)).toHaveLength(0);

    hook.rerender({ enabled: true });
    await waitFor(() => expect(scopeProjectIds(hook.result.current.scope)).toContain(diskOnly));
    expect(listProjectsCalls(call.mock.calls)).toHaveLength(1);
  });
});
