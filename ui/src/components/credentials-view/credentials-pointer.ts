import { CredentialsSubview } from '@sdk';

/**
 * The credentials view's pointer: `<subview>[/<projectId>]`.
 *
 * Both the active tab and the selected project live in the URL rather than in
 * component state — so a reload lands where you were, and picking a project is
 * a navigation rather than a hidden write. `foldsPointer` on the registry entry
 * keeps every combination collapsed into one tab chip.
 */

const TABS = new Set<string>(Object.values(CredentialsSubview));

/**
 * The tabs in display order. Only the first two swap: Connections leads on a hub
 * because it can always answer — a connection is user-scoped, while Environment
 * is project-scoped and the hub routinely has no project, so leading with it
 * opened on "No projects yet". `hubOnly` is passed in rather than read here, so
 * this module stays a pure URL helper (same reason `resolveRail` takes its
 * gates).
 */
export function credentialsTabs(hubOnly: boolean): CredentialsSubview[] {
  const [first, second] = hubOnly
    ? [CredentialsSubview.CONNECTIONS, CredentialsSubview.ENVIRONMENT]
    : [CredentialsSubview.ENVIRONMENT, CredentialsSubview.CONNECTIONS];
  return [first, second, CredentialsSubview.API_KEYS];
}

export function credentialsPointer(tab: CredentialsSubview, projectId?: string): string {
  return projectId ? `${tab}/${projectId}` : tab;
}

export function parseCredentialsPointer(
  pointer?: string,
  /** Where an absent or unknown tab lands — the caller's leading tab. */
  fallback: CredentialsSubview = CredentialsSubview.ENVIRONMENT,
): {
  tab: CredentialsSubview;
  projectId?: string;
} {
  const [rawTab, projectId] = (pointer ?? '').split('/').filter(Boolean);
  const tab = TABS.has(rawTab) ? (rawTab as CredentialsSubview) : fallback;
  return { tab, projectId: projectId || undefined };
}
