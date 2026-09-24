/**
 * Credentials — declare, fill and remove secret packs in the user or project
 * scope (flow_sdk/app/actions/credentials_action.py).
 *
 * A credential is a `SecretPack` folder: a named set of environment
 * variables. Its values live in the scope's `.env.local` (default) or the
 * encrypted vault. Nothing here ever returns a value — status carries names and
 * presence only. A refused write carries a fixable `error_code` in the standard
 * envelope (`vault-disabled`, `tracked`, `not-ignored`, …).
 */
import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { isHubOnly } from '../utils/hub-runtime';

export type CredentialScopeName = 'user' | 'project';
export type CredentialValueStore = 'env' | 'vault';

/** This computer's credential environment — every other one is a Deployment's `environment`. */
export const DEFAULT_CREDENTIAL_ENVIRONMENT = 'development';

/** The env file an environment's values live in: `.env.local`, or `.env.<env>.local`. */
export function credentialEnvFileName(environment: string = DEFAULT_CREDENTIAL_ENVIRONMENT): string {
  return environment === DEFAULT_CREDENTIAL_ENVIRONMENT ? '.env.local' : `.env.${environment}.local`;
}

/** How one environment differs from a credential's defaults. */
export interface CredentialEnvironmentSettings {
  value_store?: CredentialValueStore | null;
  required?: string[] | null;
}

export interface CredentialVarStatus {
  env_var: string;
  label: string;
  hint: string;
  placeholder: string;
  pattern: string;
  help_url: string;
  secret: boolean;
  required: boolean;
  /** A value exists in this credential's own store. */
  present: boolean;
  /** Where a value was found at all. */
  found_in: CredentialValueStore | null;
  /** `wrong-store`: a value exists, but in the store this credential does not read. */
  warning: 'missing' | 'wrong-store' | null;
  /** The project credential overriding this user one, if any. */
  shadowed_by: string | null;
}

export interface CredentialStatusRow {
  typeid: string;
  name: string;
  title: string;
  description: string;
  icon_name: string;
  help_url: string;
  setup_wiki: string;
  setup: string;
  scope: CredentialScopeName;
  project_id: string | null;
  /** The environment these presences were read for. */
  environment: string;
  /** This credential's store in that environment. */
  value_store: CredentialValueStore;
  /** The manifest's own store and per-environment overrides, for an edit to send back. */
  default_value_store: CredentialValueStore;
  environments: Record<string, CredentialEnvironmentSettings>;
  lm_provider: string;
  state: 'connected' | 'partial' | 'missing';
  vars: CredentialVarStatus[];
}

export interface DetectedEnvKey {
  key: string;
  line: number;
}

export interface CredentialScopeFile {
  scope: CredentialScopeName;
  project_id: string | null;
  /** The environment this env file belongs to. */
  environment: string;
  path: string | null;
  exists: boolean;
  /** A value cannot be written here (a committable `.env.local`, no folder). */
  blocked: boolean;
  block_code: string | null;
  block_reason: string | null;
  detected: DetectedEnvKey[];
}

export interface CredentialsStatus {
  project_id: string | null;
  /** The environment this status was read for. */
  environment: string;
  /** Every environment there is: `development` plus each Deployment's. */
  environments: string[];
  vault_enabled: boolean;
  credentials: CredentialStatusRow[];
  files: CredentialScopeFile[];
}

/** What a write answers: which credential, and where it lives. */
export interface CredentialSaved {
  typeid: string;
  name: string;
  title: string;
  scope: CredentialScopeName;
  project_id: string | null;
}

export interface CredentialManifestVar {
  label?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  pattern?: string;
  advanced?: boolean;
  account_key?: boolean;
  secret?: boolean;
  help_url?: string;
}

export interface CredentialManifestInput {
  name: string;
  title?: string;
  description?: string;
  icon_name?: string;
  help_url?: string;
  setup_wiki?: string;
  /** How an agent obtains and stores the values. Required when saving. */
  setup?: string;
  value_store?: CredentialValueStore;
  lm_provider?: string;
  vars: Record<string, CredentialManifestVar>;
  /** Per-environment overrides of the store or the required set. */
  environments?: Record<string, CredentialEnvironmentSettings>;
}

export interface SaveCredentialRequest {
  /** Required to create; ignored on update, which keeps the credential's scope. */
  scope?: CredentialScopeName;
  project_id?: string | null;
  /** Present to update an existing credential. */
  typeid?: string;
  manifest: CredentialManifestInput;
  /** Written before the credential is created; empty values are skipped. */
  values?: Record<string, string>;
  /** The environment `values` are written into; `development` when omitted. */
  environment?: string;
}

export const EMPTY_CREDENTIALS_STATUS: CredentialsStatus = Object.freeze({
  project_id: null,
  environment: DEFAULT_CREDENTIAL_ENVIRONMENT,
  environments: [DEFAULT_CREDENTIAL_ENVIRONMENT],
  vault_enabled: false,
  credentials: [],
  files: [],
});

export class CredentialsService {
  constructor(private readonly node: { type: string; id: string }) {}

  private action(subpath: string, method: 'GET' | 'POST'): ActionInfo {
    const action = new ActionInfo('credentials', this.node.type, this.node.id, method);
    action.subpath = subpath;
    return action;
  }

  /** Every credential the user and (when given) the project declare, plus what
   *  each scope's env file holds — all read for one `environment`. */
  async status(
    projectId?: string | null,
    environment: string = DEFAULT_CREDENTIAL_ENVIRONMENT,
  ): Promise<CredentialsStatus> {
    // The hub has no `@local` node, no home folder and no vault of this machine.
    if (isHubOnly()) return EMPTY_CREDENTIALS_STATUS;
    const action = this.action('status', 'GET');
    const query: Record<string, string> = {};
    if (projectId) query.project_id = projectId;
    if (environment !== DEFAULT_CREDENTIAL_ENVIRONMENT) query.environment = environment;
    if (Object.keys(query).length) action.queryParameters = query;
    return (await dataManager.callAction<unknown, CredentialsStatus>(action)) ?? EMPTY_CREDENTIALS_STATUS;
  }

  /** Create or update a credential, writing any values first. */
  async save(request: SaveCredentialRequest): Promise<CredentialSaved> {
    const action = this.action('save', 'POST');
    action.bodyParameters = { ...request };
    return dataManager.callAction<unknown, CredentialSaved>(action);
  }

  /** Fill a credential's values BY NAME, declaring it from its shipped template when this
   *  instance holds none yet (`flow credentials set`). The one call that does not need to
   *  know whether the declaration exists. */
  async setByName(
    name: string,
    values: Record<string, string>,
    projectId: string | null = null,
  ): Promise<CredentialSaved> {
    const action = this.action('set', 'POST');
    action.bodyParameters = projectId ? { name, values, project_id: projectId } : { name, values };
    return dataManager.callAction<unknown, CredentialSaved>(action);
  }

  /** Set or rotate one environment's values. Empty values are skipped, never cleared. */
  async setValues(
    typeid: string,
    values: Record<string, string>,
    environment: string = DEFAULT_CREDENTIAL_ENVIRONMENT,
  ): Promise<CredentialSaved> {
    const action = this.action('values', 'POST');
    action.bodyParameters =
      environment === DEFAULT_CREDENTIAL_ENVIRONMENT ? { typeid, values } : { typeid, values, environment };
    return dataManager.callAction<unknown, CredentialSaved>(action);
  }

  /** Remove a credential. `kept` names variables whose lines stay in `.env.local`. */
  async remove(typeid: string): Promise<{ deleted: string[]; kept: string[] }> {
    const action = this.action('delete', 'POST');
    action.bodyParameters = { typeid };
    const res = await dataManager.callAction<unknown, { deleted?: string[]; kept?: string[] }>(action);
    return { deleted: res?.deleted ?? [], kept: res?.kept ?? [] };
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const credentialsService = new CredentialsService({ type: 'compute_node', id: '@local' });
