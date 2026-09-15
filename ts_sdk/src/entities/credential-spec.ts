/**
 * CredentialSpec — a named set of environment variables, and the only way to
 * declare secrets (flow_sdk/builtin/credential_spec.py).
 *
 * Where the folder lives is its scope: a project (`<project>/agentic-assets/
 * credential/<name>/`), the user (`~/agentic-assets/credential/<name>/`), or the
 * shipped catalogue (`system` — a template, added to one of the other two).
 * `value_store` says where its values live: the scope's `.env.local` or the
 * encrypted vault. Declaring, filling and removing go through
 * `credentialsService`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';

/** One environment variable a credential is made of, as the manifest declares it. */
export interface CredentialVar {
  label?: string;
  hint?: string;
  placeholder?: string;
  /** Backend default is TRUE — see `isRequired`, never read this raw. */
  required?: boolean;
  /** Regex the value must match. */
  pattern?: string;
  advanced?: boolean;
  /** Names the remote account (GMAIL_ADDRESS). Descriptive only. */
  account_key?: boolean;
  /** Backend default is TRUE — see `isSecret`, never read this raw. */
  secret?: boolean;
  /** Where to obtain THIS value; differs per member within one credential. */
  help_url?: string;
}

/**
 * `required` and `secret` both default TRUE on the backend, and a manifest that
 * accepts the default sends NOTHING. Reading `v.secret` directly would treat
 * the common case as `false` — the unsafe direction for a secret.
 */
export function isRequired(v: CredentialVar | undefined): boolean {
  return v?.required !== false;
}
export function isSecret(v: CredentialVar | undefined): boolean {
  return v?.secret !== false;
}

export interface ICredentialSpec extends IEntity {
  title?: string;
  description?: string;
  icon_name?: string;
  help_url?: string;
  setup_wiki?: string;
  value_store?: 'env' | 'vault';
  /** The LLM API provider this credential's single key funds, if any. */
  lm_provider?: string;
  vars?: Record<string, CredentialVar>;
  manifest_schema?: number;
  /** `user` | `project` | `system` (a shipped template). */
  scope?: string | null;
  project_id?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CredentialSpec extends EntityMerge<ICredentialSpec> {}

@registerEntity
export class CredentialSpec extends APIEntity<CredentialSpec> implements ICredentialSpec {
  static type: string = 'credential_spec';

  title: string = '';
  description: string = '';
  /** A lucide glyph for THIS provider. Not `icon`: `APIEntity.icon` is a getter. */
  icon_name: string = '';
  help_url: string = '';
  setup_wiki: string = '';
  value_store: 'env' | 'vault' = 'env';
  lm_provider: string = '';
  vars: Record<string, CredentialVar> = {};
  manifest_schema: number = 2;

  /**
   * Re-apply the payload after construction: `useDefineForClassFields: false`
   * emits every initializer above AFTER `super(json)`, so a list-query row would
   * otherwise arrive with `vars` as `{}`.
   */
  constructor(json: ICredentialSpec | undefined = undefined) {
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
