/**
 * A channel conversation's files, quotes and reactions in the UI — every control gated by the
 * channel's traits (`ChannelSpec.accepts_attachments` / `quotes` / `reacts`), never a channel name.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({ sendReply: vi.fn(), sendToChannel: vi.fn() }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({ useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' }, updateName: vi.fn() }) }));
vi.mock('@src/components/asset-manager/AssetManagerPopover', () => ({ AssetManagerPopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</> }));
vi.mock('@src/components/conversation/EmojiPicker', () => ({
  EmojiPicker: ({ trigger, onPick }: { trigger: React.ReactNode; onPick: (e: string) => void }) => (
    <span>
      {trigger}
      <button type="button" data-testid="pick-thumbs" onClick={() => onPick('👍')}>
        pick
      </button>
    </span>
  ),
}));
vi.mock('@src/components/conversation/AttachMenu', () => ({
  AssetRefChips: () => null,
  useAssetRefSelection: () => ({ selectedTypeIds: [] }),
}));
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (f: File[]) => Promise.resolve({ files: f, caption: '' }),
}));

import { sendToChannel } from '@sdk/entities/notifications';
import { MessageComposer } from '@src/components/conversation/MessageComposer';
import { ChannelMessageActions, QuotedMessage, ReactionChips } from '@src/components/conversation/ChannelMessageExtras';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000007';

describe('channel composer', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('a channel that takes no files keeps the paperclip off; one that does turns it on', () => {
    const { rerender } = render(<MessageComposer conversationId={CONV} channel="slack" />);
    expect((screen.getByTestId('attach-file-button') as HTMLButtonElement).disabled).toBe(true);
    rerender(<MessageComposer conversationId={CONV} channel="whatsapp" channelAcceptsFiles />);
    expect((screen.getByTestId('attach-file-button') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('attach-asset-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a reply banner names the quoted message, and the send carries its id and the files', async () => {
    const onClearReply = vi.fn();
    render(
      <MessageComposer
        conversationId={CONV}
        channel="whatsapp"
        channelAcceptsFiles
        replyTo={{ id: 'fm-1', sender: 'Dana', text: 'is Tuesday ok?' }}
        onClearReply={onClearReply}
        placeholder="Reply in WhatsApp"
      />,
    );
    expect(screen.getByTestId('composer-reply-banner').textContent).toContain('Replying to Dana');
    const photo = new File([new Uint8Array([0xff, 0xd8])], 'site.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [photo] } });
    await waitFor(() => expect(screen.getByText('site.jpg')).toBeTruthy());
    const box = screen.getByPlaceholderText('Reply in WhatsApp');
    fireEvent.change(box, { target: { value: 'Tuesday works' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendToChannel).toHaveBeenCalledTimes(1));
    const [conv, text, , extras] = vi.mocked(sendToChannel).mock.calls[0];
    expect(conv).toBe(CONV);
    expect(text).toBe('Tuesday works');
    expect(extras?.replyToId).toBe('fm-1');
    expect(extras?.files?.map((f) => f.name)).toEqual(['site.jpg']);
    expect(onClearReply).toHaveBeenCalled();
  });

  it('on a thread-only channel the banner says so', () => {
    render(<MessageComposer conversationId={CONV} channel="slack" replyTo={{ id: 'x', sender: 'Dana', text: 'q', inThread: true }} />);
    expect(screen.getByTestId('composer-reply-banner').textContent).toContain('Replying in the thread of Dana');
  });
});

describe('channel message extras', () => {
  afterEach(() => cleanup());

  it('reactions group by emoji with a count, ours is pressed, and clicking toggles', () => {
    const onToggle = vi.fn();
    render(
      <ReactionChips
        reactions={[
          { emoji: '👍', by: 'dana' },
          { emoji: '👍', by: 'self', ours: true },
          { emoji: '❤️', by: 'lee', by_name: 'Lee' },
        ]}
        onToggle={onToggle}
      />,
    );
    const thumbs = screen.getByTestId('reaction-👍');
    expect(thumbs.textContent).toContain('2');
    expect(thumbs.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('reaction-❤️').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(thumbs);
    expect(onToggle).toHaveBeenCalledWith('👍', true);
  });

  it('Reply says "in thread" where the channel only threads; React hands the picked emoji up', () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    render(<ChannelMessageActions onReply={onReply} replyInThread onReact={onReact} />);
    expect(screen.getByTestId('message-reply').getAttribute('aria-label')).toBe('Reply in thread');
    fireEvent.click(screen.getByTestId('pick-thumbs'));
    expect(onReact).toHaveBeenCalledWith('👍');
    fireEvent.click(screen.getByTestId('message-reply'));
    expect(onReply).toHaveBeenCalled();
  });

  it('a quote shows who and what, and jumps to the original', () => {
    const onJump = vi.fn();
    render(<QuotedMessage sender="Dana" text="is Tuesday ok?" onJump={onJump} />);
    const quote = screen.getByTestId('message-quote');
    expect(quote.textContent).toContain('Dana');
    expect(quote.textContent).toContain('is Tuesday ok?');
    fireEvent.click(quote);
    expect(onJump).toHaveBeenCalled();
  });
});
