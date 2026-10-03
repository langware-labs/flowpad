/**
 * The Connections table's credential rows, folded from the backend status.
 *
 * Pure (no React, no calls) so the rules are testable without a render. Every
 * decision about presence is the backend's; this only shapes it for the table.
 */
import {
  CredentialRequirement,
  credentialEnvFileName,
  type CredentialScopeFile,
  type CredentialScopeName,
  type CredentialStatusRow,
  type CredentialsStatus,
  type CredentialValueStore,
  type DetectedEnvKey,
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
  /** The file's name — see `EnvFileEntry.name`. */
  name: string;
  keys: { key: string; line: number }[];
}

/** One env file a scope reads: its own `.env.local`, or a file it falls back to. */
export interface EnvFileEntry {
  scope: CredentialScopeName;
  projectId: string | null;
  path: string | null;
  exists: boolean;
  /** As the project manifest declares it; null for the scope's own file. */
  extraPath: string | null;
  /** `.env.local` (`.env.<env>.local` for a named environment), or the declared path. */
  name: string;
  detected: DetectedEnvKey[];
}

/** A scope's env files in the order its store reads them: its own, then its fallbacks. */
export function envFilesOf(file: CredentialScopeFile): EnvFileEntry[] {
  const scope = { scope: file.scope, projectId: file.project_id };
  return [
    { ...scope, path: file.path, exists: file.exists, extraPath: null, name: credentialEnvFileName(file.environment), detected: file.detected },
    ...(file.fallbacks ?? []).map((f) => ({
      ...scope,
      path: f.path,
      exists: f.exists,
      extraPath: f.extra_path,
      name: f.extra_path,
      detected: f.detected,
    })),
  ];
}

/** One row per declared credential: project first, then the user's; by title within. */
export function buildCredentialRows(status: CredentialsStatus): CredentialRow[] {
  // The first of the scope's env files that exists — its own `.env.local` before its fallbacks.
  const envFile = (row: CredentialStatusRow) => {
    if (row.value_store !== 'env') return undefined;
    const file = status.files.find((f) => f.scope === row.scope && f.project_id === row.project_id);
    return (file && envFilesOf(file).find((e) => e.exists)?.path) ?? undefined;
  };
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
  return status.files
    .flatMap((file) => {
      const taken = takenInScope(status, file.scope);
      const earlier = new Set<string>();
      return envFilesOf(file).map((entry) => {
        const keys = entry.detected.filter((k) => !taken.has(k.key) && !earlier.has(k.key));
        entry.detected.forEach((k) => earlier.add(k.key));
        return { scope: entry.scope, projectId: entry.projectId, path: entry.path, name: entry.name, keys };
      });
    })
    .filter((group) => group.keys.length > 0)
    .sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'));
}
