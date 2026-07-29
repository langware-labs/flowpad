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

export function credentialsPointer(tab: CredentialsSubview, projectId?: string): string {
  return projectId ? `${tab}/${projectId}` : tab;
}

export function parseCredentialsPointer(pointer?: string): {
  tab: CredentialsSubview;
  projectId?: string;
} {
  const [rawTab, projectId] = (pointer ?? '').split('/').filter(Boolean);
  // An unknown or absent tab lands on Environment rather than a blank pane.
  const tab = TABS.has(rawTab) ? (rawTab as CredentialsSubview) : CredentialsSubview.ENVIRONMENT;
  return { tab, projectId: projectId || undefined };
}
