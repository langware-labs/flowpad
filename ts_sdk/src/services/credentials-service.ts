/**
 * Credentials — declare, fill and remove secret packs in the user or project
 * scope (flow_sdk/app/actions/credentials_action.py).
 *
 * A credential is a `CredentialSpec` folder: a named set of environment
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
  scope: CredentialScopeName;
  project_id: string | null;
  value_store: CredentialValueStore;
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
  value_store?: CredentialValueStore;
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
}

export const EMPTY_CREDENTIALS_STATUS: CredentialsStatus = Object.freeze({
  project_id: null,
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
   *  each scope's `.env.local` holds. */
  async status(projectId?: string | null): Promise<CredentialsStatus> {
    // The hub has no `@local` node, no home folder and no vault of this machine.
    if (isHubOnly()) return EMPTY_CREDENTIALS_STATUS;
    const action = this.action('status', 'GET');
    if (projectId) action.queryParameters = { project_id: projectId };
    return (await dataManager.callAction<unknown, CredentialsStatus>(action)) ?? EMPTY_CREDENTIALS_STATUS;
  }

  /** Create or update a credential, writing any values first. */
  async save(request: SaveCredentialRequest): Promise<CredentialSaved> {
    const action = this.action('save', 'POST');
    action.bodyParameters = { ...request };
    return dataManager.callAction<unknown, CredentialSaved>(action);
  }

  /** Set or rotate values. Empty values are skipped, never cleared. */
  async setValues(typeid: string, values: Record<string, string>): Promise<CredentialSaved> {
    const action = this.action('values', 'POST');
    action.bodyParameters = { typeid, values };
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
