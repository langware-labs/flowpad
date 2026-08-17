/**
 * Sharing a sandbox that was never started.
 *
 * The failure this guards is not a crash: it is a link that works for the sender
 * and is inert for the recipient. A plain share grants `admin`, `ops` resolves
 * for `owner` alone, so the recipient's landing page tries to launch and the hub
 * refuses — and there is nothing they can do about it. The fix has to happen on
 * the sender's side, so the dialog asks before it sends.
 *
 * The wire contract of the send itself lives in `unit/share-sandbox.test.ts`;
 * this only covers WHETHER and WITH WHAT ROLE it is reached.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { ComputeNode } from '@sdk';
import { ShareSandboxDialog } from '@src/pages/hub-home/ShareSandboxDialog';

const shareSandboxByEmail = vi.fn();

vi.mock('@src/pages/hub-home/share-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/pages/hub-home/share-sandbox')>();
  return { ...actual, shareSandboxByEmail: (...args: unknown[]) => shareSandboxByEmail(...args) };
});

// The picker needs project/auth context this test has no business standing up;
// it is replaced by an input that yields one recipient, which is all the dialog
// reads from it.
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({ onChange, testId }: { onChange: (v: unknown[]) => void; testId?: string }) => (
    <button data-testid={testId} onClick={() => onChange([{ email: 'bob@example.com' }])}>
      pick
    </button>
  ),
}));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const NODE_ID = '11111111-2222-4333-8444-555555555555';

/** `node_provider_id` is what `isLaunched` reads, and the only difference here. */
function node(launched: boolean): ComputeNode {
  return new ComputeNode({
    id: NODE_ID,
    name: 'Desktop 1',
    ...(launched ? { node_provider_id: 'e2b-abc123' } : {}),
  });
}

function open(sandbox: ComputeNode, onLaunchInstead?: () => void) {
  return render(
    <ShareSandboxDialog
      open
      onOpenChange={() => {}}
      sandbox={sandbox}
      isOwner
      currentUserEmail="alice@example.com"
      onLaunchInstead={onLaunchInstead}
    />,
  );
}

/** Pick a recipient, then press Share. */
function shareWithBob() {
  fireEvent.click(screen.getByTestId('share-sandbox-input'));
  fireEvent.click(screen.getByTestId('share-sandbox-submit'));
}

function sentAs(): { transfer?: boolean; role?: string } {
  return (shareSandboxByEmail.mock.calls.at(-1)?.[2] ?? {}) as { transfer?: boolean; role?: string };
}

beforeEach(() => {
  shareSandboxByEmail.mockReset();
  shareSandboxByEmail.mockResolvedValue({ granted: ['bob@example.com'], failed: [] });
});

// The unit tier's setup has no RTL cleanup of its own, and every case here
// renders the same dialog — without this the second one finds two of everything.
afterEach(cleanup);

describe('sharing a sandbox that was never launched', () => {
  it('warns in the dialog before anything is clicked', () => {
    open(node(false));
    expect(screen.queryByTestId('share-sandbox-unlaunched-note')).toBeTruthy();
  });

  it('does not warn about a box that is already launched', () => {
    open(node(true));
    expect(screen.queryByTestId('share-sandbox-unlaunched-note')).toBeNull();
  });

  it('holds the share back and asks first', async () => {
    open(node(false));
    shareWithBob();

    expect(await screen.findByTestId('share-sandbox-unlaunched-confirm')).toBeTruthy();
    expect(shareSandboxByEmail).not.toHaveBeenCalled();
  });

  it('sends straight through when the box is already launched', async () => {
    open(node(true));
    shareWithBob();

    await waitFor(() => expect(shareSandboxByEmail).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('share-sandbox-unlaunched-confirm')).toBeNull();
    expect(sentAs().transfer).toBe(false);
  });

  it('turns "hand it over" into a transfer, in one click', async () => {
    open(node(false));
    shareWithBob();

    fireEvent.click(await screen.findByTestId('share-sandbox-unlaunched-handover'));

    await waitFor(() => expect(shareSandboxByEmail).toHaveBeenCalledTimes(1));
    expect(sentAs().transfer).toBe(true);
  });

  it('still sends a plain share on "share anyway"', async () => {
    open(node(false));
    shareWithBob();

    fireEvent.click(await screen.findByTestId('share-sandbox-unlaunched-share-anyway'));

    await waitFor(() => expect(shareSandboxByEmail).toHaveBeenCalledTimes(1));
    expect(sentAs().transfer).toBe(false);
  });

  it('sends nothing when the sender goes off to start it first', async () => {
    const onLaunchInstead = vi.fn();
    open(node(false), onLaunchInstead);
    shareWithBob();

    fireEvent.click(await screen.findByTestId('share-sandbox-unlaunched-launch'));

    expect(onLaunchInstead).toHaveBeenCalledTimes(1);
    expect(shareSandboxByEmail).not.toHaveBeenCalled();
  });

  it('offers no way to start it when the caller cannot', async () => {
    open(node(false));
    shareWithBob();

    await screen.findByTestId('share-sandbox-unlaunched-confirm');
    expect(screen.queryByTestId('share-sandbox-unlaunched-launch')).toBeNull();
  });

  it('asks for a recipient before it warns about anything', () => {
    render(
      <ShareSandboxDialog
        open
        onOpenChange={() => {}}
        sandbox={node(false)}
        isOwner
        currentUserEmail="a@example.com"
      />,
    );
    fireEvent.click(screen.getByTestId('share-sandbox-submit'));

    expect(screen.queryByTestId('share-sandbox-unlaunched-confirm')).toBeNull();
    expect(shareSandboxByEmail).not.toHaveBeenCalled();
  });
});
