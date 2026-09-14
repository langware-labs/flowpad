/**
 * The one credential form's state — pure, so every rule is testable without a
 * render.
 *
 * Every way of declaring a secret builds a draft and saves it through the same
 * `credentialsService.save`:
 *
 * - `custom`   — Custom credentials: the user names the variables.
 * - `template` — a catalogue entry (Gmail, OpenRouter): names are fixed.
 * - `pack`     — keys already in a `.env.local`: names are fixed, no values asked.
 * - `edit`     — change an existing credential's description and variables.
 * - `values`   — set or rotate an existing credential's values.
 */
import type {
  CredentialManifestVar,
  CredentialScopeName,
  CredentialSpec,
  CredentialStatusRow,
  CredentialValueStore,
  SaveCredentialRequest,
} from '@sdk';
import { isRequired, isSecret } from '@sdk';
import { MAX_ENV_VAR_VALUE_LENGTH } from '@src/constants/validation';

export type DraftMode = 'custom' | 'template' | 'pack' | 'edit' | 'values';

export const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DraftVar {
  /** Stable React key; env var names change while typing. */
  id: string;
  envVar: string;
  /** What this variable is for — the manifest's `hint`. */
  description: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string;
  pattern: string;
  helpUrl: string;
  /** Manifest fields the form does not edit (e.g. `account_key`), kept verbatim. */
  base: CredentialManifestVar;
  value: string;
}

export interface CredentialDraft {
  mode: DraftMode;
  typeid?: string;
  name: string;
  title: string;
  description: string;
  iconName: string;
  helpUrl: string;
  scope: CredentialScopeName;
  store: CredentialValueStore;
  lmProvider: string;
  vars: DraftVar[];
}

export type DraftProblem =
  | 'title-required'
  | 'no-vars'
  | 'bad-env-var'
  | 'duplicate'
  | 'taken'
  | 'required-value'
  | 'too-long'
  | 'pattern';

export interface DraftProblems {
  form: DraftProblem[];
  vars: Record<string, DraftProblem>;
}

let nextId = 0;
const varId = () => `var-${++nextId}`;

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'credential'
  );
}

/** `My Stripe key` → `MY_STRIPE_KEY`. */
export function toEnvVarName(text: string): string {
  const name = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

export function emptyVar(envVar = ''): DraftVar {
  return {
    id: varId(),
    envVar,
    description: '',
    label: '',
    secret: true,
    required: true,
    placeholder: '',
    pattern: '',
    helpUrl: '',
    base: {},
    value: '',
  };
}

function fromManifestVar(envVar: string, v: CredentialManifestVar | undefined): DraftVar {
  return {
    ...emptyVar(envVar),
    description: v?.hint ?? '',
    label: v?.label ?? '',
    secret: isSecret(v),
    required: isRequired(v),
    placeholder: v?.placeholder ?? '',
    pattern: v?.pattern ?? '',
    helpUrl: v?.help_url ?? '',
    base: v ?? {},
  };
}

export function customDraft(scope: CredentialScopeName): CredentialDraft {
  return {
    mode: 'custom',
    name: '',
    title: '',
    description: '',
    iconName: '',
    helpUrl: '',
    scope,
    store: 'env',
    lmProvider: '',
    vars: [emptyVar()],
  };
}

export function templateDraft(spec: CredentialSpec, scope: CredentialScopeName): CredentialDraft {
  const lmProvider = spec.lm_provider || '';
  return {
    mode: 'template',
    name: String(spec.name ?? ''),
    title: spec.title || String(spec.name ?? ''),
    description: spec.description || '',
    iconName: spec.icon_name || '',
    helpUrl: spec.help_url || '',
    // A provider key funds every project on this machine: user scope, vault.
    scope: lmProvider ? 'user' : scope,
    store: lmProvider ? 'vault' : spec.value_store === 'vault' ? 'vault' : 'env',
    lmProvider,
    vars: spec.varNames.map((name) => fromManifestVar(name, spec.vars?.[name])),
  };
}

export function packDraft(keys: string[], scope: CredentialScopeName): CredentialDraft {
  return {
    ...customDraft(scope),
    mode: 'pack',
    // The values are already in this scope's .env.local.
    store: 'env',
    vars: keys.map((key) => emptyVar(key)),
  };
}

function fromRow(row: CredentialStatusRow, mode: 'edit' | 'values'): CredentialDraft {
  return {
    mode,
    typeid: row.typeid,
    name: row.name,
    title: row.title,
    description: row.description,
    iconName: row.icon_name,
    helpUrl: row.help_url,
    scope: row.scope,
    store: row.value_store,
    lmProvider: row.lm_provider,
    vars: row.vars.map((v) =>
      fromManifestVar(v.env_var, {
        label: v.label || undefined,
        hint: v.hint || undefined,
        placeholder: v.placeholder || undefined,
        pattern: v.pattern || undefined,
        help_url: v.help_url || undefined,
        secret: v.secret,
        required: v.required,
      }),
    ),
  };
}

export const editDraft = (row: CredentialStatusRow) => fromRow(row, 'edit');
export const valuesDraft = (row: CredentialStatusRow) => fromRow(row, 'values');

/** The variable names are fixed by a template, a pack, or a values-only edit. */
export const namesLocked = (d: CredentialDraft) => d.mode === 'template' || d.mode === 'pack' || d.mode === 'values';
/** Scope is chosen once, at creation; a provider key is always the user's. */
export const scopeLocked = (d: CredentialDraft) => !!d.typeid || d.mode === 'pack' || !!d.lmProvider;
/** A provider key lives in the vault; packed keys already live in the file. */
export const storeLocked = (d: CredentialDraft) => d.mode === 'values' || d.mode === 'pack' || !!d.lmProvider;
/** Only the header fields and variable definitions — values are asked separately. */
export const asksDefinition = (d: CredentialDraft) => d.mode !== 'values';
export const asksValues = (d: CredentialDraft) => d.mode !== 'pack' && d.mode !== 'edit';

function valueProblem(v: DraftVar, d: CredentialDraft): DraftProblem | null {
  if (!asksValues(d)) return null;
  const value = v.value;
  if (!value) return v.required && d.mode === 'template' ? 'required-value' : null;
  if (value.length > MAX_ENV_VAR_VALUE_LENGTH) return 'too-long';
  if (v.pattern) {
    try {
      if (!new RegExp(v.pattern).test(value)) return 'pattern';
    } catch {
      // A bad pattern in a shipped asset must not make a key unenterable.
    }
  }
  return null;
}

/**
 * What stops this draft from being saved. `taken` is every variable another
 * credential in the chosen scope already declares.
 */
export function validateDraft(d: CredentialDraft, taken: ReadonlySet<string>): DraftProblems {
  const problems: DraftProblems = { form: [], vars: {} };
  if (asksDefinition(d) && !d.title.trim()) problems.form.push('title-required');
  if (!d.vars.length) problems.form.push('no-vars');
  const seen = new Set<string>();
  for (const v of d.vars) {
    const name = v.envVar.trim();
    let problem: DraftProblem | null = null;
    if (!ENV_VAR_RE.test(name)) problem = 'bad-env-var';
    else if (seen.has(name)) problem = 'duplicate';
    else if (d.mode !== 'values' && taken.has(name)) problem = 'taken';
    else problem = valueProblem(v, d);
    seen.add(name);
    if (problem) problems.vars[v.id] = problem;
  }
  return problems;
}

export const hasProblems = (p: DraftProblems) => p.form.length > 0 || Object.keys(p.vars).length > 0;

/** The values to write: filled ones only. */
export function draftValues(d: CredentialDraft): Record<string, string> {
  if (!asksValues(d)) return {};
  return Object.fromEntries(d.vars.filter((v) => v.value).map((v) => [v.envVar.trim(), v.value]));
}

export function toSaveRequest(d: CredentialDraft, projectId: string | null): SaveCredentialRequest {
  const vars: Record<string, CredentialManifestVar> = {};
  for (const v of d.vars) {
    const name = v.envVar.trim();
    vars[name] = {
      ...v.base,
      label: v.label || undefined,
      hint: v.description.trim() || undefined,
      placeholder: v.placeholder || undefined,
      pattern: v.pattern || undefined,
      help_url: v.helpUrl || undefined,
      secret: v.secret,
      required: v.required,
    };
  }
  return {
    ...(d.typeid ? { typeid: d.typeid } : { scope: d.scope, project_id: d.scope === 'project' ? projectId : null }),
    manifest: {
      name: d.name || slugify(d.title),
      title: d.title.trim(),
      description: d.description.trim(),
      icon_name: d.iconName || undefined,
      help_url: d.helpUrl || undefined,
      value_store: d.store,
      lm_provider: d.lmProvider || undefined,
      vars,
    },
    values: draftValues(d),
  };
}
