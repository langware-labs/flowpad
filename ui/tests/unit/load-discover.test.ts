import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const adoptScopeProject = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const initSdk = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@src/routes/loaders/load-dock-pointer', () => ({ adoptScopeProject }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, initSdk };
});

import { loadDiscover } from '@src/routes/loaders/load-discover';

afterEach(() => vi.clearAllMocks());

/**
 * `/discover` is a top-level route: no dock loader runs for it, so a deep
 * link (always a hard load) must resolve its project itself — from the one
 * `scope-*` URL grammar, through the same `adoptScopeProject` the home uses.
 */
describe('loadDiscover', () => {
  it('adopts the project named by ?scope-* before the page mounts', async () => {
    const request = new Request(`http://localhost/discover?scope-mode=project&scope-activeProjectId=${PROJECT_ID}`);
    await loadDiscover({ request, params: {}, context: {} } as any);
    expect(initSdk).toHaveBeenCalledTimes(1);
    expect(adoptScopeProject).toHaveBeenCalledTimes(1);
    const dock = adoptScopeProject.mock.calls[0][0] as { scopeProjectId: string | null };
    expect(dock.scopeProjectId).toBe(PROJECT_ID);
  });

  it('with no scope, hands an unscoped root to adoptScopeProject (active project stays)', async () => {
    await loadDiscover({ request: new Request('http://localhost/discover'), params: {}, context: {} } as any);
    const dock = adoptScopeProject.mock.calls[0][0] as { scopeProjectId: string | null };
    expect(dock.scopeProjectId).toBeNull();
  });
});

describe('loadDiscoverDetail', () => {
  it('adopts the scope the same way for /discover/:typeid', async () => {
    const { loadDiscoverDetail } = await import('@src/routes/loaders/load-discover');
    const request = new Request(`http://localhost/discover/skill-x?scope-mode=project&scope-activeProjectId=${PROJECT_ID}`);
    await loadDiscoverDetail({ request, params: { typeid: 'skill-x' }, context: {} } as never);
    expect(initSdk).toHaveBeenCalled();
    expect(adoptScopeProject.mock.calls[0][0].scopeProjectId).toBe(PROJECT_ID);
  });
});
