import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectHomePageRedirect } from '@src/project-home-page/project-home-page-redirect';
import { HOME_PAGE_OPEN, HOME_PAGE_PARAM, isProjectHomePage } from '@src/project-home-page/home-page-state';
import { DockPointer } from '@src/navigation/DockPointer';

const mocks = vi.hoisted(() => ({
  openHomePage: vi.fn(),
  query: vi.fn(),
  getById: vi.fn(),
  agentGetById: vi.fn(),
  use: vi.fn(),
  watch: vi.fn(),
  embed: vi.fn(),
  hubOnly: vi.fn(() => false),
  dataContext: { project: null as { id: string } | null },
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    AgenticProcess: { type: 'agentic_process', getById: mocks.getById, query: mocks.query },
    Agent: { type: 'agent', getById: mocks.agentGetById },
    Project: { type: 'project', openHomePage: mocks.openHomePage },
    dataContext: mocks.dataContext,
    isHubOnly: mocks.hubOnly,
  };
});
vi.mock('@src/pages/flow-page/use-start-vibe-session', () => ({ embedVibeSubagent: mocks.embed }));
vi.mock('@src/components/agents/AgentIntroCard', () => ({ AgentIntroCard: () => null }));

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const LAST_CHAT = '00000000-0000-4000-8000-000000000002';
const NEW_CHAT = '00000000-0000-4000-8000-000000000004';
const AGENT_ID = '00000000-0000-4000-8000-000000000003';
const AGENT = `agent-${AGENT_ID}`;
/** What the Home button navigates to. */
const HOME_BUTTON_URL = `http://flowpad.local/?${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`;
/** What launching the project navigates to. */
const LAUNCH_URL = `http://flowpad.local/dock/project/${PROJECT_ID}?${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`;

beforeEach(() => {
  sessionStorage.clear();
  mocks.openHomePage.mockReset().mockResolvedValue({ asset: AGENT, type: 'agent' });
  mocks.query.mockReset().mockResolvedValue([]);
  mocks.getById.mockReset().mockResolvedValue({ watch: mocks.watch });
  mocks.use.mockReset().mockResolvedValue({ process_id: NEW_CHAT });
  mocks.agentGetById.mockReset().mockResolvedValue({ use: mocks.use });
  mocks.embed.mockReset().mockResolvedValue(undefined);
  mocks.watch.mockReset().mockResolvedValue(undefined);
  mocks.hubOnly.mockReturnValue(false);
  mocks.dataContext.project = { id: PROJECT_ID };
});

function locationOf(response: Response | null): string {
  return response?.headers.get('Location') ?? '';
}

describe('project home page redirect — only navigations that ask for it', () => {
  it.each([
    // The project page is where the home page is CONFIGURED; reaching it
    // without `?homePage=open` must not bounce the user into the agent.
    ['the project page', `http://flowpad.local/dock/project/${PROJECT_ID}`, () => {}],
    ['a cold start on the bare root', 'http://flowpad.local/', () => {}],
    ['a Hub-only build', HOME_BUTTON_URL, () => mocks.hubOnly.mockReturnValue(true)],
    ['a route already inside a session', `http://flowpad.local/dock/shell/agentic_process-${LAST_CHAT}?${HOME_PAGE_PARAM}=${HOME_PAGE_OPEN}`, () => {}],
    ['no project at all', HOME_BUTTON_URL, () => {
      mocks.dataContext.project = null;
    }],
  ])('never asks the backend for %s', async (_label, url, setup) => {
    setup();
    expect(await projectHomePageRedirect(new Request(url))).toBeNull();
    expect(mocks.openHomePage).not.toHaveBeenCalled();
  });

  it('launching the project resolves its home page', async () => {
    await projectHomePageRedirect(new Request(LAUNCH_URL));
    expect(mocks.openHomePage).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("resumes the agent's last chat in Vibe, as a replace, without opening a new one", async () => {
    mocks.query.mockResolvedValue([{ id: LAST_CHAT, last_active_at: 5 }]);

    const response = await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(mocks.openHomePage).toHaveBeenCalledWith(PROJECT_ID);
    expect(response?.status).toBe(302);
    // `replace`: the `?homePage=open` location must not stay behind the session.
    expect(response?.headers.get('X-Remix-Replace')).toBe('true');
    expect(locationOf(response)).toContain(`/dock/shell/agentic_process-${LAST_CHAT}`);
    expect(locationOf(response)).toContain('viewMode=vibe');
    expect(mocks.use).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("opens the agent's FIRST chat with the launcher's pre-turn stack", async () => {
    const response = await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(mocks.agentGetById).toHaveBeenCalledWith(AGENT_ID);
    expect(mocks.use).toHaveBeenCalledWith(PROJECT_ID);
    expect(mocks.getById).toHaveBeenCalledWith(NEW_CHAT);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(locationOf(response)).toContain(`/dock/shell/agentic_process-${NEW_CHAT}`);
  });

  it('remembers where the home page landed, so Home can step off it', async () => {
    mocks.query.mockResolvedValue([{ id: LAST_CHAT, last_active_at: 5 }]);
    const session = DockPointer.forShell(`agentic_process-${LAST_CHAT}`);

    expect(isProjectHomePage(PROJECT_ID, session)).toBe(false);
    await projectHomePageRedirect(new Request(HOME_BUTTON_URL));

    expect(isProjectHomePage(PROJECT_ID, session)).toBe(true);
    expect(isProjectHomePage('another-project', session)).toBe(false);
  });

  it.each([
    ['no home page', { asset: null, type: null }],
    ['a backend error', { asset: null, type: null, error: 'boom' }],
  ])('is the default home for %s', async (_label, payload) => {
    mocks.openHomePage.mockResolvedValue(payload);
    expect(await projectHomePageRedirect(new Request(HOME_BUTTON_URL))).toBeNull();
  });

  it('never blocks the load when the backend call fails', async () => {
    mocks.openHomePage.mockRejectedValue(new Error('boom'));
    expect(await projectHomePageRedirect(new Request(HOME_BUTTON_URL))).toBeNull();
  });

  it('never blocks the load when opening the agent fails', async () => {
    mocks.use.mockRejectedValue(new Error('no worker'));
    expect(await projectHomePageRedirect(new Request(HOME_BUTTON_URL))).toBeNull();
  });
});
