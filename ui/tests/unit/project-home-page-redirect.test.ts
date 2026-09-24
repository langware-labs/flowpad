import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_HOME_PAGE_ENDPOINT,
  projectHomePageRedirect,
} from '@src/project-home-page/project-home-page-redirect';
import { HOME_PAGE_OPEN, HOME_PAGE_PARAM, isProjectHomePage } from '@src/project-home-page/home-page-state';
import { DockPointer } from '@src/navigation/DockPointer';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getById: vi.fn(),
  watch: vi.fn(),
  embed: vi.fn(),
  hubOnly: vi.fn(() => false),
  dataContext: { project: null as { id: string; customization?: { home_page?: string | null } } | null },
}));

vi.mock('@sdk/client', () => ({ default: { post: mocks.post, get: vi.fn() } }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    AgenticProcess: { type: 'agentic_process', getById: mocks.getById },
    dataContext: mocks.dataContext,
    isHubOnly: mocks.hubOnly,
  };
});
vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({ embedVibeSubagent: mocks.embed }));
vi.mock('@src/components/agents/AgentIntroCard', () => ({ AgentIntroCard: () => null }));

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const PROCESS_ID = '00000000-0000-4000-8000-000000000002';
const AGENT = 'agent-00000000-0000-4000-8000-000000000003';
/** What the Home button navigates to. */
const HOME_BUTTON_URL = `http://flowpad.local/?${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`;

function agentHomePage(launched: boolean) {
  return {
    asset: AGENT,
    type: 'agent',
    process_id: PROCESS_ID,
    process_typeid: `agentic_process-${PROCESS_ID}`,
    launched,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.post.mockReset();
  mocks.getById.mockReset().mockResolvedValue({ watch: mocks.watch });
  mocks.embed.mockReset().mockResolvedValue(undefined);
  mocks.watch.mockReset().mockResolvedValue(undefined);
  mocks.hubOnly.mockReturnValue(false);
  mocks.dataContext.project = { id: PROJECT_ID, customization: { home_page: AGENT } };
});

describe('project home page redirect — the Home button only', () => {
  it.each([
    // The regression: the project page is where the home page is CONFIGURED;
    // redirecting it would bounce the user into the agent before they could.
    ['the project page', `http://flowpad.local/dock/project/${PROJECT_ID}`, () => {}],
    ['a cold start on the bare root', 'http://flowpad.local/', () => {}],
    ['a Hub-only build', HOME_BUTTON_URL, () => mocks.hubOnly.mockReturnValue(true)],
    ['a route already inside a session', `http://flowpad.local/dock/shell/agentic_process-${PROCESS_ID}?${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`, () => {}],
    ['a project that names no home page', HOME_BUTTON_URL, () => {
      mocks.dataContext.project = { id: PROJECT_ID, customization: { home_page: null } };
    }],
    ['no project at all', HOME_BUTTON_URL, () => {
      mocks.dataContext.project = null;
    }],
  ])('never calls the API for %s', async (_label, url, setup) => {
    setup();
    expect(await projectHomePageRedirect(new Request(url))).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('resumes the agent chat in Vibe, as a replace, without re-embedding the persona', async () => {
    mocks.post.mockResolvedValue(agentHomePage(false));

    const response = await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(mocks.post).toHaveBeenCalledWith(PROJECT_HOME_PAGE_ENDPOINT, { project_id: PROJECT_ID });
    expect(response?.status).toBe(302);
    // `replace`: the `?homePage=open` location must not stay behind the session.
    expect(response?.headers.get('X-Remix-Replace')).toBe('true');
    const location = response?.headers.get('Location') ?? '';
    expect(location).toContain(`/dock/shell/agentic_process-${PROCESS_ID}`);
    expect(location).toContain('viewMode=vibe');
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("gives a FIRST chat the launcher's pre-turn stack", async () => {
    mocks.post.mockResolvedValue(agentHomePage(true));

    await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(mocks.getById).toHaveBeenCalledWith(PROCESS_ID);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it('remembers where the home page landed, so Home can step off it', async () => {
    mocks.post.mockResolvedValue(agentHomePage(false));
    const session = DockPointer.forShell(`agentic_process-${PROCESS_ID}`);

    expect(isProjectHomePage(PROJECT_ID, session)).toBe(false);
    await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(isProjectHomePage(PROJECT_ID, session)).toBe(true);
    expect(isProjectHomePage('another-project', session)).toBe(false);
  });

  it.each([
    ['no home page', { asset: null, process_id: null }],
    ['a backend error', { asset: null, process_id: null, error: 'boom' }],
  ])('is the default home for %s', async (_label, payload) => {
    mocks.post.mockResolvedValue(payload);
    expect(await projectHomePageRedirect(new Request(HOME_BUTTON_URL))).toBeNull();
  });

  it('never blocks the load when the backend call fails', async () => {
    mocks.post.mockRejectedValue(new Error('boom'));
    expect(await projectHomePageRedirect(new Request(HOME_BUTTON_URL))).toBeNull();
  });
});
