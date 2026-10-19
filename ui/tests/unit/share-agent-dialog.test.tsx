/** The share-an-agent dialog: sends the picked addresses, closes on success, stays open on failure. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareAgentDialog } from '@src/components/assets/editor/agent-profile/ShareAgentDialog';

const shareAgentByEmail = vi.fn();

vi.mock('@src/components/assets/editor/agent-profile/share-agent', () => ({
  shareAgentByEmail: (...args: unknown[]) => shareAgentByEmail(...args),
}));
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ currentUser: { id: 'u1', email: 'me@example.com' } }) }));
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({ onChange, testId }: { onChange: (v: unknown[]) => void; testId?: string }) => (
    <button data-testid={testId} onClick={() => onChange([{ email: 'bob@example.com' }])}>
      pick
    </button>
  ),
}));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const agent = { id: 'a1', name: 'crm', getDisplayName: () => 'CRM manager' } as never;

function renderDialog() {
  const onOpenChange = vi.fn();
  render(<ShareAgentDialog open onOpenChange={onOpenChange} agent={agent} />);
  return { onOpenChange };
}

describe('ShareAgentDialog', () => {
  beforeEach(() => shareAgentByEmail.mockReset());
  afterEach(cleanup);

  it('sends the picked address and closes on success', async () => {
    shareAgentByEmail.mockResolvedValue({ granted: ['bob@example.com'], failed: [] });
    const { onOpenChange } = renderDialog();

    expect(screen.getByTestId('share-agent-dialog').textContent).toContain('Share CRM manager');
    fireEvent.click(screen.getByTestId('share-agent-input'));
    fireEvent.click(screen.getByTestId('share-agent-submit'));

    await waitFor(() => expect(shareAgentByEmail).toHaveBeenCalledWith(agent, ['bob@example.com']));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open and names the address when one fails', async () => {
    shareAgentByEmail.mockResolvedValue({
      granted: [],
      failed: [{ email: 'bob@example.com', reason: 'Only the agent’s owner can share it' }],
    });
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByTestId('share-agent-input'));
    fireEvent.click(screen.getByTestId('share-agent-submit'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bob@example.com'));
    expect(screen.getByRole('alert').textContent).toContain('Only the agent’s owner can share it');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('refuses to send with nobody picked', async () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('share-agent-submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(shareAgentByEmail).not.toHaveBeenCalled();
  });
});
