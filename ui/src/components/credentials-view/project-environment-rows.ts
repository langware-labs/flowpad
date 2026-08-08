import { EnvStatusEnum, EnvVarType } from '@sdk';
import type {
  EnvVarStatus,
  ProjectSecretOriginSummary,
  SecretOriginLocator,
  SecretResolveStatus,
} from '@sdk';
import { OAUTH_ORIGIN_KIND, originKindSpec } from '@src/components/secrets/secret-origin-kinds';

/**
 * The Project Environment tab's row model: SecretOrigin declarations and live
 * EnvVar rows unioned on the ONE key they share — the environment variable name.
 *
 * Pure by design (no React, no `@src` component imports beyond the kind table) so
 * the merge and the status collapse are testable without a render. The tab does
 * no merging of its own.
 *
 * The cardinal rule: **nothing is written on read**. A declaration without a
 * value and a value without a declaration are both legitimate states, and this
 * module reports them rather than reconciling them.
 */

export type ProjectEnvRowKind =
  /** Backed by a SecretOrigin — the project says it needs this. */
  | 'declared'
  /** A live EnvVar with no declaration: a local secret the user supplied. */
  | 'implicit'
  /** Derived from an OAuth connection. Not a declaration; managed in Connections. */
  | 'oauth';

export type MetStatus = 'met' | 'missing' | 'action-needed' | 'error' | 'unknown';

export interface ProjectEnvRow {
  /** The join key, and the React key. */
  envVar: string;
  rowKind: ProjectEnvRowKind;

  // ── declaration side ──
  typeid?: string;
  /** local | env-local | flowpad-hub | gcp | 1password | oauth | anything future. */
  originKind: string;
  locator?: Partial<SecretOriginLocator>;
  coordinate?: string;

  // ── env-table side ──
  /** Masked/visible form only. A raw secret never reaches this model. */
  visibleValue?: string;
  needsReauth?: boolean;

  // ── either side; the declaration wins ──
  description?: string;

  // ── collapsed status ──
  met: MetStatus;
  foundIn?: SecretResolveStatus['found_in'];
  comingSoon?: boolean;
  setupPrompt?: string;
}

export interface BuildProjectEnvRowsInput {
  secretOrigins: ProjectSecretOriginSummary[];
  status: SecretResolveStatus[];
  /** False until the first resolve-status round trip lands. Drives `unknown`
   *  rather than a red Missing that would be a lie on first paint. */
  statusReady: boolean;
  envRows: EnvVarStatus[];
}

/**
 * The primary display coordinate for a locator — the kind's declared coordinate
 * field when we know the kind, otherwise the first non-`kind` string value.
 *
 * The fallback is the point: a kind added to the backend after this build shipped
 * still renders something meaningful, with no change at any call site.
 */
export function coordinateOf(
  locator: Partial<SecretOriginLocator> | undefined,
  kind?: string,
): string | undefined {
  if (!locator) return undefined;
  const record = locator as Record<string, unknown>;
  const field = originKindSpec(kind ?? (locator.kind as string | undefined))?.coordField;
  if (field) {
    const known = record[field];
    if (typeof known === 'string' && known) return known;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'kind') continue;
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function isOAuthVar(row: EnvVarStatus): boolean {
  return row.var_type === EnvVarType.OAUTH_TOKEN || row.var_type === EnvVarType.OAUTH_PROVIDER_ID;
}

/** The fields a live EnvVar row contributes to any row kind. */
function envFields(row: EnvVarStatus | undefined): Partial<ProjectEnvRow> {
  if (!row) return {};
  return { visibleValue: row.visible_value, needsReauth: row.needs_reauth };
}

/**
 * A declaration's status. The two vocabularies disagree by design: resolve-status
 * scans sodot + `.env.local` + the provider, while the env table merges project +
 * user + hub-held credentials. We take the UNION, because the worker does: a
 * resolved secret merges *under* the EnvVar-derived base
 * (`secret_origin_resolver.py::secret_env_dict`), so a value present in either
 * source really does reach the process.
 */
export function collapseDeclared(
  resolve: SecretResolveStatus | undefined,
  env: EnvVarStatus | undefined,
  statusReady: boolean,
): MetStatus {
  if (!resolve) {
    // No status row yet — say nothing rather than say Missing.
    if (!statusReady) return 'unknown';
    // Status has landed and this declaration is not in it: the backend skipped
    // it because its locator failed to parse (project.py::secret_resolve_status).
    return 'error';
  }
  if (resolve.status === 'available') return 'met';
  switch (env?.var_status) {
    case EnvStatusEnum.AVAILABLE:
      return 'met';
    case EnvStatusEnum.CONSENT_REQUIRED:
      return 'action-needed';
    case EnvStatusEnum.ERROR:
      return 'error';
    default:
      return 'missing';
  }
}

/** An undeclared EnvVar's status. */
export function collapseImplicit(env: EnvVarStatus): MetStatus {
  switch (env.var_status) {
    case EnvStatusEnum.AVAILABLE:
      return 'met';
    case EnvStatusEnum.MISSING:
      return 'missing';
    case EnvStatusEnum.ERROR:
      return 'error';
    case EnvStatusEnum.CONSENT_REQUIRED:
      return 'action-needed';
    default:
      // `NA SOD` means "not SOD-backed", not "unset" — a plain var carrying a
      // value meets the need.
      return env.visible_value ? 'met' : 'unknown';
  }
}

/** An OAuth-derived row's status. Order matters: the hub leaves `var_status` at
 *  AVAILABLE while `needs_reauth` is set, so reauth must be checked first. */
export function collapseOAuth(env: EnvVarStatus): MetStatus {
  if (env.needs_reauth) return 'action-needed';
  switch (env.var_status) {
    case EnvStatusEnum.AVAILABLE:
      return 'met';
    case EnvStatusEnum.CONSENT_REQUIRED:
      return 'action-needed';
    case EnvStatusEnum.ERROR:
      return 'error';
    default:
      return 'missing';
  }
}

const ROW_KIND_ORDER: Record<ProjectEnvRowKind, number> = { declared: 0, implicit: 1, oauth: 2 };

export function buildProjectEnvRows({
  secretOrigins,
  status,
  statusReady,
  envRows,
}: BuildProjectEnvRowsInput): ProjectEnvRow[] {
  const statusByEnvVar = new Map(status.map((s) => [s.env_var, s]));
  const envByName = new Map(envRows.map((r) => [r.name, r]));

  // Declarations are the backbone: they say what the project NEEDS.
  const declared = new Map<string, ProjectEnvRow>();
  for (const origin of secretOrigins) {
    if (!origin?.env_var) continue;
    const resolve = statusByEnvVar.get(origin.env_var);
    const env = envByName.get(origin.env_var);
    declared.set(origin.env_var, {
      envVar: origin.env_var,
      rowKind: 'declared',
      typeid: origin.typeid,
      originKind: origin.kind || origin.locator?.kind || 'local',
      locator: origin.locator,
      coordinate: coordinateOf(origin.locator, origin.kind),
      ...envFields(env),
      // The declaration's description wins — it survives a value being removed.
      description: origin.description || resolve?.description || undefined,
      met: collapseDeclared(resolve, env, statusReady),
      foundIn: resolve?.found_in,
      comingSoon: resolve?.setup_hint?.coming_soon === true,
      setupPrompt: resolve?.setup_hint?.prompt,
    });
  }

  // Every env row not already claimed by a declaration joins on the same key.
  const rest: ProjectEnvRow[] = [];
  for (const env of envRows) {
    if (declared.has(env.name)) continue;
    const oauth = isOAuthVar(env);
    rest.push({
      envVar: env.name,
      rowKind: oauth ? 'oauth' : 'implicit',
      // An undeclared variable IS a local secret — the user supplied it here.
      originKind: oauth ? OAUTH_ORIGIN_KIND : 'local',
      ...envFields(env),
      description: env.description || undefined,
      met: oauth ? collapseOAuth(env) : collapseImplicit(env),
    });
  }

  // Declared, then implicit, then oauth; alphabetical within. Deliberately NOT
  // unmet-first: a row must not jump out from under the cursor the moment a
  // value is provided.
  return [...declared.values(), ...rest].sort(
    (a, b) => ROW_KIND_ORDER[a.rowKind] - ROW_KIND_ORDER[b.rowKind] || a.envVar.localeCompare(b.envVar),
  );
}
