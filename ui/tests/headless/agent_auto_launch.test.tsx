/**
 * Agent auto-launch — full app in jsdom against a live backend, no mocks.
 *
 *   1. Seed a project with one `auto_launch` agent through the real authoring
 *      route (agent.md lands under the project, indexed, in scope).
 *   2. Boot the real app and navigate to the project.
 *   3. The dock loader's redirect must land on the agent's session in Vibe,
 *      the intro row must render, and the backend must hold the once-only mark.
 *   4. Navigating to the project again stays on the project.
 *
 * Run: `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless`
 */
import { afterAll, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[agent auto-launch]');
let projectId = '';
let apiUrl = '';

async function post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

afterAll(async () => {
  if (projectId && apiUrl) {
    await fetch(`${apiUrl}/api/v1/graph/project/${projectId}/delete-with-children`, { method: 'POST' }).catch(() => {});
  }
});

describe('project agent auto-launch (no mocks)', () => {
  it('redirects the first project open into the agent session with its intro, once', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');
    apiUrl = live.apiUrl;

    // 1. Seed.
    const stamp = Date.now();
    const created = await post(`${apiUrl}/api/v1/graph/project`, { type: 'project', name: `al-headless-${stamp}` });
    projectId = created?.data?.id;
    expect(projectId).toBeTruthy();
    const title = `Greeter ${stamp}`;
    const agent = await post(`${apiUrl}/api/v1/graph/project/${projectId}/agent`, {
      type: 'agent',
      name: title,
      title,
      intro: `Welcome from ${title}.`,
      auto_launch: true,
      auto_launch_prompt: 'Reply with exactly the words AUTO LAUNCH OK and nothing else.',
    });
    expect(agent?.status).toBe('SUCCESS');

    // 2. Boot the real app against this backend and open the project.
    await createSdkRealm(apiUrl);
    const { router } = await bootApp();
    await act(async () => {
      await router.navigate(`/dock/project/${projectId}`);
    });

    // 3. Redirected into the session, in Vibe, with the intro row.
    await waitFor(
      () => expect(router.state.location.pathname).toMatch(/\/dock\/shell\/agentic_process-[0-9a-f-]+/),
      { timeout: 18000 }, // do not increase timeout without approval
    );
    expect(router.state.location.search).toContain('viewMode=vibe');
    const intro = await screen.findByTestId('agent-intro-message', {}, { timeout: 18000 }); // do not increase timeout without approval
    expect(intro.textContent).toContain(`Welcome from ${title}.`);

    const marks = await (await fetch(`${apiUrl}/api/v1/agents/auto-launch?project_id=${projectId}`)).json();
    expect(marks?.data?.auto_launched_agent_ids).toEqual([agent.data.id]);

    // 4. Once only: the project route stays put on the next open.
    await act(async () => {
      await router.navigate(`/dock/project/${projectId}`);
    });
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
    expect(router.state.location.pathname).toBe(`/dock/project/${projectId}`);
  });
});
