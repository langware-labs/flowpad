import { ComputeNode, Project } from '@sdk';
import { pendingSetup, workspaceServiceUrl } from '@src/hooks/use-sandboxes';
import { errorMessage, errorStatus } from '@src/lib/error-message';

/**
 * Sharing a cloud sandbox by email, and handing one over.
 *
 * The hub side of this is entirely pre-existing: `POST <entity>/members` creates
 * the Invitation, provisions a shadow account for an unknown address, grants the
 * role, and sends the mail. Nothing here re-implements any of that — this module
 * only decides WHAT to ask for and how to read the answer.
 *
 * Kept out of the dialog so the decisions (which role, where the link lands, how
 * a batch partially fails) are testable as plain functions rather than through a
 * rendered component.
 */

/**
 * The role a shared sandbox is granted at.
 *
 * `admin` is the floor for admission: `policies.json` grants `open-service` only
 * at admin, and `_may_receive_the_gate` requires the same rank before the
 * cookie-gate secret is attached to the URL. Anything lower produces a link that
 * 403s at the sandbox's own gate — a share that looks like it worked.
 *
 * It also carries `delete`. That is a deliberate, accepted trade-off, not an
 * oversight: the dialog says so in as many words.
 */
export const SANDBOX_SHARE_ROLE = 'admin';

/**
 * What a recipient gets on the PROJECT the sandbox opens.
 *
 * `member`, not `reader`: on `project` the reader role also allows `secret`, and
 * being handed a sandbox is not a reason to reach its secrets. `member` is read
 * plus the member list — exactly what the box's own fetch of the project needs
 * in order to adopt its language and settings.
 *
 * The same on a handover as on a share: owning the machine does not make someone
 * the owner of the work it opens.
 */
export const SANDBOX_PROJECT_ROLE = 'member';

/** What the sender keeps after handing a sandbox over. */
export const SANDBOX_TRANSFER_ROLE_TO_KEEP = 'reader';

/**
 * Where the emailed invitation lands the recipient: `/compute_node/<id>`, the
 * page that says "Preparing your sandbox…" and then goes into the box.
 *
 * SENT AS `callback_override` ON THE INVITE, because the invitation now names TWO
 * entities and the hub has to pick one to land on.
 *
 * It rode without an override for exactly as long as the box was the only target:
 * `_post_accept_landing_url` ends in `build_entity_url(chosen_target.typeid)`,
 * which for a lone ComputeNode target IS this URL, so steering it was redundant.
 * Adding the project as a second target ended that. `choose_target_entity` takes
 * `non_workspace_targets[0]`, and that list is NOT the `invitation_targets` array
 * the client sent — accept rebuilds it from the graph
 * (`_build_invitation_relationships` -> `get_incoming_relationships`), so the
 * "first" target is whichever InvitedThrough edge the DB returns first. Both a
 * box and a project are non-workspace, so the email landed on the project: the
 * recipient was handed a machine and shown the work instead.
 *
 * Ordering the client array cannot fix that — there is no order left by the time
 * accept reads it. `landing_url` prefers a `callback_override` that passes
 * `is_safe_app_path` over `chosen_target` entirely, which makes the destination a
 * property of the invitation rather than of row order.
 *
 * Kept as a function rather than inlined because {@link sandboxShareLink} builds
 * the pasteable copy of the same destination, and two spellings of one address
 * is how the emailed link and the copied link drifted apart the first time.
 */
export function sandboxShareLandingPath(nodeId: string): string {
  return `/${ComputeNode.type}/${encodeURIComponent(nodeId)}`;
}

// `setAutoLogin` used to live here. It moved to `use-sandboxes`, next to the
// launch, because that is what it governs: whether bringing the workspace up
// signs a person into it. Sharing a box and choosing whose session it runs are
// different questions, and only one of them belongs to this module.

export interface ShareOutcome {
  granted: string[];
  failed: { email: string; message: string }[];
}

export interface ShareSandboxOptions {
  role?: string;
  transfer?: boolean;
  roleToKeep?: string | null;
}

/**
 * Normalize a picked recipient list into addresses worth sending to.
 *
 * Self is dropped here rather than relying on the hub, which answers a
 * self-invite with a 200 that grants nothing — a success the user would read as
 * "it worked" while no mail was sent and no access changed.
 */
export function pickInvitableEmails(
  selected: { email?: string | null }[],
  existing: { user_email?: string | null }[] = [],
  selfEmail?: string | null,
): string[] {
  const taken = new Set(
    [...existing.map((m) => m.user_email), selfEmail].map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean),
  );
  const out: string[] = [];
  for (const p of selected) {
    const email = (p.email ?? '').trim().toLowerCase();
    if (!email || taken.has(email)) continue;
    taken.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Turn a thrown hub failure into something the sender can act on.
 *
 * Reads the ERROR ENVELOPE, never `err.message`: the client throws the raw
 * AxiosError, whose message is always "Request failed with status code 4xx".
 * The hub's own sentence is more precise than anything invented here, so it is
 * preferred wherever it exists.
 */
export function shareFailureText(error: unknown, fallback: string): string {
  const status = errorStatus(error);
  const detail = errorMessage(error, '');
  if (status === 400 && /change_role/i.test(detail)) return 'Already has access';
  if (status === 401) return 'Sign in to share this sandbox';
  if (status === 403) return detail || 'Only the sandbox owner can share it';
  // The role was already granted before the mail step, so this is not a failed
  // share — saying "could not share" here would be wrong and would invite a
  // pointless retry.
  if (status >= 500) return 'Access granted, but the invitation email failed to send';
  return detail || fallback;
}

/**
 * Invite each address in turn.
 *
 * Sequential and failure-tolerant on purpose. The hub takes exactly one
 * `recipient_email` per POST, so a batch is N requests; aborting on the first
 * rejection would silently discard the grants that already landed and leave the
 * sender with no idea which of them took.
 */
/**
 * Did this fail only because the person already holds the role?
 *
 * The hub refuses to re-invite an existing member -- `change_role` is the only
 * path for one -- and answers 400 naming it. That is not a failed share: the
 * access being asked for is already in place.
 *
 * It became load-bearing when the project started riding along with the box.
 * Sharing a SECOND sandbox built on the same project hits it every time, because
 * the recipient kept the project role from the first, and reporting it as an
 * error blocked the share of a box they did not have yet.
 *
 * Matched on the hub's own wording rather than the bare 400, which every other
 * invitation failure also uses.
 */
function isAlreadyMember(error: unknown): boolean {
  return errorStatus(error) === 400 && /change_role/i.test(errorMessage(error, ''));
}

export async function shareSandboxByEmail(
  node: ComputeNode,
  emails: string[],
  opts: ShareSandboxOptions = {},
): Promise<ShareOutcome> {
  const outcome: ShareOutcome = { granted: [], failed: [] };
  const role = opts.transfer ? 'owner' : (opts.role ?? SANDBOX_SHARE_ROLE);
  // THE PROJECT TRAVELS WITH THE BOX, IN THE SAME INVITATION. A sandbox is only
  // useful as the project it opens, and the box fetches that project from the hub
  // AS the person who opened it -- so a role on the machine alone gets a 401
  // there and the box keeps a bare row: right files, no language, none of the
  // author's settings.
  //
  // ONE invitation, so ONE email. Two invitations meant two mails, and the second
  // one landed the recipient on the PROJECT -- where a "wrong account" screen was
  // waiting -- instead of on the box they were given.
  //
  // A handover rides here too, which it could not before. The hub used to judge
  // every target in a transfer invitation as a transfer, and a transfer may only
  // confer `owner`, so a `member` project target was refused outright. That was
  // one end of the feature disagreeing with the other: ACCEPT has always decided
  // per target (`invitation.transfer and rel.invited_to_role == owner`), so only
  // the box was ever handed over. The invite-time check now reads the same way.
  //
  // `member`, deliberately, not `reader`: on `project` the reader role also
  // allows `secret`, and being handed a sandbox is not a reason to reach its
  // secrets. The same on a handover as on a share -- owning the machine does not
  // make someone the owner of the work it opens.
  const projectId = pendingSetup(node)?.projectId;
  const projectTarget = projectId ? { typeid: `${Project.type}-${projectId}`, role: SANDBOX_PROJECT_ROLE } : undefined;

  for (const email of emails) {
    try {
      await node.inviteMember(email, role, {
        // LAND ON THE BOX, NOT ON THE PROJECT RIDING WITH IT. With two targets the
        // hub picks `non_workspace_targets[0]` off a list it rebuilds from the
        // graph, so the client's array order is gone by then and the project won.
        // See `sandboxShareLandingPath`.
        callbackOverride: sandboxShareLandingPath(node.id),
        ...(opts.transfer ? { transfer: true, roleToKeep: opts.roleToKeep ?? null } : {}),
        ...(projectTarget ? { extraTargets: [projectTarget] } : {}),
      });
      outcome.granted.push(email);
    } catch (err) {
      // ALREADY A MEMBER IS NOT A FAILED SHARE. Sharing a SECOND box built on the
      // same project hits this every time: the person already holds the project
      // role from the first one, the hub refuses a re-invite (change_role is the
      // only path for an existing member), and reporting that as an error blocked
      // the share of a box they do not have yet. The end state asked for is
      // already true, so it counts as granted.
      if (isAlreadyMember(err)) {
        outcome.granted.push(email);
        continue;
      }
      outcome.failed.push({ email, message: shareFailureText(err, 'Could not share with this address') });
    }
  }
  return outcome;
}

/**
 * The link to hand someone once they have access.
 *
 * The SAME destination the invitation email uses, and that is the whole point:
 * ONE shared link, with one set of powers. It used to be `workspaceServiceUrl`
 * — the hub's `open-service` route — on the reasoning that it is the same url
 * the card's Open button follows. True, and it made the copied link strictly
 * weaker than the emailed one, because `open-service` OPENS a box and cannot
 * BUILD one: pointed at a sandbox that was created but never launched, it
 * answers 409 "this machine has not been set up yet" and the recipient is out of
 * moves. A sandbox is written down and launched by two separate clicks, so being
 * shared before its first launch is ordinary, not exotic — and it is exactly the
 * state a handover arrives in when the new owner is meant to start it.
 *
 * `/compute_node/<id>` is the page that knows both verbs. It launches the box
 * when the box needs launching and the recipient may launch it, and redirects
 * through `open-service` otherwise — which is still what does the authorizing,
 * the resuming and the waiting. This adds a step in front of that route; it
 * takes nothing away from it.
 *
 * Absolute, unlike {@link sandboxShareLandingPath}: this one is pasted into a
 * chat or an email, where a bare path resolves against the wrong origin or
 * nothing at all — while the path form is what the hub composes against its own
 * base.
 *
 * ANCHORED TO THE API ORIGIN — the hub — and to nothing else. Two plausible
 * sources are both wrong, and both were shipped here before this comment existed:
 *
 * `window.location.origin` is where the SENDER's browser happens to be. Run the
 * app locally against a remote hub and the link reads
 * `http://localhost:4093/compute_node/…`: a flawless link to the sender's own
 * laptop, handed to somebody who cannot reach it.
 *
 * `cloudManager.cloudAppUrl` looks like the fix and is the same bug wearing a
 * better name. In hub mode — which is ANY app pointed at a hub, including that
 * same local dev harness — it is ASSIGNED `window.location.origin`, on purpose:
 * it answers "where is my browser's app origin", which is right for navigating
 * yourself and wrong for a link you hand to someone else. See
 * `cloud_login.ts`'s hub-mode branch, which says as much.
 *
 * The API origin is neither. It is where the hub actually is, in every mode, and
 * it is the origin this link already carried before it was absolute at all —
 * taken from `workspaceServiceUrl` rather than re-derived, so the two entry
 * points to one box can never resolve to different hubs.
 *
 * Safe to paste because it is not a bearer token: it names a node and carries no
 * credential, and every door behind it authorizes the caller. A stranger gets a
 * 403, not a session. That is exactly why it must never be the raw gated host
 * url, which carries the cookie-gate secret in its query string.
 */
export function sandboxShareLink(node: ComputeNode): string {
  const { origin } = new URL(workspaceServiceUrl(node.id));
  return new URL(sandboxShareLandingPath(node.id), origin).toString();
}
