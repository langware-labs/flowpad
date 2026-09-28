/**
 * Is this box running the viewer's own cloud session?
 *
 * Reads the node's cached `logged_in_user` rather than probing the box: the hub
 * refreshes it whenever it brings the workspace up, so this costs nothing and
 * cannot wake a paused machine just to render a card. The trade is staleness —
 * a box signed out by some other route still advertises the old user until the
 * hub next talks to it, so the button can appear for a session that has already
 * ended. Signing out twice is harmless, which is why the cheap read wins.
 *
 * Its own module so HubHome.tsx exports only components: a non-component export
 * there breaks React Fast Refresh, and every edit remounted the content panel.
 * The comparison rule (normalize, require both sides, never match on empty) is
 * the whole behaviour worth pinning.
 */
export function isSignedInAsMe(node: { logged_in_user?: string | null }, myEmail?: string | null): boolean {
  const boxUser = (node.logged_in_user ?? '').trim().toLowerCase();
  const me = (myEmail ?? '').trim().toLowerCase();
  // Both must be present: two unknowns are not a match, and treating them as one
  // would offer the button on every box of a signed-out viewer.
  return !!boxUser && !!me && boxUser === me;
}
