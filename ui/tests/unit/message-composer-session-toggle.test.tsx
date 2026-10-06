import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({ sendReply: vi.fn(), sendToChannel: vi.fn() }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: { id: 'me', name: 'Me' }, updateName: vi.fn() }),
}));
vi.mock('@src/components/asset-manager/AssetManagerPopover', () => ({
  AssetManagerPopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock('@src/components/conversation/EmojiPicker', () => ({
  EmojiPicker: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock('@src/components/conversation/AttachMenu', () => ({
  AssetRefChips: () => null,
  useAssetRefSelection: () => ({ selectedTypeIds: [] }),
}));
vi.mock('@src/components/image-annotator/annotate-files', () => ({
  annotateImageFiles: (f: File[]) => Promise.resolve({ files: f, caption: '' }),
}));

import { sendReply } from '@sdk/entities/notifications';
import { MessageComposer } from '@src/components/conversation/MessageComposer';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000005';
const host = { userId: 'a0a0a0a0-0000-4000-8000-000000000002', name: 'Sam' };

describe('MessageComposer session toggle', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('no sessionHost → no toggle, a plain send has no prompt extras', async () => {
    render(<MessageComposer conversationId={CONV} />);
    expect(screen.queryByTestId('composer-session-toggle')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Reply to sender…'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Reply to sender…'), { key: 'Enter' });
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendReply).mock.calls[0][1]).toBe('hi');
    expect(vi.mocked(sendReply).mock.calls[0][3]).toBeUndefined();
  });

  it('the live-session icon opens the session — it is not a typing mode', () => {
    const onStartLiveSession = vi.fn();
    render(<MessageComposer conversationId={CONV} sessionHost={host} onStartLiveSession={onStartLiveSession} />);
    const toggle = screen.getByTestId('composer-session-toggle');
    expect(toggle.getAttribute('title')).toBe("Start a live session on Sam's machine");
    fireEvent.click(toggle);
    expect(onStartLiveSession).toHaveBeenCalledTimes(1);
    // No mode strip, no prompt placeholder: the box stays a chat box.
    expect(screen.queryByTestId('composer-session-mode')).toBeNull();
    expect(screen.getByPlaceholderText('Reply to sender…')).toBeTruthy();
  });

  it('with an open session the icon says it opens that one', () => {
    render(
      <MessageComposer
        conversationId={CONV}
        sessionHost={{ ...host, hasOpenSession: true }}
        onStartLiveSession={vi.fn()}
      />,
    );
    expect(screen.getByTestId('composer-session-toggle').getAttribute('title')).toBe(
      "Open the live session on Sam's machine",
    );
  });

  it('the terminal variant is a ❯ prompt line with the cursor waiting in it', () => {
    render(
      <MessageComposer
        conversationId={CONV}
        liveSessionId="sid-1"
        variant="terminal"
        autoFocus
        placeholder="Prompt for Claude Code on Sam's machine…"
      />,
    );
    const box = screen.getByTestId('live-session-input');
    expect(box.getAttribute('placeholder')).toBe("Prompt for Claude Code on Sam's machine…");
    expect(document.activeElement).toBe(box);
    expect(screen.getByText('❯')).toBeTruthy();
  });

  it('inside a session view every send is a follow-up turn stamped with the session id', async () => {
    render(<MessageComposer conversationId={CONV} liveSessionId="sid-1" />);
    expect(screen.queryByTestId('composer-session-toggle')).toBeNull();
    const box = screen.getByPlaceholderText('Reply to sender…');
    fireEvent.change(box, { target: { value: 'again' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendReply).mock.calls[0][3]).toEqual({ promptText: 'again', remoteWorkerSessionId: 'sid-1' });
  });
});
