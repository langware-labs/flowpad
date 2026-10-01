/**
 * The Connections table's credential rows, folded from the backend status.
 *
 * Pure (no React, no calls) so the rules are testable without a render. Every
 * decision about presence is the backend's; this only shapes it for the table.
 */
import {
  CredentialRequirement,
  type CredentialScopeName,
  type CredentialStatusRow,
  type CredentialsStatus,
  type CredentialValueStore,
} from '@sdk';

const { MUST } = CredentialRequirement;

export type CredentialRowState = 'connected' | 'needs-values';

export interface CredentialRowVar {
  envVar: string;
  required: CredentialRequirement;
  present: boolean;
  warning: 'missing' | 'wrong-store' | 'unreachable' | null;
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
  /** `MUST` when the project cannot work without at least one of its variables — the table's chip. */
  required: CredentialRequirement;
  /** Required variables with no value in this credential's store. */
  missing: string[];
  /** Every variable is overridden by a project credential of the same name. */
  shadowed: boolean;
  /** The `.env.local` this credential reads, when it keeps values there and the file exists. */
  envPath?: string;
  /** The status row the edit and set-values forms start from. */
  source: CredentialStatusRow;
}

export interface DetectedGroup {
  scope: CredentialScopeName;
  projectId: string | null;
  path: string | null;
  /** The project-relative path of a file the project declared; null for the scope's own `.env.local`. */
  extraPath: string | null;
  keys: { key: string; line: number }[];
}

/** One row per declared credential: project first, then the user's; by title within. */
export function buildCredentialRows(status: CredentialsStatus): CredentialRow[] {
  // The scope's own `.env.local` first — the one values are written to — else the first
  // declared env file that exists (the server lists the scope's own file first).
  const envFile = (row: CredentialStatusRow) =>
    row.value_store === 'env'
      ? status.files.find((f) => f.scope === row.scope && f.project_id === row.project_id && f.exists)?.path ?? undefined
      : undefined;
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
        required: row.vars.some((v) => v.required === MUST) ? MUST : CredentialRequirement.OPTIONAL,
        missing: row.vars.filter((v) => v.required === MUST && !v.present).map((v) => v.env_var),
        shadowed: row.vars.length > 0 && row.vars.every((v) => !!v.shadowed_by),
        envPath: envFile(row),
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
 * The env-file keys no credential in their scope declares yet — what can be
 * packed, one group per file. A key an earlier file of the same scope already
 * lists is left out of the later one (the earlier file is the one read), and a
 * file whose keys are all taken is left out.
 */
export function buildDetectedGroups(status: CredentialsStatus): DetectedGroup[] {
  const seen = new Map<string, Set<string>>();
  return status.files
    .map((file) => {
      const taken = takenInScope(status, file.scope);
      const scopeKey = `${file.scope}:${file.project_id ?? ''}`;
      const earlier = seen.get(scopeKey) ?? new Set<string>();
      seen.set(scopeKey, new Set([...earlier, ...file.detected.map((k) => k.key)]));
      return {
        scope: file.scope,
        projectId: file.project_id,
        path: file.path,
        extraPath: file.extra_path ?? null,
        keys: file.detected
          .filter((k) => !taken.has(k.key) && !earlier.has(k.key))
          .map((k) => ({ key: k.key, line: k.line })),
      };
    })
    .filter((group) => group.keys.length > 0)
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}
