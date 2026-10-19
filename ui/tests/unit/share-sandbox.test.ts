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
import { cloudManager, ComputeNode, dataManager } from '@sdk';
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import {
  SANDBOX_SHARE_ROLE,
  SANDBOX_PROJECT_ROLE,
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

  it('is the entity url the hub itself would have built', () => {
    // `<type>/<id>` in the PATH — the shape of `build_entity_url`, and of
    // `flow_message/:messageId`, the entry journey doing this same job for a
    // conversation. Asserted through `ComputeNode.type` rather than the literal
    // 'compute_node' so a type rename cannot leave this URL behind.
    const path = sandboxShareLandingPath(NODE_ID);

    expect(path).toBe(`/${ComputeNode.type}/${NODE_ID}`);
  });

  it('escapes the node id rather than interpolating it raw', () => {
    // The id lands in a URL PATH: a value carrying a slash or a `?` would change
    // which route it addresses, not merely which node.
    expect(sandboxShareLandingPath('a/b?c')).toBe(`/${ComputeNode.type}/a%2Fb%3Fc`);
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
    // The override IS sent. It used to be deliberately absent, on the reasoning
    // that the hub's own post-accept landing is `build_entity_url(target.typeid)`
    // — true, and sufficient, while the box was the only target. It is not the
    // only target any more, and with two the hub picks off a list it rebuilds
    // from the graph, so the destination has to be stated.
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
    // The middle address fails for a REAL reason. It used to be a `change_role`
    // 400, which now deliberately counts as granted -- see
    // "already a member counts as granted" below -- so the fixture had to become
    // a failure that still is one.
    callAction
      .mockResolvedValueOnce([] as never)
      .mockRejectedValueOnce({ response: { status: 500, data: { detail: 'boom' } } } as never)
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
 * It is the SAME destination the invitation email lands on, and that is the
 * point: ONE shared link with one set of powers. It used to be the hub's
 * `open-service` route, which OPENS a box and cannot BUILD one — so a link
 * copied for a sandbox that had not been launched yet answered 409 "this machine
 * has not been set up yet" while the emailed link to the same box worked. Two
 * links to one machine with different abilities is the drift these assert away.
 *
 * Still safe to paste into a chat: it names a node and carries no credential,
 * and `/compute_node/<id>` reaches the box only through `open-service`, which is
 * authorizes the caller and attaches the cookie-gate secret.
 */
describe('sandboxShareLink', () => {
  const node = { id: NODE_ID } as never;

  it('lands on the same page the invitation email does', () => {
    const link = sandboxShareLink(node);
    const url = new URL(link);

    expect(`${url.pathname}${url.search}`).toBe(sandboxShareLandingPath(NODE_ID));
  });

  it('is absolute, because it is pasted rather than followed', () => {
    // A bare path is what the INVITE sends (`is_safe_app_path` rejects an
    // absolute url there). Pasted into a chat, that same path resolves against
    // whatever origin the reader happens to be on, or nothing at all.
    const link = sandboxShareLink(node);

    expect(new URL(link).origin).toBeTruthy();
    expect(link).toContain(NODE_ID);
  });

  it('points at the HUB, not at whatever machine the sender is sitting on', () => {
    // The regression this exists for, shipped twice: run the app locally against
    // a remote hub and the link came out
    // `http://localhost:4093/compute_node/…` — a flawless link to the
    // sender's own laptop, handed to somebody who cannot reach it.
    //
    // Asserted against the `open-service` origin rather than a literal: that is
    // the hub the API talks to, and the two entry points to one box must never
    // resolve to different hubs.
    const link = sandboxShareLink(node);
    const hub = new URL(workspaceServiceUrl(NODE_ID)).origin;

    // Non-vacuous by construction: the browser origin under test (:3000) is not
    // the hub origin (:9007), so the discarded implementation fails this line.
    expect(window.location.origin).not.toBe(hub);
    expect(new URL(link).origin).toBe(hub);
  });

  it('ignores cloudAppUrl, which is the browser origin in hub mode', () => {
    // The SECOND wrong answer, and the subtler one: `cloudAppUrl` reads like
    // "the hub's browser origin" but `cloud_login.ts` ASSIGNS it
    // `window.location.origin` under `isHubOnly()` — which is true for any app
    // pointed at a hub, the local dev harness included. So it reproduces the
    // localhost link exactly, under a name that suggests it cannot.
    const spy = vi.spyOn(cloudManager, 'cloudAppUrl', 'get').mockReturnValue('http://localhost:4093');
    try {
      expect(new URL(sandboxShareLink(node)).origin).toBe(new URL(workspaceServiceUrl(NODE_ID)).origin);
    } finally {
      spy.mockRestore();
    }
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

  it('names a node and nothing else, so a shared link cannot aim anywhere but the box', () => {
    // With the id in the PATH there is nothing left for a query to carry, and a
    // caller-chosen `next`/redirect parameter would turn this into an open
    // redirect wearing a sandbox link's clothes.
    const url = new URL(sandboxShareLink(node));

    expect(url.search).toBe('');
    expect(url.pathname).toBe(`/${ComputeNode.type}/${NODE_ID}`);
  });
});

/**
 * The project rides along with the machine, in ONE invitation.
 *
 * A sandbox is only useful as the project it opens, and the box fetches that
 * project from the hub AS the person who opened it — so a role on the machine
 * alone gets a 401 there and the box keeps a bare row: right files, no language,
 * none of the author's settings.
 *
 * ONE invitation, so one email, landing on the box. Splitting it sent two mails
 * and the second one put the recipient on the PROJECT, where a "wrong account"
 * screen was waiting.
 *
 * A handover rides here too. The hub used to judge every target in a transfer
 * invitation as a transfer — and a transfer may only confer `owner` — so a
 * `member` project target was refused outright. Accept had always decided per
 * target (`invitation.transfer and rel.invited_to_role == owner`); the invite
 * side now agrees, so only the box is handed over.
 */
describe('sharing grants the project too', () => {
  const PROJECT_ID = '99999999-2222-4333-8444-555555555555';

  function nodeWithProject(): ComputeNode {
    return new ComputeNode({
      id: NODE_ID,
      name: 'Desktop 1',
      node_config: { pending_setup: { name: 'hebrew project', projectId: PROJECT_ID } },
    } as never);
  }

  function targets(): { typeid: string; role: string }[] {
    return (lastBody().invitation_targets ?? []) as { typeid: string; role: string }[];
  }

  it('sends ONE invitation carrying both the machine and the project', async () => {
    // One invitation = one email. Two emails is the bug this shape fixes.
    await shareSandboxByEmail(nodeWithProject(), ['someone@example.com']);
    expect(callAction).toHaveBeenCalledTimes(1);
    expect(targets()).toEqual([
      { typeid: `compute_node-${NODE_ID}`, role: SANDBOX_SHARE_ROLE },
      { typeid: `project-${PROJECT_ID}`, role: SANDBOX_PROJECT_ROLE },
    ]);
  });

  it('lands the mail on the MACHINE even though the project rides along', async () => {
    // THE REGRESSION. This used to assert that the machine was first in
    // `invitation_targets`, on the belief that the hub lands the recipient on the
    // first non-workspace target. It does — but on a list it REBUILDS from the
    // graph at accept time (`_build_invitation_relationships` ->
    // `get_incoming_relationships`), not on the array sent here. The client's
    // order is gone by then, both targets are non-workspace, and the project won:
    // people were handed a machine and shown the work.
    //
    // So the destination is asserted where it is actually decided —
    // `callback_override`, which `landing_url` prefers over the chosen target.
    // Array order is not the mechanism and is deliberately not asserted.
    await shareSandboxByEmail(nodeWithProject(), ['someone@example.com']);
    expect(lastBody().callback_override).toBe(sandboxShareLandingPath(NODE_ID));
    expect(lastBody().callback_override).not.toContain(PROJECT_ID);
  });

  it('lands on the machine on a handover too', async () => {
    await shareSandboxByEmail(nodeWithProject(), ['someone@example.com'], { transfer: true, roleToKeep: 'reader' });
    expect(lastBody().callback_override).toBe(sandboxShareLandingPath(NODE_ID));
  });

  it('grants member on the project, not reader', async () => {
    // On `project`, reader also allows `secret`. Being handed a sandbox is not a
    // reason to reach its secrets.
    await shareSandboxByEmail(nodeWithProject(), ['someone@example.com']);
    expect(targets()[1].role).toBe('member');
  });

  it('carries BOTH in a handover, with the box at owner and the project at member', async () => {
    // The case that forced the split before: a transfer invitation refused any
    // target below `owner`. Owning the machine does not make someone the owner
    // of the work it opens.
    await shareSandboxByEmail(nodeWithProject(), ['someone@example.com'], { transfer: true });
    expect(callAction).toHaveBeenCalledTimes(1);
    expect(targets()).toEqual([
      { typeid: `compute_node-${NODE_ID}`, role: 'owner' },
      { typeid: `project-${PROJECT_ID}`, role: SANDBOX_PROJECT_ROLE },
    ]);
    expect(lastBody().transfer).toBe(true);
  });

  it('sends the machine alone when the box has no project', async () => {
    // An empty sandbox is a machine and nothing else.
    await shareSandboxByEmail(node(), ['someone@example.com']);
    expect(targets()).toEqual([{ typeid: `compute_node-${NODE_ID}`, role: SANDBOX_SHARE_ROLE }]);
  });

  it('counts "already a member" as granted, not as a failed share', async () => {
    // Sharing a SECOND box built on the same project hits this every time: the
    // recipient still holds the project role from the first, the hub refuses a
    // re-invite, and treating that as an error blocked the share of a box they
    // do not have yet.
    callAction.mockRejectedValueOnce({
      response: { status: 400, data: { detail: 'existing member — use change_role' } },
    } as never);
    const out = await shareSandboxByEmail(nodeWithProject(), ['someone@example.com']);
    expect(out.granted).toEqual(['someone@example.com']);
    expect(out.failed).toEqual([]);
  });

  it('still reports a genuine failure', async () => {
    // The clause above must not swallow everything that goes wrong.
    callAction.mockRejectedValueOnce({ response: { status: 500, data: { detail: 'boom' } } } as never);
    const out = await shareSandboxByEmail(nodeWithProject(), ['someone@example.com']);
    expect(out.granted).toEqual([]);
    expect(out.failed).toHaveLength(1);
  });
});
