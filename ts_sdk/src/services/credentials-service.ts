/**
 * Credentials — declare, fill and remove credentials in the user or project
 * scope (flow_sdk/app/actions/credentials_action.py).
 *
 * A credential is a `Credential` folder: a named set of environment
 * variables. WHERE its values live is a deployment's (this computer's by default):
 * the scope's `.env.local`, the encrypted vault, or a remote store, per variable.
 * Nothing here ever returns a value — status carries names and
 * presence only. A refused write carries a fixable `error_code` in the standard
 * envelope (`vault-disabled`, `tracked`, `not-ignored`, …).
 */
import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { isHubOnly } from '../utils/hub-runtime';
import type { CredentialRequirement, CredentialVarKind } from '../entities/credential';

export type CredentialScopeName = 'user' | 'project';
/** A store a form can choose: the scope's env file, or the vault. */
export type LocalValueStore = 'env' | 'vault';
/** Where a deployment keeps a value: a local store, or a remote store's type. */
export type CredentialValueStore = LocalValueStore | (string & {});

/** This computer's credential environment — every other one is a Deployment's `environment`. */
export const DEFAULT_CREDENTIAL_ENVIRONMENT = 'development';

/** The env file an environment's values live in: `.env.local`, or `.env.<env>.local`. */
export function credentialEnvFileName(environment: string = DEFAULT_CREDENTIAL_ENVIRONMENT): string {
  return environment === DEFAULT_CREDENTIAL_ENVIRONMENT ? '.env.local' : `.env.${environment}.local`;
}

export interface CredentialVarStatus {
  env_var: string;
  label: string;
  hint: string;
  placeholder: string;
  pattern: string;
  help_url: string;
  secret: boolean;
  /** What this deployment needs: the var's own requirement, raised to `MUST` when the deployment
   *  requires it. Read through `isRequired` — never for truth. */
  required: CredentialRequirement;
  /** `file`: the value is a file's content, kept as a file; the variable holds its path. */
  kind: CredentialVarKind;
  /** The store the chosen deployment keeps this variable in. */
  store: CredentialValueStore;
  /** A value exists in that store. */
  present: boolean;
  /** Where a value was found at all. */
  found_in: CredentialValueStore | null;
  /** `wrong-store`: a value exists, but in the other local store; `unreachable`: a remote store
   *  that could not be asked. */
  warning: 'missing' | 'wrong-store' | 'unreachable' | null;
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
  /** The environment of the deployment these presences were read for. */
  environment: string;
  /** Where that deployment keeps this credential; `mixed` when its variables are split. */
  value_store: CredentialValueStore;
  lm_provider: string;
  state: 'connected' | 'partial' | 'missing';
  vars: CredentialVarStatus[];
}

export interface DetectedEnvKey {
  key: string;
  line: number;
}

/** A file a scope's env store falls back to: read, never written. */
export interface CredentialEnvFallback {
  path: string;
  /** As the project manifest declares it (`backend/.env`). */
  extra_path: string;
  exists: boolean;
  detected: DetectedEnvKey[];
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
  /** The files read after this one, in order — a project's declared `env_files` (development only). */
  fallbacks?: CredentialEnvFallback[];
}

/** A deployment the Credentials screen can show values for. */
export interface CredentialDeployment {
  id: string;
  name: string;
  environment: string;
  this_computer: boolean;
}

export interface CredentialsStatus {
  project_id: string | null;
  /** The deployment this status was read for, and its environment. */
  deployment_id: string;
  environment: string;
  /** Every deployment there is: this computer first. */
  deployments: CredentialDeployment[];
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

/** What deleting a credential did in ONE store. Names only. */
export interface StoreForgotten {
  type: string;
  where: string;
  deleted: string[];
  kept: string[];
  /** Why the store could not be checked; every name counts as kept. */
  error: string;
}

/** What "use mine" copied into a deployment's store, and what this computer does not hold. Names only. */
export interface UseMineResult {
  copied: string[];
  not_here: string[];
  /** LLM provider keys, never copied: a deployment is hub-funded. */
  hub_funded: string[];
}

/** A credential is removed only when no store still holds one of its values. */
export interface CredentialDeleted {
  removed: boolean;
  deleted: string[];
  kept: string[];
  stores: StoreForgotten[];
}

export interface CredentialManifestVar {
  label?: string;
  hint?: string;
  placeholder?: string;
  required?: CredentialRequirement;
  kind?: CredentialVarKind;
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
  lm_provider?: string;
  vars: Record<string, CredentialManifestVar>;
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
  /** The deployment `values` are written at; this computer when omitted. */
  deployment_id?: string;
  /** Make that deployment keep this credential's variables in this store first. */
  store?: LocalValueStore;
}

export const EMPTY_CREDENTIALS_STATUS: CredentialsStatus = Object.freeze({
  project_id: null,
  deployment_id: '',
  environment: DEFAULT_CREDENTIAL_ENVIRONMENT,
  deployments: [],
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
   *  each scope's env file holds — all read at one deployment (default: this computer). */
  async status(projectId?: string | null, deploymentId?: string | null): Promise<CredentialsStatus> {
    // The hub has no `@local` node, no home folder and no vault of this machine.
    if (isHubOnly()) return EMPTY_CREDENTIALS_STATUS;
    const action = this.action('status', 'GET');
    const query: Record<string, string> = {};
    if (projectId) query.project_id = projectId;
    if (deploymentId) query.deployment_id = deploymentId;
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

  /** Set or rotate the values one deployment (default: this computer) reads. Empty values are
   *  skipped, never cleared. */
  async setValues(typeid: string, values: Record<string, string>, deploymentId?: string | null): Promise<CredentialSaved> {
    const action = this.action('values', 'POST');
    action.bodyParameters = deploymentId ? { typeid, values, deployment_id: deploymentId } : { typeid, values };
    return dataManager.callAction<unknown, CredentialSaved>(action);
  }

  /** Copy this computer's values into a deployment's store — for a cloud deployment the hub, which
   *  places them on its machine. `names` omitted: every value it lacks. Names come back, never a value. */
  async useMine(deploymentId: string, names?: string[]): Promise<UseMineResult> {
    const action = this.action('use-mine', 'POST');
    action.bodyParameters = { deployment_id: deploymentId, names: names?.length ? names : null };
    const res = await dataManager.callAction<unknown, Partial<UseMineResult>>(action);
    return { copied: res?.copied ?? [], not_here: res?.not_here ?? [], hub_funded: res?.hub_funded ?? [] };
  }

  /** Remove a credential and its values from every store. `removed` is false, and the
   *  credential stays, when a store still holds a value (`kept`) or could not be reached. */
  async remove(typeid: string): Promise<CredentialDeleted> {
    const action = this.action('delete', 'POST');
    action.bodyParameters = { typeid };
    const res = await dataManager.callAction<unknown, Partial<CredentialDeleted>>(action);
    return { removed: !!res?.removed, deleted: res?.deleted ?? [], kept: res?.kept ?? [], stores: res?.stores ?? [] };
  }
}

/** Ready-to-use singleton wired to the local compute node. */
export const credentialsService = new CredentialsService({ type: 'compute_node', id: '@local' });
