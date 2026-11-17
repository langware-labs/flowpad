import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk/entities/notifications', () => ({
  sendReply: vi.fn(() => Promise.resolve({ id: 'm1' })),
  sendToChannel: vi.fn(),
}));
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

import { sendReply } from '@sdk/entities/notifications';
import { MessageComposer } from '@src/components/conversation/MessageComposer';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000009';
const PEOPLE = [
  { user_id: 'u-me', name: 'Gadi Tunes' },
  { user_id: 'u-sys', name: 'System' },
];

function typeInto(box: HTMLElement, value: string) {
  const textarea = box as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe('MessageComposer — tagging', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(sendReply).mockClear();
  });

  it('@ offers the other members, a pick writes the name, and the send carries the id', async () => {
    render(<MessageComposer conversationId={CONV} mentionable={PEOPLE} viewerId="u-me" />);
    const box = screen.getByPlaceholderText('Reply to sender…');

    typeInto(box, '@');
    expect(screen.getAllByTestId('mention-option').map((o) => o.textContent)).toEqual(['@System']);

    fireEvent.mouseDown(screen.getByTestId('mention-option'));
    expect((box as HTMLTextAreaElement).value).toBe('@System ');
    expect(screen.queryByTestId('mention-list')).toBeNull();

    typeInto(box, '@System check this');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    const [, body, , extras] = vi.mocked(sendReply).mock.calls[0];
    expect(body).toBe('@System check this');
    expect(extras).toMatchObject({ mentions: ['u-sys'] });
  });

  it('a name edited out of the text is not sent as a tag', async () => {
    render(<MessageComposer conversationId={CONV} mentionable={PEOPLE} viewerId="u-me" />);
    const box = screen.getByPlaceholderText('Reply to sender…');
    typeInto(box, '@sy');
    fireEvent.mouseDown(screen.getByTestId('mention-option'));

    typeInto(box, 'never mind');
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendReply).mock.calls[0][3]).toBeUndefined();
  });

  it('without members there is no list', () => {
    render(<MessageComposer conversationId={CONV} />);
    typeInto(screen.getByPlaceholderText('Reply to sender…'), '@sys');
    expect(screen.queryByTestId('mention-list')).toBeNull();
  });
});
