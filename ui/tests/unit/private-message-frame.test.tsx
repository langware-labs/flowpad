/**
 * A private message in the feed: marked as seen by this person only, read once shown, and one click from
 * being shared with everyone or dismissed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowMessage } from '@sdk';

const { updateMessage } = vi.hoisted(() => ({ updateMessage: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@src/components/stream-inbox-view/stream-inbox-api', () => ({ updateMessage }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => () => Promise.resolve({ ok: true }) }));
vi.mock('@sdk/entities/notifications', () => ({ sendToChannel: vi.fn() }));
vi.mock('@src/components/conversation/flow-message-drafts', () => ({ draftFiles: () => Promise.resolve([]) }));

import { PrivateMessageFrame } from '@src/components/conversation/PrivateMessageFrame';

afterEach(cleanup);

const message = () =>
  ({ id: 'm1', conversation_id: 'c1', text: 'note', is_read: false, sendDraft: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) }) as unknown as FlowMessage;

describe('a private message', () => {
  it('is read once shown, and Share sends the same message', async () => {
    const fm = message();
    const onDone = vi.fn();
    render(<PrivateMessageFrame fm={fm} onDone={onDone}>the message</PrivateMessageFrame>);
    expect(screen.getByTestId('private-message').textContent).toContain('the message');
    expect(updateMessage).toHaveBeenCalledWith('m1', { is_read: true });
    fireEvent.click(screen.getByTestId('private-message-share'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fm.sendDraft).toHaveBeenCalled();
    expect(fm.delete).not.toHaveBeenCalled();
  });

  it('Dismiss deletes it and sends nothing', async () => {
    const fm = message();
    render(<PrivateMessageFrame fm={fm}>the message</PrivateMessageFrame>);
    fireEvent.click(screen.getByTestId('private-message-dismiss'));
    await waitFor(() => expect(fm.delete).toHaveBeenCalled());
    expect(fm.sendDraft).not.toHaveBeenCalled();
  });
});
