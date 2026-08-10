import { ComputeNode } from '@sdk';
import { workspaceServiceUrl } from '@src/hooks/use-sandboxes';
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

/** What the sender keeps after handing a sandbox over. */
export const SANDBOX_TRANSFER_ROLE_TO_KEEP = 'reader';

/**
 * Where the emailed invitation lands the recipient: the `/open-sandbox` page,
 * which says "Preparing your sandbox…" and then redirects into the box.
 *
 * Not hub home, and not `open-service` directly. Hub home makes the recipient
 * hunt for a card and press Open — the one thing the invitation already knows
 * they want. `open-service` is the right destination but the wrong first
 * screen: the hub resumes the machine and waits for it to answer before it
 * redirects, so the recipient stares at a blank tab for up to a minute with no
 * way to tell working from broken.
 *
 * Must stay a PATH. `callback_override` is validated hub-side by
 * `is_safe_app_path` (leading `/`, no `//`, no `://`), so an absolute URL is
 * rejected at invite time with a 400.
 */
export function sandboxShareLandingPath(nodeId: string): string {
  return `/open-sandbox?node=${encodeURIComponent(nodeId)}`;
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
export async function shareSandboxByEmail(
  node: ComputeNode,
  emails: string[],
  opts: ShareSandboxOptions = {},
): Promise<ShareOutcome> {
  const outcome: ShareOutcome = { granted: [], failed: [] };
  const role = opts.transfer ? 'owner' : (opts.role ?? SANDBOX_SHARE_ROLE);

  for (const email of emails) {
    try {
      await node.inviteMember(email, role, {
        callbackOverride: sandboxShareLandingPath(node.id),
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
 * The link to hand someone once they have access.
 *
 * Deliberately the SAME url the card's Open button uses — the open-service
 * route, which resolves the machine's state at click time: it authorizes the
 * caller, resumes a paused box, waits for the workspace to answer, and only then
 * redirects.
 *
 * Safe to paste into a chat or an email because it is not a bearer token. The
 * hub requires an authenticated principal holding at least `admin` on the node
 * before it will even attach the cookie-gate secret, so a stranger who gets hold
 * of this gets a 403, not a session. That is exactly why it must never be the
 * raw gated host url, which carries that secret in its query string.
 */
export function sandboxShareLink(node: ComputeNode): string {
  return workspaceServiceUrl(node.id);
}
