/**
 * useProjectPackage — the Discover page's read model for the CURRENT project's
 * assets ("what's in the box"). Locks:
 *  - no active project → empty, not loading, no backend call;
 *  - with a project → one `/search` call per asset type, scoped to the project
 *    (projects=<id>, user=false), merged + normalized to PackageItems;
 *  - normalization: name falls back title→name→basename; description falls back
 *    to snippet; path from asset_ref||file_path.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get } }));

const state = vi.hoisted(() => ({ project: null as unknown }));
vi.mock('@sdk', () => ({ get dataContext() { return { project: state.project }; } }));

import { useProjectPackage, PACKAGE_ASSET_TYPES } from '@src/pages/discover-page/useProjectPackage';

beforeEach(() => {
  vi.clearAllMocks();
  state.project = null;
});

describe('useProjectPackage', () => {
  it('returns empty and makes no backend call when no project is open', async () => {
    const { result } = renderHook(() => useProjectPackage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.projectId).toBeNull();
    expect(result.current.items).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('fans out one scoped /search per asset type and normalizes rows', async () => {
    state.project = { typeId: { id: 'proj-1' }, name: 'Demo', getDisplayName: () => 'Demo Project' };
    get.mockImplementation((url: string) => {
      if (url.includes('record_type=skill')) {
        return Promise.resolve({
          results: [
            { record_id: 's1', record_type: 'skill', title: 'Scrape', description: 'Scrape pages', scope: 'project', asset_ref: '/p/skills/scrape/SKILL.md' },
          ],
        });
      }
      if (url.includes('record_type=agent')) {
        return Promise.resolve({
          results: [
            // no title → basename of file_path; no description → snippet
            { record_id: 'a1', record_type: 'agent', name: '', snippet: 'a reviewer', scope: 'project', file_path: '/p/agents/reviewer.md' },
          ],
        });
      }
      return Promise.resolve({ results: [] });
    });

    const { result } = renderHook(() => useProjectPackage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // One request per asset type, each scoped to the project and excluding user scope.
    expect(get).toHaveBeenCalledTimes(PACKAGE_ASSET_TYPES.length);
    const urls = get.mock.calls.map((c) => c[0] as string);
    urls.forEach((u) => {
      expect(u).toContain('projects=proj-1');
      expect(u).toContain('user=false');
    });

    expect(result.current.projectId).toBe('proj-1');
    expect(result.current.projectName).toBe('Demo Project');

    const byId = Object.fromEntries(result.current.items.map((i) => [i.id, i]));
    expect(byId.s1).toMatchObject({ type: 'skill', name: 'Scrape', description: 'Scrape pages', scope: 'project', path: '/p/skills/scrape/SKILL.md' });
    // title/name empty → basename; description empty → snippet; path → file_path
    expect(byId.a1).toMatchObject({ type: 'agent', name: 'reviewer.md', description: 'a reviewer', path: '/p/agents/reviewer.md' });
  });

  it('tolerates a failing type request (that type contributes nothing)', async () => {
    state.project = { typeId: { id: 'proj-2' } };
    get.mockImplementation((url: string) =>
      url.includes('record_type=skill')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ results: [] }),
    );
    const { result } = renderHook(() => useProjectPackage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items).toEqual([]);
  });
});
