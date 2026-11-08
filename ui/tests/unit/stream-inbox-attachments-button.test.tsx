/**
 * The StreamInbox row's paperclip: one request when opened, and a file click does what clicking it in
 * the message does — open the local file — else opens the conversation at that message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { openDock, attachments } = vi.hoisted(() => ({ openDock: vi.fn(), attachments: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openDock } }) }));
vi.mock('@sdk/entities/conversation', () => ({ Conversation: { attachments } }));

import { ConversationAttachmentsButton } from '@src/components/stream-inbox-view/ConversationAttachmentsButton';
import { dockPointerForLocalFile } from '@src/components/conversation/attachment-url';
import { DockPointer } from '@src/navigation/DockPointer';

const CONV = 'c0000000-0000-4000-8000-000000000001';
const MSG = 'm0000000-0000-4000-8000-000000000002';
const file = (local_path: string | null) => ({
  message_id: MSG,
  ts: '2026-11-07T10:00:00+00:00',
  attachment: { attachment_type: 'file', data: 'files/report.pdf', local_path },
});

async function openAndClick(local: string | null) {
  attachments.mockResolvedValueOnce([file(local)]);
  render(<ConversationAttachmentsButton conversationId={CONV} count={1} />);
  expect(screen.getByTestId('stream-inbox-row-attachments').textContent).toContain('1');
  fireEvent.click(screen.getByTestId('stream-inbox-row-attachments'));
  fireEvent.click(await screen.findByText('report.pdf'));
  expect(attachments).toHaveBeenCalledTimes(1);
}

describe('ConversationAttachmentsButton', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens a local file the way its message chip does', async () => {
    await openAndClick('/data/report.pdf');
    expect(openDock).toHaveBeenCalledWith(dockPointerForLocalFile('/data/report.pdf'));
  });

  it('opens the conversation at the message when the file is not on this machine', async () => {
    await openAndClick(null);
    expect(openDock).toHaveBeenCalledWith(DockPointer.forConversation(CONV, { messageId: MSG }));
  });
});
