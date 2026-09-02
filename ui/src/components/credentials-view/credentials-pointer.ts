import { CredentialsSubview, PageId, ViewType } from '@sdk';

import type { NavigationActions } from '@src/navigation/NavigationActions';

/**
 * The credentials view's pointer: `<subview>[/<projectId>]`.
 *
 * Both the active tab and the selected project live in the URL rather than in
 * component state — so a reload lands where you were, and picking a project is
 * a navigation rather than a hidden write. `foldsPointer` on the registry entry
 * keeps every combination collapsed into one tab chip.
 */

/**
 * The tabs in display order — now exactly one.
 *
 * Connections is the only credential surface: an OAuth provider, an API
 * credential and a bare declared env var are all rows in one table, so the
 * Project Environment and API Keys panes have nothing left to show that this
 * one does not.
 *
 * `hubOnly` is kept in the signature because callers pass it and the ordering
 * question returns the moment a second tab does.
 */
export function credentialsTabs(_hubOnly: boolean): CredentialsSubview[] {
  return [CredentialsSubview.CONNECTIONS];
}

export function credentialsPointer(tab: CredentialsSubview, projectId?: string): string {
  return projectId ? `${tab}/${projectId}` : tab;
}

export function parseCredentialsPointer(
  pointer?: string,
  /** Where an absent or unknown tab lands — the caller's leading tab. */
  fallback: CredentialsSubview = CredentialsSubview.CONNECTIONS,
): {
  tab: CredentialsSubview;
  projectId?: string;
} {
  const [rawTab, projectId] = (pointer ?? '').split('/').filter(Boolean);
  // Connections is the only live subview, so a retired one (`environment`,
  // `api-keys`) resolves to the fallback like any unknown segment — the project
  // segment survives either way. `RETIRED_DOCK_VIEWS` owns the forwarding of
  // persisted tabs; a second table here would be a second place to forget.
  const tab = rawTab === CredentialsSubview.CONNECTIONS ? CredentialsSubview.CONNECTIONS : fallback;
  return { tab, projectId: projectId || undefined };
}

/**
 * Navigate to the credentials screen (page=desk), optionally scoped to a project.
 *
 * The one way in from another screen. It exists so a caller that wants to send
 * someone here to ADD something — the LLM sources page, when a provider has no
 * key — states that intent once instead of assembling `openPage(...)` with a
 * pointer it built by hand. No React here, same leaf rule as the parser above.
 */
export function openCredentials(navigation: NavigationActions, projectId?: string): void {
  navigation.openPage(
    PageId.DESK,
    ViewType.CREDENTIALS,
    credentialsPointer(CredentialsSubview.CONNECTIONS, projectId),
  );
}
