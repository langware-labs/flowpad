import { CredentialsSubview } from '@sdk';

/**
 * The credentials view's pointer: `<subview>[/<projectId>[/<entry>]]` — `entry` is the typeid of the credential
 * shown selected (what a setup dialog's row links to).
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

export function credentialsPointer(tab: CredentialsSubview, projectId?: string, entry?: string): string {
  if (!projectId) return tab;
  return entry ? `${tab}/${projectId}/${encodeURIComponent(entry)}` : `${tab}/${projectId}`;
}

export function parseCredentialsPointer(
  pointer?: string,
  /** Where an absent or unknown tab lands — the caller's leading tab. */
  fallback: CredentialsSubview = CredentialsSubview.CONNECTIONS,
): {
  tab: CredentialsSubview;
  projectId?: string;
  /** The selected credential's typeid; absent with no project segment. */
  entry?: string;
} {
  const [rawTab, projectId, rawEntry] = (pointer ?? '').split('/').filter(Boolean);
  // Connections is the only live subview, so a retired one (`environment`,
  // `api-keys`) resolves to the fallback like any unknown segment — the project
  // segment survives either way. `RETIRED_DOCK_VIEWS` owns the forwarding of
  // persisted tabs; a second table here would be a second place to forget.
  const tab = rawTab === CredentialsSubview.CONNECTIONS ? CredentialsSubview.CONNECTIONS : fallback;
  let entry: string | undefined;
  try {
    entry = rawEntry ? decodeURIComponent(rawEntry) : undefined;
  } catch {
    entry = undefined; // a mangled segment selects nothing, never an error page
  }
  return { tab, projectId: projectId || undefined, entry: projectId ? entry : undefined };
}
