/**
 * One thread model in the composer and the thread view: a reply quotes the message it answers
 * and joins its thread on Flowpad's own chat as on every channel; an open thread's composer
 * writes into that thread (a native root without quoting, a channel thread's newest message);
 * the thread header names the thread and leads back to every message.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({
  sendReply: vi.fn(() => Promise.resolve({ id: 'sent-1' })),
  sendToChannel: vi.fn(() => Promise.resolve()),
}));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' }, updateName: vi.fn() }) }));
vi.mock('@src/components/asset-manager/AssetManagerPopover', () => ({ AssetManagerPopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</> }));
vi.mock('@src/components/conversation/EmojiPicker', () => ({
  EmojiPicker: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock('@src/components/conversation/AttachMenu', () => ({
  AssetRefChips: () => null,
  useAssetRefSelection: () => ({ selectedTypeIds: [] }),
}));

import { sendReply, sendToChannel } from '@sdk/entities/notifications';
import { MessageComposer } from '@src/components/conversation/MessageComposer';
import { ThreadHeader } from '@src/components/conversation/ThreadHeader';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000011';

function type(text: string, placeholder = 'Write here') {
  const box = screen.getByPlaceholderText(placeholder);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

describe('composer in a thread', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("a native reply carries the answered message's id and clears the banner", async () => {
    const onClearReply = vi.fn();
    render(
      <MessageComposer
        conversationId={CONV}
        placeholder="Write here"
        replyTo={{ id: 'fm-root', sender: 'Ron', text: 'take a snapshot' }}
        onClearReply={onClearReply}
      />,
    );
    expect(screen.getByTestId('composer-reply-banner').textContent).toContain('Replying to Ron');
    type('which home?');
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const [, text, , extras] = vi.mocked(sendReply).mock.calls[0];
    expect(text).toBe('which home?');
    expect(extras?.replyToId).toBe('fm-root');
    expect(extras?.threadRootId).toBeUndefined();
    expect(onClearReply).toHaveBeenCalled();
  });

  it('an open native thread writes into its root without quoting', async () => {
    render(<MessageComposer conversationId={CONV} placeholder="Write here" threadTarget={{ title: 'take a snapshot', rootId: 'fm-root' }} />);
    expect(screen.getByTestId('composer-thread-banner').textContent).toContain('take a snapshot');
    type('done');
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const extras = vi.mocked(sendReply).mock.calls[0][3];
    expect(extras?.threadRootId).toBe('fm-root');
    expect(extras?.replyToId).toBeUndefined();
  });

  it('an explicit reply inside an open thread quotes it (the thread follows the quote)', async () => {
    render(
      <MessageComposer
        conversationId={CONV}
        placeholder="Write here"
        threadTarget={{ title: 't', rootId: 'fm-root' }}
        replyTo={{ id: 'fm-2', sender: 'Ron', text: 'second' }}
      />,
    );
    expect(screen.queryByTestId('composer-thread-banner')).toBeNull();
    type('answer');
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const extras = vi.mocked(sendReply).mock.calls[0][3];
    expect(extras?.replyToId).toBe('fm-2');
    expect(extras?.threadRootId).toBeUndefined();
  });

  it("an open email/Slack thread answers its newest message, which is how the provider threads it", async () => {
    render(<MessageComposer conversationId={CONV} channel="slack" placeholder="Write here" threadTarget={{ title: '#ops › deploy', answerId: 'fm-newest' }} />);
    type('on it');
    await waitFor(() => expect(sendToChannel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendToChannel).mock.calls[0][3]?.replyToId).toBe('fm-newest');
  });

  it("a quoting channel's open thread is the chat itself: a plain send quotes nobody", async () => {
    render(<MessageComposer conversationId={CONV} channel="whatsapp" placeholder="Write here" threadTarget={{ title: 'Dana' }} />);
    type('hi');
    await waitFor(() => expect(sendToChannel).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendToChannel).mock.calls[0][3]?.replyToId).toBeNull();
  });
});

describe('thread header', () => {
  afterEach(() => cleanup());

  it('names the thread, counts it, and leads back to every message', () => {
    const onShowAll = vi.fn();
    render(<ThreadHeader title="Re: invoice" messageCount={3} onShowAll={onShowAll} />);
    expect(screen.getByTestId('thread-header-title').textContent).toBe('Re: invoice');
    expect(screen.getByTestId('thread-header-count').textContent).toContain('3');
    fireEvent.click(screen.getByTestId('thread-header-all'));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('while its row loads it shows no count, and an untitled thread still reads as a thread', () => {
    render(<ThreadHeader title="" messageCount={null} />);
    expect(screen.queryByTestId('thread-header-count')).toBeNull();
    expect(screen.getByTestId('thread-header-title').textContent).toBe('Thread');
  });
});
