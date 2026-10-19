/**
 * The live strip under a channel conversation — generic for every message source: the agent's run
 * answering the channel is observed and drawn as it works, and on a live call the caller's sentence
 * shows while they are still saying it, until the finished sentence lands as a message.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@sdk';

const observed = vi.fn();
vi.mock('@src/components/entity-execution-panel/hooks/useObservedTurn', () => ({ useObservedTurn: (run: unknown) => observed(run) }));
vi.mock('@src/components/entity-execution-panel/ChatActivityLine', () => ({
  ChatActivityLine: ({ process }: { process: { id: string } }) => <div data-testid="chat-activity-line" data-run={process.id} />,
}));

import { ConversationLiveActivity } from '@src/components/conversation/ConversationLiveActivity';

const CONV = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const run = { id: 'run-1' } as never;
const partial = (conversation: string, text: string) =>
  act(() => void EventBus.emit('voice.call.partial', `conversation:${conversation}`, { conversation_id: conversation, text }));

describe('ConversationLiveActivity', () => {
  beforeEach(() => {
    EventBus.clear();
    observed.mockReset();
  });
  afterEach(cleanup);

  it("observes the conversation's run and draws its activity line", () => {
    render(<ConversationLiveActivity conversationId={CONV} run={run} messageCount={3} />);
    expect(observed).toHaveBeenCalledWith(run);
    expect(screen.getByTestId('chat-activity-line').dataset.run).toBe('run-1');
  });

  it('with no run yet there is nothing to draw — and nothing to observe', () => {
    render(<ConversationLiveActivity conversationId={CONV} run={null} messageCount={0} />);
    expect(observed).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId('chat-activity-line')).toBeNull();
  });

  it("shows the caller's sentence as it grows, only this conversation's, until the message lands", () => {
    const { rerender } = render(<ConversationLiveActivity conversationId={CONV} run={null} messageCount={2} />);
    partial(CONV, 'What is on');
    expect(screen.getByTestId('voice-partial').textContent).toBe('What is on');
    partial(CONV, 'What is on my plate today?');
    partial(OTHER, 'someone else');
    expect(screen.getByTestId('voice-partial').textContent).toBe('What is on my plate today?');
    rerender(<ConversationLiveActivity conversationId={CONV} run={null} messageCount={3} />);
    expect(screen.queryByTestId('voice-partial')).toBeNull();
  });
});
