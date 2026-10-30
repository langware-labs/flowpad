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
import type { CredentialRequirement, CredentialVarCommand, CredentialVarKind, CredentialWay } from '../entities/credential';

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
  /** `file`: the value is a file's content, kept as a file; the variable holds its path.
   *  `cli`: nothing is stored — a command-line tool holds the sign-in. `oauth`: nothing is stored —
   *  the connection holds the grant. */
  kind: CredentialVarKind;
  /** The store the chosen deployment keeps this variable in; `cli` for a `cli` variable. */
  store: CredentialValueStore;
  /** A value exists in that store; for a `cli` variable, its check passed. */
  present: boolean;
  /** Where this variable's shared value lives (`{vault, key}`); absent: not published yet. */
  secret_ref?: { vault: string; key: string } | null;
  /** `ONE_OF`: the way this variable belongs to; empty = its own name. */
  way?: string;
  /** `cli`: the command that signs in on THIS machine; empty for every other kind. */
  login?: string;
  /** `oauth`: the provider whose grant this way is, and the scopes it must cover (store `connection`). */
  provider?: string;
  scopes?: string[];
  /** `cli`: the declared commands, so an edit can save them back. */
  login_spec?: CredentialVarCommand | null;
  check_spec?: CredentialVarCommand | null;
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
  /** What it is needed for, in one line, and the full reason. */
  needed_for?: string;
  justification?: string;
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
  /** `env` (values are variables) or `oauth` (a provider's grant, held by the connection). */
  kind?: CredentialKind;
  /** oauth: the connection provider, the scopes the project needs, and those the held grant does not cover. */
  provider?: string;
  scopes?: string[];
  missing_scopes?: string[];
  /** `partial`: some values / a grant missing scopes; `needs_reauth`: oauth, the grant went stale. */
  state: 'connected' | 'partial' | 'missing' | 'needs_reauth';
  vars: CredentialVarStatus[];
  /** The ONE_OF way set up on this machine (the credential row's `setup_choice`); empty when none is chosen. */
  setup_choice?: string;
  /** `ONE_OF`: how each way of several variables is offered, by way name (`CredentialSpec.ways`). */
  ways?: Record<string, CredentialWay>;
  /** The credential declares a `test` (Test runs it; without one, Test asks an agent to write it). */
  has_test?: boolean;
  /** The last test run on this machine; absent = never tested here. */
  test_result?: CredentialTestResult | null;
}

/** A credential test's answer — value-free. `untested`: it declares no test. */
export interface CredentialTestResult {
  state: 'ok' | 'invalid' | 'error' | 'untested';
  detail: string;
  at: string;
}

/** What `credentials/test` answers: the result, and whether the credential declares a test at all. */
export type CredentialTestAnswer = CredentialTestResult & { has_test: boolean };

export type CredentialKind = 'env' | 'oauth';

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
  /** The project's vault names (`secret_vaults` in project_manifest.json) — where a teammate's
   *  values are published and fetched. Empty: none. */
  secret_vaults?: string[];
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

/** One vault of the project: which secret manager holds it, and that manager's config. Never a value. */
export interface SecretVault {
  manager: string;
  config: Record<string, unknown>;
}

/** A secret manager installed here (its `secret_manager.json`). */
export interface SecretManagerInfo {
  name: string;
  title: string;
  icon: string;
  description: string;
  config_fields: { name: string; label: string; required: boolean }[];
  install: Record<string, string>;
  login: Record<string, string>;
  check: string;
  grant: string;
}

/** What `publish` copied into a vault — names only. `not_here`: no value on this computer. */
export interface SecretPublishResult {
  published: string[];
  not_here: string[];
  vault: string;
}

/** What `fetch` brought from the vaults — names only. `missing`: no ref or no value in the vault;
 *  `denied`: vaults this person may not read. */
export interface SecretFetchResult {
  fetched: string[];
  missing: string[];
  denied: string[];
  vaults: string[];
}

/** Whether a vault is reachable from this computer. */
export interface SecretVaultCheck {
  vault: string;
  ready: boolean;
  reason: string;
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
  /** `cli` only. */
  login?: CredentialVarCommand | null;
  check?: CredentialVarCommand | null;
  pattern?: string;
  advanced?: boolean;
  account_key?: boolean;
  secret?: boolean;
  help_url?: string;
  way?: string;
}

export interface CredentialManifestInput {
  name: string;
  title?: string;
  description?: string;
  needed_for?: string;
  justification?: string;
  icon_name?: string;
  help_url?: string;
  setup_wiki?: string;
  /** How an agent obtains and stores the values. Required when saving. */
  setup?: string;
  lm_provider?: string;
  vars: Record<string, CredentialManifestVar>;
  ways?: Record<string, CredentialWay>;
}

export interface SaveCredentialRequest {
  /** Match a variable to its credential/template, creating or extending it as needed. */
  auto_declare?: boolean;
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

  // ── the project's vaults: values between people. A refusal carries `error_code`:
  //    `no_vault`, `unknown_vault`, `needs_connection` or `denied`. ──

  /** The secret managers this Flowpad can use. */
  async listManagers(): Promise<SecretManagerInfo[]> {
    const res = await dataManager.callAction<unknown, { managers?: SecretManagerInfo[] }>(this.action('managers', 'GET'));
    return res?.managers ?? [];
  }

  /** The project's vaults by name. */
  async vaults(projectId: string): Promise<Record<string, SecretVault>> {
    const action = this.action('vaults', 'GET');
    action.queryParameters = { project_id: projectId };
    const res = await dataManager.callAction<unknown, { vaults?: Record<string, SecretVault> }>(action);
    return res?.vaults ?? {};
  }

  /** Add or replace the project's vault `name`; answers every vault. */
  async addVault(projectId: string, name: string, vault: SecretVault): Promise<Record<string, SecretVault>> {
    return this.vaultWrite('vault-set', { project_id: projectId, name, spec: vault });
  }

  /** Forget the project's vault `name` (the manager keeps its secrets); answers every vault left. */
  async removeVault(projectId: string, name: string): Promise<Record<string, SecretVault>> {
    return this.vaultWrite('vault-remove', { project_id: projectId, name });
  }

  private async vaultWrite(verb: string, body: Record<string, unknown>): Promise<Record<string, SecretVault>> {
    const action = this.action(verb, 'POST');
    action.bodyParameters = body;
    const res = await dataManager.callAction<unknown, { vaults?: Record<string, SecretVault> }>(action);
    return res?.vaults ?? {};
  }

  /** Is `vault` reachable from this computer (manager installed, signed in)? */
  async checkVault(projectId: string, vault: string): Promise<SecretVaultCheck> {
    const action = this.action('vault-check', 'POST');
    action.bodyParameters = { project_id: projectId, vault };
    const res = await dataManager.callAction<unknown, Partial<SecretVaultCheck>>(action);
    return { vault, ready: res?.ready ?? false, reason: res?.reason ?? '' };
  }

  /** Copy this computer's values of credential `name` into `vault`, recording each variable's
   *  `secret_ref` in its credential.json. Names come back, never a value. */
  async publish(name: string, projectId: string, vault: string): Promise<SecretPublishResult> {
    const action = this.action('publish', 'POST');
    action.bodyParameters = { name, project_id: projectId, vault };
    const res = await dataManager.callAction<unknown, Partial<SecretPublishResult>>(action);
    return { published: res?.published ?? [], not_here: res?.not_here ?? [], vault: res?.vault ?? vault };
  }

  /** Fetch credential `name`'s values from the vaults its refs name into this computer's store. */
  async fetch(name: string, projectId: string): Promise<SecretFetchResult> {
    const action = this.action('fetch', 'POST');
    action.bodyParameters = { name, project_id: projectId };
    const res = await dataManager.callAction<unknown, Partial<SecretFetchResult>>(action);
    return { fetched: res?.fetched ?? [], missing: res?.missing ?? [], denied: res?.denied ?? [], vaults: res?.vaults ?? [] };
  }

  /** Run credential `name`'s `test` with this computer's values; `untested` when it declares none. */
  async test(name: string, projectId: string): Promise<CredentialTestAnswer> {
    const action = this.action('test', 'POST');
    action.bodyParameters = { name, project_id: projectId };
    const res = await dataManager.callAction<unknown, Partial<CredentialTestAnswer>>(action);
    return { has_test: !!res?.has_test, state: res?.state ?? 'error', detail: res?.detail ?? '', at: res?.at ?? '' };
  }

  /** Give `email` read access to `vault` through its manager's own sharing. */
  async grant(projectId: string, vault: string, email: string): Promise<{ vault: string; email: string }> {
    const action = this.action('grant', 'POST');
    action.bodyParameters = { project_id: projectId, vault, email };
    const res = await dataManager.callAction<unknown, Partial<{ vault: string; email: string }>>(action);
    return { vault: res?.vault ?? vault, email: res?.email ?? email };
  }

  /** Remove a credential and its values from every store. `removed` is false, and the
   *  credential stays, when a store still holds a value (`kept`) or could not be reached. */
  async remove(typeid: string): Promise<CredentialDeleted> {
    const action = this.action('delete', 'POST');
    action.bodyParameters = { typeid };
    const res = await dataManager.callAction<unknown, Partial<CredentialDeleted>>(action);
    return { removed: !!res?.removed, deleted: res?.deleted ?? [], kept: res?.kept ?? [], stores: res?.stores ?? [] };
  }

  // ── secured transfer (flow_sdk/secrets/sealed_transfer.py) — names only, never a value ──

  /** Seal `typeid`'s values for the conversation's members (all others when `recipients` is empty) and post them. */
  async sealedSeal(typeid: string, conversationId: string, recipients: string[] = []): Promise<SealedSealResult> {
    const action = this.action('sealed/seal', 'POST');
    action.bodyParameters = { typeid, conversation_id: conversationId, recipients };
    return (await dataManager.callAction<unknown, SealedSealResult>(action)) as SealedSealResult;
  }

  /** Which members of the conversation can receive values here: `{user_id: 'ok' | 'no_key'}`. */
  async sealedReceivers(conversationId: string): Promise<Record<string, 'ok' | 'no_key'>> {
    const action = this.action('sealed/receivers', 'GET');
    action.queryParameters = { conversation_id: conversationId };
    return ((await dataManager.callAction<unknown, Record<string, 'ok' | 'no_key'>>(action)) ?? {}) as Record<string, 'ok' | 'no_key'>;
  }

  /** This device's cards in the conversation — what was sealed for it, names only. */
  async sealedIncoming(conversationId: string): Promise<SealedCard[]> {
    const action = this.action('sealed/incoming', 'GET');
    action.queryParameters = { conversation_id: conversationId };
    return ((await dataManager.callAction<unknown, SealedCard[]>(action)) ?? []) as SealedCard[];
  }

  /** The sender's transfers in the conversation, and who filled / declined / is pending. */
  async sealedSent(conversationId: string): Promise<SealedSent[]> {
    const action = this.action('sealed/sent', 'GET');
    action.queryParameters = { conversation_id: conversationId };
    return ((await dataManager.callAction<unknown, SealedSent[]>(action)) ?? []) as SealedSent[];
  }

  async sealedFill(conversationId: string, messageId: string, projectId?: string | null): Promise<{ filled: string[]; credential: string }> {
    const action = this.action('sealed/fill', 'POST');
    action.bodyParameters = projectId ? { conversation_id: conversationId, message_id: messageId, project_id: projectId }
      : { conversation_id: conversationId, message_id: messageId };
    return (await dataManager.callAction<unknown, { filled: string[]; credential: string }>(action)) as { filled: string[]; credential: string };
  }

  async sealedDecline(conversationId: string, messageId: string): Promise<void> {
    const action = this.action('sealed/decline', 'POST');
    action.bodyParameters = { conversation_id: conversationId, message_id: messageId };
    await dataManager.callAction<unknown, unknown>(action);
  }

}

export interface SealedSealResult {
  transfer_id: string | null;
  sealed_for: string[];
  cannot_receive: string[];
  variables: string[];
}

export interface SealedCard {
  message_id: string;
  transfer_id: string;
  sender_id?: string;
  sender_name?: string;
  expires_at: string;
  /** `pending` | `filled` | `declined` | an error code (`expired`, `bad_signature`, `key_gone`, …). */
  state: string;
  credential_name?: string;
  credential_title?: string;
  variables?: string[];
  error?: string;
}

export interface SealedSent {
  message_id: string;
  transfer_id: string;
  expires_at: string;
  recipients: Record<string, 'pending' | 'filled' | 'declined'>;
  expired: boolean;
}

/** Ready-to-use singleton wired to the local compute node. */
export const credentialsService = new CredentialsService({ type: 'compute_node', id: '@local' });
