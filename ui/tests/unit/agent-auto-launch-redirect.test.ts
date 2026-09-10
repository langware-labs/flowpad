import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_AUTO_LAUNCH_ENDPOINT,
  agentAutoLaunchRedirect,
} from '@src/agents/agent-auto-launch-redirect';
import { AGENT_AUTO_LAUNCH_WARNING_KEY, takeAgentAutoLaunchWarning } from '@src/agents/agent-auto-launch-warning';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getById: vi.fn(),
  watch: vi.fn(),
  drainQueue: vi.fn(),
  embed: vi.fn(),
  hubOnly: vi.fn(() => false),
  dataContext: { project: null as { id: string } | null },
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

function launched(cancelled: { agent_id: string; title: string }[] = []) {
  return {
    agent_id: 'agent-a',
    agent_title: 'Greeter',
    process_id: PROCESS_ID,
    process_typeid: `agentic_process-${PROCESS_ID}`,
    prompt_queued: true,
    cancelled,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.post.mockReset();
  mocks.getById.mockReset();
  mocks.embed.mockReset().mockResolvedValue(undefined);
  mocks.watch.mockReset().mockResolvedValue(undefined);
  mocks.drainQueue.mockReset().mockResolvedValue(undefined);
  mocks.hubOnly.mockReturnValue(false);
  mocks.dataContext.project = null;
  mocks.getById.mockResolvedValue({ watch: mocks.watch, drainQueue: mocks.drainQueue });
});

describe('project agent auto-launch redirect', () => {
  it.each([
    ['a Hub Project route', `http://flowpad.local/dock/hub/project/${PROJECT_ID}`, () => {}],
    ['a Hub-only build', `http://flowpad.local/dock/project/${PROJECT_ID}`, () => mocks.hubOnly.mockReturnValue(true)],
    ['a deep link (?action=open)', `http://flowpad.local/dock/project/${PROJECT_ID}?action=open`, () => {}],
    ['a route already inside a session', `http://flowpad.local/dock/shell/agentic_process-${PROCESS_ID}`, () => {}],
  ])('never calls the API for %s', async (_label, url, setup) => {
    setup();
    const response = await agentAutoLaunchRedirect(new Request(url));
    expect(response).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('launches for the Project named by the URL, embeds vibe, kicks the queue, redirects into Vibe', async () => {
    mocks.post.mockResolvedValue(launched());

    const response = await agentAutoLaunchRedirect(new Request(`http://flowpad.local/dock/project/${PROJECT_ID}`));

    expect(mocks.post).toHaveBeenCalledWith(AGENT_AUTO_LAUNCH_ENDPOINT, { project_id: PROJECT_ID });
    expect(mocks.getById).toHaveBeenCalledWith(PROCESS_ID);
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Persona first, then the kick: the queued prompt must not run before vibe is embedded.
    expect(mocks.embed.mock.invocationCallOrder[0]).toBeLessThan(mocks.drainQueue.mock.invocationCallOrder[0]);
    expect(response?.status).toBe(302);
    const location = response?.headers.get('Location') ?? '';
    expect(location).toContain(`/dock/shell/agentic_process-${PROCESS_ID}`);
    expect(location).toContain('viewMode=vibe');
    expect(takeAgentAutoLaunchWarning()).toBeNull();
  });

  it('falls back to the adopted default project on the root route (sandbox landing)', async () => {
    mocks.dataContext.project = { id: PROJECT_ID };
    mocks.post.mockResolvedValue(launched());

    const response = await agentAutoLaunchRedirect(new Request('http://flowpad.local/'));

    expect(mocks.post).toHaveBeenCalledWith(AGENT_AUTO_LAUNCH_ENDPOINT, { project_id: PROJECT_ID });
    expect(response?.status).toBe(302);
  });

  it('stashes the cancelled-agents warning for the post-redirect flush', async () => {
    mocks.post.mockResolvedValue(launched([{ agent_id: 'agent-b', title: 'Second' }]));

    await agentAutoLaunchRedirect(new Request(`http://flowpad.local/dock/project/${PROJECT_ID}`));

    expect(sessionStorage.getItem(AGENT_AUTO_LAUNCH_WARNING_KEY)).not.toBeNull();
    expect(takeAgentAutoLaunchWarning()).toEqual({ winner: 'Greeter', cancelled: ['Second'] });
    expect(takeAgentAutoLaunchWarning()).toBeNull(); // read-and-clear
  });

  it('is a no-op when the backend has nothing to launch', async () => {
    mocks.post.mockResolvedValue({ agent_id: null, process_id: null, process_typeid: null, cancelled: [] });
    const response = await agentAutoLaunchRedirect(new Request(`http://flowpad.local/dock/project/${PROJECT_ID}`));
    expect(response).toBeNull();
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it('never blocks the load when the backend call fails', async () => {
    mocks.post.mockRejectedValue(new Error('boom'));
    const response = await agentAutoLaunchRedirect(new Request(`http://flowpad.local/dock/project/${PROJECT_ID}`));
    expect(response).toBeNull();
  });
});
