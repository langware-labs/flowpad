/**
 * The Connections table's credential rows, folded from the backend status.
 *
 * Pure (no React, no calls) so the rules are testable without a render. Every
 * decision about presence is the backend's; this only shapes it for the table.
 */
import type { CredentialScopeName, CredentialStatusRow, CredentialsStatus, CredentialValueStore } from '@sdk';

export type CredentialRowState = 'connected' | 'needs-values';

export interface CredentialRowVar {
  envVar: string;
  required: boolean;
  present: boolean;
  warning: 'missing' | 'wrong-store' | null;
}

export interface CredentialRow {
  /** Unique across scopes, unlike the name — also the React key. */
  typeid: string;
  name: string;
  title: string;
  iconName?: string;
  description?: string;
  scope: CredentialScopeName;
  store: CredentialValueStore;
  state: CredentialRowState;
  vars: CredentialRowVar[];
  /** Required variables with no value in this credential's store. */
  missing: string[];
  /** Every variable is overridden by a project credential of the same name. */
  shadowed: boolean;
  /** The status row the edit and set-values forms start from. */
  source: CredentialStatusRow;
}

export interface DetectedGroup {
  scope: CredentialScopeName;
  projectId: string | null;
  path: string | null;
  keys: { key: string; line: number }[];
}

/** One row per declared credential: project first, then the user's; by title within. */
export function buildCredentialRows(status: CredentialsStatus): CredentialRow[] {
  return status.credentials
    .map(
      (row): CredentialRow => ({
        typeid: row.typeid,
        name: row.name,
        title: row.title || row.name,
        iconName: row.icon_name || undefined,
        description: row.description || undefined,
        scope: row.scope,
        store: row.value_store,
        state: row.state === 'connected' ? 'connected' : 'needs-values',
        vars: row.vars.map((v) => ({ envVar: v.env_var, required: v.required, present: v.present, warning: v.warning })),
        missing: row.vars.filter((v) => v.required && !v.present).map((v) => v.env_var),
        shadowed: row.vars.length > 0 && row.vars.every((v) => !!v.shadowed_by),
        source: row,
      }),
    )
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user') || a.title.localeCompare(b.title));
}

/** Every variable another credential in this scope already declares. */
export function takenInScope(
  status: CredentialsStatus,
  scope: CredentialScopeName,
  ignoreTypeid?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const row of status.credentials) {
    if (row.scope !== scope || row.typeid === ignoreTypeid) continue;
    for (const v of row.vars) taken.add(v.env_var);
  }
  return taken;
}

/**
 * The `.env.local` keys no credential in their scope declares yet — what can be
 * packed. A scope whose file declares everything is left out.
 */
export function buildDetectedGroups(status: CredentialsStatus): DetectedGroup[] {
  return status.files
    .map((file) => {
      const taken = takenInScope(status, file.scope);
      return {
        scope: file.scope,
        projectId: file.project_id,
        path: file.path,
        keys: file.detected.filter((k) => !taken.has(k.key)).map((k) => ({ key: k.key, line: k.line })),
      };
    })
    .filter((group) => group.keys.length > 0)
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}
