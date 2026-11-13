import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

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
import { mockMobile } from '../utils/test-utils';

const CONV = 'c0c0c0c0-0000-4000-8000-000000000009';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(sendReply).mockClear();
});

it('on a touch keyboard Enter is a newline; the send button sends', async () => {
  mockMobile(true);
  render(<MessageComposer conversationId={CONV} />);
  const box = screen.getByPlaceholderText('Reply to sender…');
  fireEvent.change(box, { target: { value: 'line one' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(sendReply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle('Send'));
  await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
});

it('with a mouse and keyboard Enter still sends', async () => {
  mockMobile(false);
  render(<MessageComposer conversationId={CONV} />);
  const box = screen.getByPlaceholderText('Reply to sender…');
  fireEvent.change(box, { target: { value: 'hi' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1));
});
