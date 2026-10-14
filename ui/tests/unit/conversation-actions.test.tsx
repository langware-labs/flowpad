/**
 * A channel's conversation verbs (`channel_spec.actions`) render as buttons, run through
 * `conversation.act`, and show the channel's refusal in place; an ended conversation hides them
 * and wears a muted "Ended" line.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@sdk/entities/conversation';
import type { IActionSpec } from '@sdk/models/ChannelSpec';
import { ConversationActions, ConversationEndedLine } from '@src/components/conversation/ConversationActions';

afterEach(cleanup);

const conversationWith = (actions: IActionSpec[], fields: Partial<Conversation> = {}) => {
  const act = vi.fn().mockResolvedValue({ ok: true });
  const conversation = { id: 'c1', channel_spec: { actions }, ended_at: null, act, ...fields } as unknown as Conversation;
  return { conversation, act };
};

describe('ConversationActions', () => {
  it('renders one button per channel action', () => {
    const { conversation } = conversationWith([
      { id: 'approve', label: 'Approve', icon_name: 'Check' },
      { id: 'close', label: 'Close' },
    ]);
    render(<ConversationActions conversation={conversation} />);
    expect(screen.getByTestId('conversation-action-approve').textContent).toContain('Approve');
    expect(screen.getByTestId('conversation-action-close')).toBeTruthy();
  });

  it('asks first when the action carries a confirm, then acts', async () => {
    const { conversation, act } = conversationWith([
      { id: 'close', label: 'Close', confirm: 'Close this pull request?', destructive: true },
    ]);
    const onDone = vi.fn();
    render(<ConversationActions conversation={conversation} onDone={onDone} />);
    fireEvent.click(screen.getByTestId('conversation-action-close'));
    expect(act).not.toHaveBeenCalled();
    const dialog = await screen.findByTestId('conversation-action-confirm');
    expect(dialog.textContent).toContain('Close this pull request?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(act).toHaveBeenCalledWith('close', ''));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('passes the typed words when the action needs text', async () => {
    const { conversation, act } = conversationWith([{ id: 'request_changes', label: 'Request changes', needs_text: true }]);
    render(<ConversationActions conversation={conversation} />);
    fireEvent.click(screen.getByTestId('conversation-action-request_changes'));
    await screen.findByTestId('conversation-action-text');
    fireEvent.change(screen.getByTestId('conversation-action-text-input'), { target: { value: ' Needs a test ' } });
    fireEvent.click(screen.getByTestId('conversation-action-text-send'));
    await waitFor(() => expect(act).toHaveBeenCalledWith('request_changes', 'Needs a test'));
  });

  it("shows the channel's refusal in place", async () => {
    const { conversation, act } = conversationWith([{ id: 'approve', label: 'Approve' }]);
    // An axios refusal: its own message is boilerplate; the server's sentence rides the envelope.
    act.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: 'GitHub does not let you review your own pull request' } },
      }),
    );
    render(<ConversationActions conversation={conversation} />);
    fireEvent.click(screen.getByTestId('conversation-action-approve'));
    const alert = await screen.findByTestId('conversation-action-error');
    expect(alert.textContent).toBe('GitHub does not let you review your own pull request');
  });

  it('offers each action by its `when` against ended_at', () => {
    const actions: IActionSpec[] = [
      { id: 'approve', label: 'Approve' },
      { id: 'reopen', label: 'Reopen', when: 'ended' },
      { id: 'open_web', label: 'Open', when: 'any' },
    ];
    const shown = () => ['approve', 'reopen', 'open_web'].filter((id) => screen.queryByTestId(`conversation-action-${id}`));
    render(<ConversationActions conversation={conversationWith(actions).conversation} />);
    expect(shown()).toEqual(['approve', 'open_web']);
    cleanup();
    render(
      <ConversationActions conversation={conversationWith(actions, { ended_at: new Date().toISOString() }).conversation} />,
    );
    expect(shown()).toEqual(['reopen', 'open_web']);
  });
});

describe('ConversationEndedLine', () => {
  it('shows a muted Ended line only when ended_at is set', () => {
    const { rerender } = render(<ConversationEndedLine endedAt={null} />);
    expect(screen.queryByTestId('conversation-ended')).toBeNull();
    rerender(<ConversationEndedLine endedAt={new Date(Date.now() - 5 * 60_000).toISOString()} />);
    expect(screen.getByTestId('conversation-ended').textContent).toMatch(/^Ended · /);
  });
});
