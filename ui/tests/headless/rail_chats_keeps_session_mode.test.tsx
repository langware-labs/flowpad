/**
 * Rail "Chats" from the Stream Inbox resumes the last chat in the mode it was
 * last shown in — full app in jsdom against a live backend, no mocks.
 *
 *   1. Seed a project and an opened chat session.
 *   2. Show the session in Standard (its remembered mode lands on the backend).
 *   3. Click the rail's Stream Inbox, then the rail's Chats.
 *   4. The session must come back in Standard — not on its Vibe host dock.
 *
 * Run: `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless`
 */
import { afterAll, describe, expect, it } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { setupLiveBackend, bootApp } from './_harness';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[rail chats mode]');
let projectId = '';
let apiUrl = '';

afterAll(async () => {
  if (projectId && apiUrl) {
    await fetch(`${apiUrl}/api/v1/graph/project/${projectId}/delete-with-children`, { method: 'POST' }).catch(() => {});
  }
});

describe('rail Chats keeps the session mode (no mocks)', () => {
  it('Stream Inbox → Chats reopens a Standard chat in Standard', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');
    apiUrl = live.apiUrl;

    // 1. Seed.
    const { sdk } = await createSdkRealm(apiUrl);
    await sdk.initSdk();
    const project = await new sdk.Project({ name: `/tmp/flow_test_rail_chats_${Date.now()}` }).save([]);
    projectId = project.id;
    const chat = await new sdk.AgenticProcess({
      name: 'rail chats mode',
      project_id: projectId,
      process_type: sdk.ProcessKind.Chat,
      last_active_at: Date.now(),
    }).save([]);

    // 2. Show it in Standard; the backend remembers the mode.
    const { router, container } = await bootApp();
    const scope = `scope-mode=project&scope-activeProjectId=${projectId}`;
    await act(async () => {
      await router.navigate(`/dock/shell/agentic_process-${chat.id}?viewMode=standard&${scope}`);
    });
    await waitFor(
      async () => expect((await sdk.AgenticProcess.getById(chat.id))?.last_mode).toBe('standard'),
      { timeout: 10000 }, // do not increase timeout without approval
    );

    // 3. Stream Inbox, then Chats — through the real rail buttons.
    const rail = (id: string) => container.querySelector<HTMLButtonElement>(`[data-rail-item="${id}"]`)!;
    await waitFor(() => expect(rail('stream_inbox')).toBeTruthy());
    act(() => {
      fireEvent.click(rail('stream_inbox'));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/dock/stream_inbox'));
    act(() => {
      fireEvent.click(rail('chats'));
    });

    // 4. Back on the session, in the mode it was left in.
    await waitFor(
      () => expect(router.state.location.pathname).toContain(`agentic_process-${chat.id}`),
      { timeout: 10000 }, // do not increase timeout without approval
    );
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
    expect(router.state.location.pathname).toBe(`/dock/shell/agentic_process-${chat.id}`);
    expect(new URLSearchParams(router.state.location.search).get('viewMode')).toBe('standard');
  });
});
