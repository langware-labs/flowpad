/**
 * The name the user's own crumb carries — their Stream Inbox, their conversations.
 *
 * The DISPLAY identity, not the auth principal. A desktop signed in to a hub holds
 * two `user` rows for one human: the local desktop row (`uname === 'local'`, named
 * from the machine's git config — "serans1") and the hub row the cloud login
 * returned ("Eran Shlomo"). `dataContext.currentUser` is the one the SDK itself
 * designates for "rendering avatars / names / emails to the human"
 * (`FlowSync/context.ts`), and it is already what the avatar in this very nav bar
 * and the hub home's greeting draw. Naming the crumb from `localUser` instead put
 * two different people in one nav bar: "Hey Eran" on `/dock/hub/home` and
 * `serans1 › Stream Inbox` one click away.
 *
 * The local row stays the fallback: signed out of the hub there is no cloud row,
 * and the local name is then the only name the human has here. `null` means
 * neither row has a name yet — the caller falls back to the type label.
 *
 * Deliberately NOT the query scope: the Stream Inbox still lists what
 * `localUser.id` owns (`channelsOwnerFor`), because that is the id the local
 * rows carry. This is the label only.
 */
export function userCrumbLabel(
  currentUser: { name?: string | null } | null | undefined,
  localUser: { name?: string | null } | null | undefined,
): string | null {
  return currentUser?.name?.trim() || localUser?.name?.trim() || null;
}
