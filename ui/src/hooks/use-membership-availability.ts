import { useCloudAuthed } from '@src/hooks/use-cloud-authed';
import { usePrivacyMode } from '@src/hooks/use-privacy-mode';

/**
 * Why membership is or isn't available on this client, right now.
 *  - ``available``      — signed in to the hub; reads/writes are allowed.
 *  - ``unauthenticated``— not signed in; clicking a members control should open
 *    the sign-in popup.
 *  - ``local``          — Local (privacy) mode; membership is a cloud feature and
 *    is unavailable (no sign-in button, just an explanation).
 *
 * ``offline`` (signed in but the hub is unreachable) is deliberately NOT a
 * pre-fetch reason — it can't be known until a fetch fails. ``useMembers``
 * surfaces it after the fact as ``stale`` (show the cached roster + "can't
 * update"), never as a sign-in prompt.
 */
export type MembershipReason = 'available' | 'unauthenticated' | 'local';

export interface MembershipAvailability {
  available: boolean;
  reason: MembershipReason;
}

/**
 * Single source of truth for "can this client do membership?". Every members
 * surface (roster stack, org panel, the contact-picker's computed group, invite
 * forms) gates on this so they behave identically. Layers the Local-mode check
 * over the shared ``useCloudAuthed`` predicate (also used by the login gate).
 */
export function useMembershipAvailability(): MembershipAvailability {
  const { isLocal } = usePrivacyMode();
  const authed = useCloudAuthed();

  if (isLocal) return { available: false, reason: 'local' };
  if (!authed) return { available: false, reason: 'unauthenticated' };
  return { available: true, reason: 'available' };
}
