/**
 * A chat whose history is still loading must not read as an empty one.
 *
 * Opening a chat for the first time since the app loaded ("cold") fetches its
 * history — up to 2 s in the field (`tab_switch` ready … history_ms=2021) — and
 * the pane painted "Start a conversation" over the whole wait. It shows a
 * loading line until the first load settles, and the invitation only after.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AgenticProcess } from '@sdk';

vi.mock('@src/hooks/use-launching-agent', () => ({ useLaunchingAgent: () => null }));

import { SimpleChatPane } from '@src/components/terminal/interactive-terminal/SimpleChatPane';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SimpleChatPane while history loads', () => {
  it('shows loading, not "Start a conversation", until the first load settles', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const process = new AgenticProcess({ id: '5b0c8f1e-2d3a-4c5b-8e6f-7a8b9c0d1e2f', pty_mode: false } as never);
    vi.spyOn(process, 'loadHistory').mockReturnValue(pending);

    const view = render(
      <MemoryRouter>
        <SimpleChatPane process={process} />
      </MemoryRouter>,
    );
    expect(view.queryByTestId('simple-chat-loading')).not.toBeNull();
    expect(view.queryByText('Start a conversation')).toBeNull();

    await act(async () => {
      finish();
      await pending;
    });
    expect(view.queryByTestId('simple-chat-loading')).toBeNull();
    expect(view.queryByText('Start a conversation')).not.toBeNull();
  });
});
