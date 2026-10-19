/**
 * Identifiers for SDK-shipped system projects.
 *
 * System projects are mounted directly from the installed flow_sdk package;
 * their fs_storage_mount_path points inside site-packages. The Flowpad Assistant
 * is one such project, carrying the system skills, agents, and docs.
 */

export const FLOWPAD_ASSISTANT_PROJECT_UNAME = 'flowpad_assistant';
export const FLOWPAD_ASSISTANT_PROJECT_NAME = 'Flowpad Assistant';

/**
 * The local helpdesk PORTAL checkout — not SDK-shipped, but app-managed the
 * same way: minted by `helpdesk-ensure`, hidden from project pickers, and
 * recognisable from the entity alone. Mirrors `HELPDESK_PORTAL_UNAME` in
 * flow_sdk/config.py.
 */
export const HELPDESK_PORTAL_UNAME = 'helpdesk_portal';

/**
 * True when this project is app-managed — infrastructure the user visits (the
 * Flowpad Assistant, a help-desk portal checkout, the agent mount root), never
 * a project they work in. Such a project must never become the CURRENT project:
 * opening the help desk would otherwise switch the footer, the workdir and
 * every project-scoped action out of the project the user was actually in.
 *
 * ONE source: the backend's `Project.hidden` (`is_hidden_project` in
 * flow_sdk/config.py), published as a computed field on the entity and on
 * `ProjectListItem`; named after it, so the same question wears the same
 * word on both tiers. Deliberately NOT re-derived here — the portal is
 * recognised by WHERE IT LIVES, which no client can check, and the entity's own
 * `system` flag means the narrower "SDK-shipped" and misses it.
 */
export function isHiddenProject(project: { hidden?: boolean } | null | undefined): boolean {
  return project?.hidden === true;
}
