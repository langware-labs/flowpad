/**
 * Staging-mode (process === null) guard for `useProcessAssets`: the picker's
 * pre-first-send list must come from ONE `project/{id}/get-assets` call —
 * never from whole-type corpus queries (the removed implementation fetched
 * ALL agents + skills + specs + markdown docs, ~3.3MB / 3-5s at ~3k docs,
 * per picker open).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Project, dataContext, type AssetDescriptor } from '@sdk';
import { useProcessAssets } from '@src/components/asset-manager/useProcessAssets';

const DESCRIPTORS: AssetDescriptor[] = [
  {
    typeid: 'skill-00000000-0000-4000-8000-000000000001',
    source: 'user_dir',
    posix_path: '/home/u/.claude/skills/s',
    source_dir: '/home/u',
    project_id: null,
    usage: [],
  } as unknown as AssetDescriptor,
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useProcessAssets — staging (null process)', () => {
  it('resolves descriptors via Project.getAssetsById, @local fallback when projectless', async () => {
    const spy = vi.spyOn(Project, 'getAssetsById').mockResolvedValue(DESCRIPTORS);
    // dataContext.project is a non-configurable MobX computed — can't be
    // stubbed. Derive the id the hook must pass from the same expression
    // (null in this bootstrap-less unit env → '@local' fallback).
    const expectedProjectId = dataContext.project?.typeId?.id ?? '@local';
    const { result } = renderHook(() => useProcessAssets(null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.descriptors).toEqual(DESCRIPTORS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expectedProjectId, { limit: 1000 });
  });

  it('disabled hook fetches nothing', async () => {
    const spy = vi.spyOn(Project, 'getAssetsById').mockResolvedValue(DESCRIPTORS);
    const { result } = renderHook(() => useProcessAssets(null, { enabled: false }));
    expect(result.current.descriptors).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
