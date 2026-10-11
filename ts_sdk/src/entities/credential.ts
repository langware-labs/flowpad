/**
 * Credential — a named set of environment variables, and the only way to
 * declare secrets (flow_sdk/builtin/credential.py).
 *
 * Where the folder lives is its scope: a project (`<project>/agentic-assets/
 * credential/<name>/`), the user (`~/agentic-assets/credential/<name>/`), or the
 * shipped catalogue (`system` — a template, added to one of the other two).
 * Where its values live is a deployment's, never the credential's (this computer
 * keeps them in the scope's `.env.local` unless told otherwise). Declaring,
 * filling and removing go through `credentialsService`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

/**
 * How much a project needs one variable (`flow_sdk` `CredentialRequirement`).
 * `MUST`: the app does not work without it. `OPTIONAL`: it turns a feature, an
 * integration or a deployment on.
 */
export const CredentialRequirement = { MUST: 'MUST', OPTIONAL: 'OPTIONAL' } as const;
export type CredentialRequirement = (typeof CredentialRequirement)[keyof typeof CredentialRequirement];

/** What a variable's value IS: the value (`text`), or a file's content kept as a file (`file`) — the
 *  variable then holds the file's path. */
export type CredentialVarKind = 'text' | 'file';

/** One environment variable a credential is made of, as the manifest declares it. */
export interface CredentialVar {
  label?: string;
  hint?: string;
  placeholder?: string;
  /** Backend default is `MUST` — see `isRequired`, never read this raw. A manifest or row
   *  written before the enum may still carry a boolean. */
  required?: CredentialRequirement | boolean;
  /** Regex the value must match. */
  pattern?: string;
  advanced?: boolean;
  /** Names the remote account (GMAIL_ADDRESS). Descriptive only. */
  account_key?: boolean;
  /** Backend default is TRUE — see `isSecret`, never read this raw. */
  secret?: boolean;
  /** Where to obtain THIS value; differs per member within one credential. */
  help_url?: string;
  /** Backend default is `text`. */
  kind?: CredentialVarKind;
}

/**
 * `required` defaults `MUST` and `secret` defaults TRUE on the backend, and a
 * manifest that accepts the default sends NOTHING. Reading `v.secret` directly
 * would treat the common case as `false` — the unsafe direction for a secret;
 * reading `v.required` for truth would treat `'OPTIONAL'` (a non-empty string) as
 * required.
 */
export function requirementOf(v: { required?: CredentialRequirement | boolean } | undefined): CredentialRequirement {
  const r = v?.required;
  return r === false || r === CredentialRequirement.OPTIONAL ? CredentialRequirement.OPTIONAL : CredentialRequirement.MUST;
}
export function isRequired(v: { required?: CredentialRequirement | boolean } | undefined): boolean {
  return requirementOf(v) === CredentialRequirement.MUST;
}
export function isSecret(v: CredentialVar | undefined): boolean {
  return v?.secret !== false;
}

export interface ICredential extends IEntity {
  title?: string;
  description?: string;
  /** What it is needed for, in one line, and the full reason behind the info icon. */
  needed_for?: string;
  justification?: string;
  icon_name?: string;
  help_url?: string;
  setup_wiki?: string;
  /** How an agent obtains and stores the values (`flow project setup`'s AI setup). */
  setup?: string;
  /** How long an agent following `setup` gets (seconds); unset = the default. */
  setup_timeout_seconds?: number | null;
  /** The LLM API provider this credential's single key funds, if any. */
  lm_provider?: string;
  vars?: Record<string, CredentialVar>;
  manifest_schema?: number;
  /** `user` | `project` | `system` (a shipped template). */
  scope?: string | null;
  project_id?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Credential extends EntityMerge<ICredential> {}

@registerEntity
export class Credential extends APIEntity<Credential> implements ICredential {
  static type: string = 'credential';

  title: string = '';
  description: string = '';
  needed_for: string = '';
  justification: string = '';
  /** A lucide glyph for THIS provider. Not `icon`: `APIEntity.icon` is a getter. */
  icon_name: string = '';
  help_url: string = '';
  setup_wiki: string = '';
  setup: string = '';
  setup_timeout_seconds: number | null = null;
  lm_provider: string = '';
  vars: Record<string, CredentialVar> = {};
  manifest_schema: number = 2;

  /**
   * Re-apply the payload after construction: `useDefineForClassFields: false`
   * emits every initializer above AFTER `super(json)`, so a list-query row would
   * otherwise arrive with `vars` as `{}`.
   */
  constructor(json: ICredential | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }

  /** Every variable, in manifest order. */
  get varNames(): string[] {
    return Object.keys(this.vars ?? {});
  }

  /** The variables that must be satisfied for the credential to be usable. */
  get requiredVarNames(): string[] {
    return Object.entries(this.vars ?? {})
      .filter(([, v]) => isRequired(v))
      .map(([k]) => k);
  }

  /** A shipped catalogue entry — added to a scope, never used directly. */
  get isTemplate(): boolean {
    return this.scope === 'system';
  }
}
