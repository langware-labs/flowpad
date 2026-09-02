/**
 * The share-a-budget dialog: what it sends, and what it does with the answer.
 *
 * The wire contract of the send lives in `unit/share-endpoint.test.ts`; this covers the behaviour
 * around it — that a partial failure keeps the dialog open with the addresses named, and that a
 * clean run closes. Getting that backwards is how someone ends up believing they shared a budget
 * with four people when one of them silently bounced.
 *
 * Dropping the sender's own address is `pickInvitableEmails`' contract, covered by the sandbox
 * suite that owns it; the dialog only supplies the signed-in email it reads from `useAuth`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareEndpointDialog } from '@src/components/llm-endpoints/ShareEndpointDialog';

const shareEndpointByEmail = vi.fn();

// The dialog consumes exactly one export from this module, so there is nothing to preserve.
vi.mock('@src/components/llm-endpoints/share-endpoint', () => ({
  shareEndpointByEmail: (...args: unknown[]) => shareEndpointByEmail(...args),
}));

// Identity is ambient (the dialog reads it itself), so it is stubbed rather than passed in.
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ currentUser: { id: 'u1', email: 'me@example.com' } }) }));

// The picker needs auth context this test has no business standing up; it is replaced by a button
// that yields one recipient, which is all the dialog reads from it.
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({ onChange, testId }: { onChange: (v: unknown[]) => void; testId?: string }) => (
    <button data-testid={testId} onClick={() => onChange([{ email: 'bob@example.com' }])}>
      pick
    </button>
  ),
}));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const endpoint = { id: 'ep-1', name: 'team budget' } as never;

function renderDialog(overrides: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const onShared = vi.fn();
  render(
    <ShareEndpointDialog open onOpenChange={onOpenChange} endpoint={endpoint} onShared={onShared} {...overrides} />,
  );
  return { onOpenChange, onShared };
}

describe('ShareEndpointDialog', () => {
  beforeEach(() => shareEndpointByEmail.mockReset());
  afterEach(cleanup);

  it('sends the picked address and closes on success', async () => {
    shareEndpointByEmail.mockResolvedValue({ granted: ['bob@example.com'], failed: [] });
    const { onOpenChange, onShared } = renderDialog();

    fireEvent.click(screen.getByTestId('share-endpoint-input'));
    fireEvent.click(screen.getByTestId('share-endpoint-submit'));

    await waitFor(() => expect(shareEndpointByEmail).toHaveBeenCalledWith(endpoint, ['bob@example.com']));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onShared).toHaveBeenCalled();
  });

  it('stays open and names the address when one fails', async () => {
    // Closing here would report success for a share that did not happen.
    shareEndpointByEmail.mockResolvedValue({
      granted: [],
      failed: [{ email: 'bob@example.com', reason: 'Only the budget’s owner can share it' }],
    });
    const { onOpenChange, onShared } = renderDialog();

    fireEvent.click(screen.getByTestId('share-endpoint-input'));
    fireEvent.click(screen.getByTestId('share-endpoint-submit'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bob@example.com'));
    expect(screen.getByRole('alert').textContent).toContain('Only the budget’s owner can share it');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onShared).not.toHaveBeenCalled();
  });

  it('refuses to send with nobody picked', async () => {
    renderDialog();

    fireEvent.click(screen.getByTestId('share-endpoint-submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(shareEndpointByEmail).not.toHaveBeenCalled();
  });

  it('says what the recipient may spend', async () => {
    // One pot, not one allowance each. This screen is otherwise entirely about limiting spend, so
    // the moment money changes hands is where that has to be restated.
    renderDialog();

    expect(screen.getByTestId('share-endpoint-dialog').textContent).toContain('same limits');
  });
});
