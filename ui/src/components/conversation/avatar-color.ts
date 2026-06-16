/**
 * Per-identity avatar colors for conversation surfaces (message bubbles + the
 * member roster). One source of truth so the same person reads the same color
 * in the thread AND in the avatar stack.
 *
 * Convention (keep MessageBubble's doc in sync if this changes):
 *   - the local user ("sender") is always purple
 *   - the assistant ("bot") is always slate
 *   - every other participant gets a DISTINCT color, derived deterministically
 *     from their stable identity key (hub ``user_id`` → ``email`` → ``name``),
 *     so two different people don't collide unless the palette is exhausted.
 */

/** Reserved — the local user. */
export const SELF_AVATAR_COLOR = 'bg-purple-500';
/** Reserved — the assistant. */
export const BOT_AVATAR_COLOR = 'bg-slate-500';

// Rotation for everyone else. Purple (self) and slate (bot) are deliberately
// excluded so they keep reading as special. Each entry pairs with white text —
// callers add ``text-white`` alongside the returned class.
const PARTICIPANT_PALETTE = [
  'bg-emerald-500',
  'bg-blue-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-rose-500',
  'bg-cyan-600',
  'bg-lime-600',
  'bg-fuchsia-500',
  'bg-orange-500',
  'bg-sky-500',
] as const;

/** Stable, well-distributed hash (djb2) of an identity key → palette slot. */
function paletteIndex(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % PARTICIPANT_PALETTE.length;
}

/** Color for a non-self, non-bot participant, keyed by their identity. An
 *  empty/missing key falls to the first slot (a stable "unknown" bucket). */
export function colorForIdentityKey(key: string | null | undefined): string {
  const k = (key ?? '').trim().toLowerCase();
  if (!k) return PARTICIPANT_PALETTE[0];
  return PARTICIPANT_PALETTE[paletteIndex(k)];
}

/** Bubble avatar color: role decides self/bot; everyone else is keyed by the
 *  message's ``sender_id`` (the author's hub user_id). */
export function avatarColorForMessage(
  role: string | null | undefined,
  senderId: string | null | undefined,
): string {
  if (role === 'sender') return SELF_AVATAR_COLOR;
  if (role === 'bot') return BOT_AVATAR_COLOR;
  return colorForIdentityKey(senderId);
}

/** Roster avatar color: self is purple, everyone else is keyed by ``user_id``
 *  (matching the bubble's ``sender_id``), falling back to email then name. */
export function avatarColorForParticipant(
  participant: { user_id?: string | null; email?: string | null; name?: string | null } | null | undefined,
  isSelf: boolean,
): string {
  if (isSelf) return SELF_AVATAR_COLOR;
  const key =
    participant?.user_id?.trim() ||
    participant?.email?.trim() ||
    participant?.name?.trim() ||
    '';
  return colorForIdentityKey(key);
}
