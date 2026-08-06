import { ActionInfo, ComputeNode, dataManager, PageId } from '@sdk';
import { errorMessage, errorStatus } from '@src/lib/error-message';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * Sharing a cloud desktop by email, and handing one over.
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
 * The role a shared desktop is granted at.
 *
 * `admin` is the floor for admission: `policies.json` grants `open-service` only
 * at admin, and `_may_receive_the_gate` requires the same rank before the
 * cookie-gate secret is attached to the URL. Anything lower produces a link that
 * 403s at the sandbox's own gate — a share that looks like it worked.
 *
 * It also carries `delete`. That is a deliberate, accepted trade-off, not an
 * oversight: the dialog says so in as many words.
 */
export const DESKTOP_SHARE_ROLE = 'admin';

/** What the sender keeps after handing a desktop over. */
export const DESKTOP_TRANSFER_ROLE_TO_KEEP = 'reader';

/**
 * Where the emailed invitation lands the recipient.
 *
 * Built from the router's own pointer rather than a string literal so a route
 * rename cannot silently start sending people to the SPA's catch-all. The hub
 * validates it with `is_safe_app_path` (leading `/`, no `//`, no `://`), which
 * this satisfies by construction.
 */
export function desktopShareLandingPath(): string {
  return DockPointer.forHome().withPage(PageId.HUB).toUrl();
}

/** Invoke the owner-only `auto-login` action on a node. */
function autoLoginCall(nodeId: string, value: boolean): Promise<{ auto_login: boolean } | undefined> {
  const info = new ActionInfo('auto-login', ComputeNode.type, nodeId, 'POST');
  info.hubReflect = true; // the node is hub-owned
  info.bodyParameters = { auto_login: value };
  return dataManager.callAction<Record<string, unknown>, { auto_login: boolean } | undefined>(info);
}

export interface ShareOutcome {
  granted: string[];
  failed: { email: string; message: string }[];
}

export interface ShareDesktopOptions {
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
  if (status === 401) return 'Sign in to share this desktop';
  if (status === 403) return detail || 'Only the desktop owner can share it';
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
export async function shareDesktopByEmail(
  node: ComputeNode,
  emails: string[],
  opts: ShareDesktopOptions = {},
): Promise<ShareOutcome> {
  const outcome: ShareOutcome = { granted: [], failed: [] };
  const role = opts.transfer ? 'owner' : (opts.role ?? DESKTOP_SHARE_ROLE);

  for (const email of emails) {
    try {
      await node.inviteMember(email, role, {
        callbackOverride: desktopShareLandingPath(),
        ...(opts.transfer ? { transfer: true, roleToKeep: opts.roleToKeep ?? null } : {}),
      });
      outcome.granted.push(email);
    } catch (err) {
      outcome.failed.push({ email, message: shareFailureText(err, 'Could not share with this address') });
    }
  }
  return outcome;
}

/**
 * Set whether a box belongs to one person.
 *
 * Its own action, not a PUT on the entity: `update` is granted at editor and
 * above, so on the ordinary write path a shared admin could flip this. The hub
 * keeps `auto_login` in `_immutable_update` to close that path.
 */
export async function setAutoLogin(node: ComputeNode, value: boolean): Promise<boolean> {
  const res = await autoLoginCall(node.id, value);
  return res?.auto_login ?? value;
}
