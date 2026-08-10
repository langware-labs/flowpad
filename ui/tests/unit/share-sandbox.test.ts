/**
 * Sharing a desktop by email — the wire contract and the pure decisions.
 *
 * The hub half of this contract is pinned in
 * `hub/tests/api/test_ownership_transfer.py` and `unit/test_can_assign.py`.
 * Neither side catches drift alone: the hub can only see what arrives, and this
 * can only see what is sent.
 *
 * The transport is the only thing mocked. `inviteMember`, `shareSandboxByEmail`
 * and the helpers under test all run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComputeNode, dataManager } from '@sdk';
import {
  SANDBOX_SHARE_ROLE,
  sandboxShareLandingPath,
  pickInvitableEmails,
  shareSandboxByEmail,
  shareFailureText,
  sandboxShareLink,
} from '@src/pages/hub-home/share-sandbox';

const NODE_ID = '11111111-2222-4333-8444-555555555555';

let callAction: ReturnType<typeof vi.spyOn>;

function node(): ComputeNode {
  return new ComputeNode({ id: NODE_ID, name: 'Desktop 1' });
}

function lastBody(): Record<string, unknown> {
  const info = callAction.mock.calls.at(-1)?.[0] as { bodyParameters?: Record<string, unknown> };
  return info?.bodyParameters ?? {};
}

beforeEach(() => {
  callAction = vi.spyOn(dataManager, 'callAction');
  callAction.mockResolvedValue([] as never);
});

afterEach(() => {
  callAction.mockRestore();
});

describe('the landing path', () => {
  it('satisfies the hub validator that would otherwise 400 the invite', () => {
    // `is_safe_app_path`: leading slash, not protocol-relative, no scheme.
    // An absolute URL here is rejected at invite time with a 400, so this is
    // the constraint that decides the shape of the whole value.
    const path = sandboxShareLandingPath(NODE_ID);

    expect(path.startsWith('/')).toBe(true);
    expect(path.startsWith('//')).toBe(false);
    expect(path).not.toContain('://');
  });

  it('points at the open-sandbox page, carrying the node', () => {
    // Not hub home: the recipient would have to find the card and press Open.
    // Not open-service: that is a blank tab while the box resumes.
    const path = sandboxShareLandingPath(NODE_ID);

    expect(path.startsWith('/open-sandbox?')).toBe(true);
    expect(path).toContain(NODE_ID);
  });

  it('escapes the node id rather than interpolating it raw', () => {
    // The id reaches the hub as a stored redirect target; a value that can
    // smuggle another query param into it must not be pasted in unescaped.
    expect(sandboxShareLandingPath('a&b=c')).toBe('/open-sandbox?node=a%26b%3Dc');
  });
});

describe('pickInvitableEmails', () => {
  it('normalizes, de-dupes and drops blanks', () => {
    const picked = pickInvitableEmails([
      { email: '  Alice@Example.COM ' },
      { email: 'alice@example.com' },
      { email: '' },
      { email: null },
      { email: 'bob@example.com' },
    ]);

    expect(picked).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('drops the sender, case-insensitively', () => {
    // The hub answers a self-invite with a 200 that grants nothing and sends no
    // mail — a success the sender would read as "it worked".
    const picked = pickInvitableEmails(
      [{ email: 'ME@example.com' }, { email: 'bob@example.com' }],
      [],
      'me@example.com',
    );

    expect(picked).toEqual(['bob@example.com']);
  });

  it('drops addresses that already have access', () => {
    const picked = pickInvitableEmails([{ email: 'bob@example.com' }], [{ user_email: 'Bob@Example.com' }]);

    expect(picked).toEqual([]);
  });
});

describe('shareSandboxByEmail wire contract', () => {
  it('invites at the admission role, with a landing path', async () => {
    await shareSandboxByEmail(node(), ['bob@example.com']);

    const body = lastBody();
    expect(body.recipient_email).toBe('bob@example.com');
    expect(body.invitation_targets).toEqual([{ typeid: `${ComputeNode.type}-${NODE_ID}`, role: SANDBOX_SHARE_ROLE }]);
    expect(body.callback_override).toBe(sandboxShareLandingPath(NODE_ID));
    // Not a transfer unless asked: these keys must be absent, not false/null.
    expect('transfer' in body).toBe(false);
    expect('role_to_keep' in body).toBe(false);
  });

  it('asks for owner and a kept role when handing over', async () => {
    await shareSandboxByEmail(node(), ['bob@example.com'], { transfer: true, roleToKeep: 'reader' });

    const body = lastBody();
    expect(body.invitation_targets).toEqual([{ typeid: `${ComputeNode.type}-${NODE_ID}`, role: 'owner' }]);
    expect(body.transfer).toBe(true);
    expect(body.role_to_keep).toBe('reader');
  });

  it('sends role_to_keep: null for a complete handover', async () => {
    await shareSandboxByEmail(node(), ['bob@example.com'], { transfer: true, roleToKeep: null });

    // null is meaningful to the hub ("keep nothing") and must not be dropped as
    // if it were an omitted field.
    expect(lastBody().role_to_keep).toBeNull();
  });

  it('does not lose the other grants when one address fails', async () => {
    callAction
      .mockResolvedValueOnce([] as never)
      .mockRejectedValueOnce({ response: { status: 400, data: { detail: 'use change_role' } } } as never)
      .mockResolvedValueOnce([]);

    const outcome = await shareSandboxByEmail(node(), ['a@x.com', 'b@x.com', 'c@x.com']);

    expect(outcome.granted).toEqual(['a@x.com', 'c@x.com']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].email).toBe('b@x.com');
  });
});

describe('shareFailureText', () => {
  it('reads the envelope, not Error.message', () => {
    // The client throws the raw AxiosError, whose message is always
    // "Request failed with status code 4xx". An implementation based on
    // err.message would pass a naive test and say nothing useful in production.
    const err = {
      message: 'Request failed with status code 403',
      response: { status: 403, data: { detail: 'only an owner may transfer this entity' } },
    };

    expect(shareFailureText(err, 'fallback')).toBe('only an owner may transfer this entity');
  });

  it('does not call an already-granted share a failed one', () => {
    // The role is granted before the mail is sent, so a 5xx from the email step
    // means access exists. "Could not share" would invite a pointless retry.
    const err = { response: { status: 500, data: { detail: 'smtp exploded' } } };

    expect(shareFailureText(err, 'fallback')).toMatch(/granted/i);
  });

  it('recognises an existing member', () => {
    const err = {
      response: { status: 400, data: { detail: 'User has already accepted; use change_role to change their role.' } },
    };

    expect(shareFailureText(err, 'fallback')).toBe('Already has access');
  });
});

/**
 * The shareable link.
 *
 * It is the SAME url the card's Open button uses, and that is the point: one
 * public entry point that resolves the machine's state at click time. It is safe
 * to paste into a chat because it is not a bearer token — the hub requires an
 * authenticated principal holding at least `admin` on the node before it will
 * attach the cookie-gate secret.
 */
describe('sandboxShareLink', () => {
  const node = { id: NODE_ID } as never;

  it('is the open-service route for the node', () => {
    const link = sandboxShareLink(node);

    expect(link).toContain(NODE_ID);
    expect(link.endsWith('/open-service/workspace')).toBe(true);
  });

  it('carries no secret, no host and no port', () => {
    // The failure this guards is handing out `gated_host_url` instead: that url
    // embeds the cookie-gate secret — the only authorization in front of the
    // box's public provider url — and goes stale the moment the box pauses.
    const link = sandboxShareLink(node);

    expect(link).not.toContain('cookie-gate');
    expect(link).not.toContain('e2b.dev');
    expect(link).not.toMatch(/[?&]port=/);
    // The box's app port must not appear in the PATH. A bare `not.toContain`
    // also matched the hub's own origin, which under test is localhost:9007 —
    // so the assertion failed on a url that leaks nothing at all.
    expect(new URL(link).pathname).not.toContain('9007');
  });

  it('takes no landing path, so a shared link cannot aim anywhere but the box', () => {
    expect(sandboxShareLink(node)).not.toContain('?');
  });
});
