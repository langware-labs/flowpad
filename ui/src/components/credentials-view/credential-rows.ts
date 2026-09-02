import type {
  CredentialSpec,
  CredentialVar,
  EnvLocalKey,
  ProjectSecretOriginSummary,
  SecretResolveStatus,
  SodStore,
} from '@sdk';
import { isRequired, isSecret } from '@sdk';

/**
 * The Connections table's credential rows: a CredentialSpec's declared members,
 * unioned with what is already sitting in the project's `.env.local`.
 *
 * Pure by design (no React, no service calls) so the grouping and the status
 * collapse are testable without a render: the fold is the part worth pinning,
 * and a render test would pin the markup instead.
 *
 * **Two inputs, never one.** `secret-resolve-status` iterates the project's
 * DECLARATIONS, so an undeclared `GMAIL_ADDRESS` sitting in `.env.local`
 * produces no status row at all. Folding on that action alone would report
 * "0 of 2" on a machine where both values are literally in the file — the worst
 * possible first impression. `env-local-status` supplies the other half; it
 * carries names and line numbers only, never a value.
 *
 * The cardinal rule, inherited: **nothing is written on read.**
 */

export type MemberState =
  /** Declared AND resolvable here. This is the only state a worker can use. */
  | 'met'
  /** The name is in `.env.local` but nothing declares it, so nothing injects it. */
  | 'adoptable'
  /** Neither declared-and-resolvable nor present on disk. */
  | 'missing';

export type CredentialRowState = 'connected' | 'partial' | 'none';

export interface CredentialMember {
  envVar: string;
  label: string;
  secret: boolean;
  required: boolean;
  state: MemberState;
  /**
   * Whether a `SecretOrigin` declares it — deliberately SEPARATE from `state`.
   * A declared member with no value yet is `missing`, exactly like an
   * undeclared one, but the two mean different things to the row: declaring is
   * what makes a credential exist. Collapsing them fragmented a just-declared
   * Twilio into one ad-hoc row per variable.
   */
  declared: boolean;
  /** Which store satisfied it, when declared. */
  foundIn?: SecretResolveStatus['found_in'];
  /** 1-indexed `.env.local` line, for the editor deep-link. */
  line?: number;
  /** The declaration's typeid, when one exists. */
  typeid?: string;
  hint?: string;
  placeholder?: string;
  helpUrl?: string;
}

export interface CredentialRow {
  /** Spec name, or the env var for an ad-hoc row. Also the React key. */
  key: string;
  title: string;
  iconName?: string;
  helpUrl?: string;
  description?: string;
  members: CredentialMember[];
  state: CredentialRowState;
  /** Counted over REQUIRED members only — an optional member missing must not
   *  hold a working credential at "partial". */
  metCount: number;
  requiredCount: number;
  adoptableCount: number;
  /** Any member declared — the difference between "added but unset" and absent. */
  declaredCount: number;
  /** True when no CredentialSpec backs this row: a bare declared env var, which
   *  is a degenerate one-member credential. */
  adHoc: boolean;
  /**
   * Which local store this row's values go into. Carried on the row because the
   * setup panel has to SAY where a value it is about to take will land, and
   * "your project's .env.local, which stays git-ignored" is the wrong sentence
   * — and the wrong reassurance — for a key going into the encrypted store that
   * every project on this machine shares.
   */
  sodStore: SodStore;
}

export interface BuildCredentialRowsInput {
  specs: CredentialSpec[];
  secretOrigins: ProjectSecretOriginSummary[];
  status: SecretResolveStatus[];
  envLocalKeys: EnvLocalKey[];
}

function memberState(
  envVar: string,
  declared: ProjectSecretOriginSummary | undefined,
  resolve: SecretResolveStatus | undefined,
  onDisk: EnvLocalKey | undefined,
  sodStore: SodStore,
): MemberState {
  // A declaration the backend can satisfy here is the only "met".
  if (declared && resolve?.status === 'available') return 'met';
  // Present on disk but nothing declares it. Deliberately NOT "met": the worker
  // resolver iterates declarations (`secret_origin_resolver.py`), so an
  // undeclared value is never injected, however plainly it sits in the file.
  //
  // And only for a credential that READS that file. `onDisk` is `.env.local`
  // presence, which says nothing about a credential whose values live in the
  // encrypted store — an `OPENROUTER_API_KEY` exported there is a convenience
  // for in-process calls and deliberately not a statement about what this box
  // may spend (`llm_source.py`). Treating it as adoptable offered an "Add"
  // that could only produce a declaration pointing at an empty store.
  if (!declared && onDisk && sodStore === 'env-local') return 'adoptable';
  return 'missing';
}

function rowState(members: CredentialMember[]): CredentialRowState {
  const required = members.filter((m) => m.required);
  // No required members at all (every member optional) — treat presence of any
  // met member as connected rather than dividing by zero into "partial".
  const target = required.length ? required : members;
  if (target.length && target.every((m) => m.state === 'met')) return 'connected';
  if (members.some((m) => m.state === 'met' || m.state === 'adoptable')) return 'partial';
  return 'none';
}

function buildMember(
  envVar: string,
  spec: CredentialVar | undefined,
  declared: ProjectSecretOriginSummary | undefined,
  resolve: SecretResolveStatus | undefined,
  onDisk: EnvLocalKey | undefined,
  sodStore: SodStore,
): CredentialMember {
  return {
    envVar,
    label: spec?.label || envVar,
    secret: isSecret(spec),
    required: isRequired(spec),
    state: memberState(envVar, declared, resolve, onDisk, sodStore),
    declared: !!declared,
    foundIn: resolve?.found_in ?? undefined,
    line: onDisk?.line,
    typeid: declared?.typeid,
    hint: spec?.hint,
    placeholder: spec?.placeholder,
    helpUrl: spec?.help_url,
  };
}

/**
 * Group declarations and detected keys into one row per credential.
 *
 * A row is emitted when it has STATE — at least one member declared or detected
 * on disk. That is what "only existing things" means: the full catalogue lives
 * behind Add connection, not in the table. Note "detected" counts: a machine
 * whose `.env.local` already holds both Gmail values has a Gmail credential in
 * every sense that matters to the person looking at it, even though nothing has
 * declared it yet — showing it as absent and making them hunt for it in the
 * picker would be obtuse.
 */
export function buildCredentialRows({
  specs,
  secretOrigins,
  status,
  envLocalKeys,
}: BuildCredentialRowsInput): CredentialRow[] {
  const statusByVar = new Map(status.map((s) => [s.env_var, s]));
  const declaredByVar = new Map(
    secretOrigins.filter((o) => o?.env_var).map((o) => [o.env_var, o]),
  );
  const onDiskByVar = new Map(envLocalKeys.map((k) => [k.key, k]));

  const rows: CredentialRow[] = [];
  const claimed = new Set<string>();

  for (const spec of specs) {
    const names = spec.varNames;
    if (!names.length) continue;

    const members = names.map((envVar) =>
      buildMember(
        envVar,
        spec.vars?.[envVar],
        declaredByVar.get(envVar),
        statusByVar.get(envVar),
        onDiskByVar.get(envVar),
        spec.sodStore,
      ),
    );

    // A credential EXISTS when its values do. Anything less is not a row: no
    // half-states, no "0 of 2" — if the key is not there, the connection is not
    // there, and it belongs in the Add dialog instead. A declaration without a
    // value is bookkeeping, not a connection, and must not conjure a row.
    // Claim the names FIRST, whether or not this becomes a row. A spec owns its
    // variables either way, so a half-satisfied credential must not leak the
    // half that IS set as a standalone one-member row — `GMAIL_APP_PASSWORD` is
    // part of Gmail, not a credential in its own right.
    names.forEach((n) => claimed.add(n));

    const required = members.filter((m) => m.required);
    const present = (m: CredentialMember) => m.state === 'met' || m.state === 'adoptable';
    if (!required.length || !required.every(present)) continue;

    // `name` is the registry key AND the folder name AND the asset id — one
    // noun — but it is nullable on `APIEntity`, so pin it once here rather than
    // at each use.
    const name = String(spec.name ?? '').trim() || String(spec.title ?? '').trim();
    if (!name) continue;

    rows.push({
      key: name,
      title: String(spec.title ?? '').trim() || name,
      iconName: spec.icon_name || undefined,
      helpUrl: spec.help_url || undefined,
      description: spec.description || undefined,
      members,
      state: rowState(members),
      metCount: required.filter((m) => m.state === 'met').length,
      requiredCount: required.length,
      adoptableCount: members.filter((m) => m.state === 'adoptable').length,
      declaredCount: members.filter((m) => m.declared).length,
      adHoc: false,
      sodStore: spec.sodStore,
    });
  }

  // Every DECLARED env var no spec claimed is its own one-member row. This is
  // the identity that lets the Project Environment tab be deleted rather than
  // merely hidden: a bare declaration is a degenerate credential.
  //
  // Detected-but-undeclared keys are deliberately NOT promoted here — a
  // `.env.local` holds ports and feature flags too (LOCAL_SERVER_PORT,
  // VITE_PORT), and a row per line would bury the real credentials. They surface
  // only when a spec claims them, or once someone declares one.
  for (const origin of secretOrigins) {
    const envVar = origin?.env_var;
    if (!envVar || claimed.has(envVar)) continue;
    const adHocStore: SodStore = origin.sod_store === 'sodot' ? 'sodot' : 'env-local';
    const member = buildMember(
      envVar,
      undefined,
      origin,
      statusByVar.get(envVar),
      onDiskByVar.get(envVar),
      adHocStore,
    );
    // Same rule as a spec-backed row: no value, no connection. A declaration
    // whose value was never supplied is bookkeeping — showing it would put a
    // row in the table for something that does not work.
    if (member.state === 'missing') continue;
    claimed.add(envVar);
    rows.push({
      key: envVar,
      title: envVar,
      description: origin.description || undefined,
      members: [member],
      state: rowState([member]),
      metCount: member.state === 'met' ? 1 : 0,
      requiredCount: 1,
      adoptableCount: member.state === 'adoptable' ? 1 : 0,
      declaredCount: member.declared ? 1 : 0,
      adHoc: true,
      // An ad-hoc row has no definition to ask, so the declaration itself is the
      // only authority on where its value goes.
      sodStore: adHocStore,
    });
  }

  // Known providers first, then ad-hoc; alphabetical within. Deliberately NOT
  // unmet-first: a row must not jump out from under the cursor the moment a
  // value is provided.
  return rows.sort(
    (a, b) => Number(a.adHoc) - Number(b.adHoc) || a.title.localeCompare(b.title),
  );
}
