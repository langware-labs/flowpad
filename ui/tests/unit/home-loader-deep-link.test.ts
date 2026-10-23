import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adopt: vi.fn().mockResolvedValue(undefined),
  init: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@src/routes/loaders/load-dock-pointer', () => ({ adoptScopeProject: mocks.adopt }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, initSdk: mocks.init, isHubOnly: () => false };
});
vi.mock('@src/routes/loaders/load-redirects', () => ({
  registerLoadRedirect: vi.fn(),
  runLoadRedirects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@src/journey/journey-load-redirect', () => ({}));
vi.mock('@src/agents/agent-auto-launch-redirect', () => ({}));
vi.mock('@src/project-home-page/project-home-page-redirect', () => ({}));

import { loadHomePage } from '@src/routes/loaders/home-loader';
import { runLoadRedirects } from '@src/routes/loaders/load-redirects';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const load = (search = '') =>
  loadHomePage({ request: new Request(`http://localhost/${search}`), params: {}, context: {} } as never);

afterEach(() => vi.clearAllMocks());

describe('home entry project selection', () => {
  it.each(['launch', 'open'])('leaves action=%s target selection to its inbound handler', async (action) => {
    await load(`?action=${action}&target=${PROJECT_ID}`);
    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it.each(['', '?action=unknown'])('retains ordinary home fallback for %s', async (search) => {
    await load(search);
    expect(mocks.adopt).toHaveBeenCalledOnce();
    expect(mocks.adopt.mock.calls[0][0].scopeProjectId).toBeNull();
  });

  it('still adopts the project explicitly scoped by an ordinary home URL', async () => {
    await load(`?scope-mode=project&scope-activeProjectId=${PROJECT_ID}`);
    expect(mocks.adopt).toHaveBeenCalledOnce();
    expect(mocks.adopt.mock.calls[0][0].scopeProjectId).toBe(PROJECT_ID);
  });
});

// The desktop's clean start after it recovered a hung window (electron/renderer-watchdog.js).
describe('safe start', () => {
  it('opens Home: no launch redirect runs and the remembered place is forgotten', async () => {
    localStorage.setItem('flowpad.lastDockUrl', '/dock/assets/editor/agent/typeid/agent-e1bf3281-4a7f-4630-8408-ed977bf28fd1');
    await expect(load('?safeStart=1')).resolves.toBeUndefined();
    expect(runLoadRedirects).not.toHaveBeenCalled();
    expect(localStorage.getItem('flowpad.lastDockUrl')).toBeNull();
  });

  it('an ordinary home load still runs the launch redirects', async () => {
    await load();
    expect(runLoadRedirects).toHaveBeenCalledOnce();
  });
});
