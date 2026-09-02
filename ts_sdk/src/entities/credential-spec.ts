/**
 * CredentialSpec — the authored definition of a named credential
 * (flow_sdk/builtin/credential_spec.py).
 *
 * A credential is a NAMED SET OF ENVIRONMENT VARIABLES a provider needs: Gmail
 * is `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD`. This is the definition of that set
 * — not the values, and not any project's decision to require them.
 *
 *     CredentialSpec  :  SecretOrigin
 *           ==
 *     DataSourceSpec  :  DataSource
 *
 * It is why the Connections table no longer needs a hardcoded provider catalog:
 * `vars` comes from an indexed asset, so a new provider lights up the picker
 * without a frontend release.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity, EntityMerge } from '../IEntity';
import type { SecretOriginLocator, SodStore } from './project';

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
  /**
   * The name this value is stored under in the encrypted `sodot` store.
   * Derived by the backend, never authored — see `CredentialVarSpec.sod_name`.
   * Empty for an `env-local` credential, which is addressed by its env key.
   */
  sod_name?: string;
}

/**
 * `required` and `secret` both default TRUE on the backend
 * (`CredentialVarSpec`), and `exclude_defaults` means a manifest that accepts
 * the default sends NOTHING. Reading `v.secret` directly therefore treats the
 * common case as `false` — the unsafe direction for a secret. These two helpers
 * are the only sanctioned readers.
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
  default_store?: string;
  /** The LLM API provider this credential's key authenticates against, if any. */
  lm_provider?: string;
  vars?: Record<string, CredentialVar>;
  manifest_schema?: number;
}

// `implements ICredentialSpec` only checks the class; it contributes no members, so every
// field declared solely on ICredentialSpec reads as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CredentialSpec extends EntityMerge<ICredentialSpec> {}

@registerEntity
export class CredentialSpec extends APIEntity<CredentialSpec> implements ICredentialSpec {
  static type: string = 'credential_spec';

  title: string = '';
  description: string = '';
  /**
   * A lucide glyph for THIS provider. Deliberately not `icon`: `APIEntity.icon`
   * is a getter with no setter returning the TYPE's registry glyph, and a row
   * carrying an `icon` key throws during hydration — inside the query, which
   * empties the result instead of raising. That blanked the whole provider list
   * once already on `DataSourceSpec`.
   */
  icon_name: string = '';
  help_url: string = '';
  setup_wiki: string = '';
  default_store: string = 'env-local';
  lm_provider: string = '';
  vars: Record<string, CredentialVar> = {};
  manifest_schema: number = 1;

  /**
   * Re-apply the payload after construction.
   *
   * `ts_sdk` compiles with `useDefineForClassFields: false`, so every field
   * initializer above is emitted as an assignment AFTER `super(json)` — the base
   * constructor's `deepAssign` lands first and each default then overwrites it.
   * A row fetched by a LIST query (the only `new` path) therefore arrives with
   * `vars` as `{}`, so every credential would render with **zero members**,
   * silently, with no error.
   *
   * `Team`, `Group`, `Prompt` and `DataSourceSpec` carry the same hand-written
   * constructor. This is the fifth; the real fix belongs in
   * `FlowSync/store.ts::castAndDeepAssign`, whose cache-MISS branch is a bare
   * `new entityConstructor(source)` while its cache-HIT branch does the careful
   * thing.
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

  /** The store a provided value defaults into. */
  get sodStore(): SodStore {
    return this.default_store === 'sodot' ? 'sodot' : 'env-local';
  }

  /**
   * The value-free locator one variable's declaration should start life with.
   *
   * Lives on the definition because the definition is what knows where its
   * values belong, and because the alternative — a caller branching on
   * `default_store` — put that branch in `declareCredential`, which hardcoded
   * `env-local` for every spec and so would have written an OpenRouter key
   * somewhere the LLM funding resolver never looks.
   *
   * The `sodot` name comes from the backend (`sod_name`), so the `lm_api.`
   * convention has no second spelling here.
   */
  locatorFor(envVar: string): SecretOriginLocator {
    if (this.sodStore !== 'sodot') return { kind: 'env-local', env_key: envVar };
    return { kind: 'local', sod_name: this.vars?.[envVar]?.sod_name || envVar };
  }
}
