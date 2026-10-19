/**
 * `/wrong_account` has two senders, and for one of them the name is a lie.
 *
 * `members/accept` redirects here on an email MISMATCH — a genuinely wrong
 * account — and sets `callback` to its own accept URL.
 *
 * `wrong_account_page_for_navigation` (hub `core/auth/authorizer.py`) redirects
 * here when a caller who IS signed in holds no role on the entity they followed a
 * link to, and sets `callback` to that link. Its own docstring calls this the
 * common case: "the recipient's first click frequently arrives AUTHENTICATED — as
 * somebody who was never invited — and lands here."
 *
 * Three staging sessions were spent on that second case telling the right person
 * to sign in as somebody else. The callback is what tells them apart.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cloudManager: { logout: vi.fn() },
    navigator: { getLoginWithCallbackUrl: vi.fn(() => '/login') },
  };
});

const { default: WrongAccountPage } = await import('@src/pages/entry/WrongAccountPage');

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const HUB = 'https://staging.flowpad.ai';

function renderAt(callback: string) {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, href: `${HUB}/wrong_account?callback=${encodeURIComponent(callback)}`, origin: HUB },
  });
  const view = render(<WrongAccountPage />);
  return { view, restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }) };
}

afterEach(cleanup);

describe('wrong_account — which refusal is this', () => {
  it('says WRONG ACCOUNT when the invitation went to another address', () => {
    // Sent by `members/accept`: the signed-in email does not match the invite.
    const { restore } = renderAt(`${HUB}/api/v1/graph/members/accept?invitation-id=inv-1`);

    expect(screen.getByText('Wrong account')).toBeTruthy();
    expect(screen.getByText(/sent to a different email address/i)).toBeTruthy();
    restore();
  });

  it('says NO ACCESS YET when they are the right person without a role', () => {
    // Sent by the authorizer for a signed-in caller with no role on the node.
    // Telling this person to switch accounts is the bug: they are already correct.
    const { restore } = renderAt(`${HUB}/api/v1/graph/compute_node/${NODE_ID}/open-service/workspace`);

    expect(screen.getByText('You do not have access to this yet')).toBeTruthy();
    expect(screen.queryByText('Wrong account')).toBeNull();
    // Names the actual next step — accepting — while still offering the switch.
    expect(screen.getByText(/accept it first/i)).toBeTruthy();
    restore();
  });

  it('reads the PATH, so an id that merely contains the word does not fool it', () => {
    // A substring search over the whole URL would call this an accept.
    const { restore } = renderAt(`${HUB}/api/v1/graph/compute_node/${NODE_ID}?x=/members/accept`);

    expect(screen.getByText('You do not have access to this yet')).toBeTruthy();
    restore();
  });

  it('falls back to the SAFER message when there is nothing to reason from', () => {
    // Both senders always set `callback`, so its absence is an anomaly and we
    // genuinely cannot tell. The tie goes to the message that covers both — it
    // names accepting AND offers the account switch — because the other one
    // asserts a specific wrong thing and sends a correctly-signed-in person off
    // to fix nothing. Wrong-and-confident is the failure mode being removed here.
    //
    // (`WrongAccountPanel`'s own default stays 'wrong-account' for its other
    // callers, `MessageLanding` and `InvitePage`, where a mismatch IS the meaning.)
    const { restore } = renderAt('');

    expect(screen.getByText('You do not have access to this yet')).toBeTruthy();
    restore();
  });
});
