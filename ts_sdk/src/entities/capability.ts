import type { EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { kindMatches } from '../models/Kind';

export type CapabilityActionName = 'test' | 'setup';

/** Four-state readiness (mirror of the backend CapabilityState enum).
 *  available = ready to use; not_available = probed/attempted and
 *  definitively not ready; none = user never tried; error = probe failed. */
export type CapabilityState = 'available' | 'not_available' | 'none' | 'error';

export interface CapabilityResult {
  ok: boolean;
  available: boolean;
  message: string;
  details?: Record<string, unknown>;
  process_id?: string | null;
  checked_at?: string;
  state?: CapabilityState;
}

export interface CapabilityCheck {
  kind: string;
  scope_type?: string | null;
  scope_id?: string | null;
  result: CapabilityResult;
  dependencies?: Record<string, CapabilityResult>;
}

export type DeviceLoginState = 'idle' | 'starting' | 'awaiting_user' | 'authenticated' | 'error';

/** Snapshot of a device-login flow (mirror of the backend session's to_json). */
export interface DeviceLoginStatus {
  state: DeviceLoginState;
  url: string | null;
  code: string | null;
  message: string;
  accepts_code_paste: boolean;
}

/** Result of the backend auth probe (WorkerAuthResult.to_json). */
export interface WorkerAuthStatus {
  status: 'not_installed' | 'logged_in' | 'logged_out' | 'unknown';
  verified: boolean;
  message: string;
  details: Record<string, unknown>;
  /** How the harness authenticates: device login vs a stored LLM-provider key. */
  auth_mode?: 'device' | 'api';
  /** Providers this harness can authenticate against (from its ApiAuthSpec);
   *  also mirrored under details.supported_providers. */
  supported_providers?: string[];
}

export interface ICapability extends IEntity {
  name: string;
  kind: string;
  /** Entity scope this row is bound to; null on the global row. Mirrors the
   *  backend `Capability.scope_type` / `.scope_id` (flow_sdk/builtin/capability.py). */
  scope_type?: string | null;
  scope_id?: string | null;
  description?: string;
  icon?: string | null;
  homepage_url?: string | null;
  dependent_capability_kinds?: string[];
  /** CapabilityReference pointer: kind this row delegates to (e.g. Default harness → harness.claude.cli). */
  reference_kind?: string | null;
  /** Prompt the install agentic process runs with (null → backend default). */
  install_prompt?: string | null;
  /** Discovered typed value (null ⇔ capability absent). For harness CLIs an
   *  FSRef dict of the bin folder — the same value workers spawn with. */
  value?: Record<string, unknown> | null;
  /** Static RecordType of `value` (e.g. "folder"); from the backend spec. */
  value_type?: string | null;
  /** Persisted four-state readiness (see CapabilityState). */
  state?: CapabilityState;
  last_check?: CapabilityResult | null;
  last_setup?: CapabilityResult | null;
  last_test?: CapabilityResult | null;
  /** Device-login runtime state — broadcast-only, never persisted. */
  login_state?: DeviceLoginState | null;
  login_url?: string | null;
  login_code?: string | null;
  login_accepts_code?: boolean | null;
  login_message?: string | null;
  /** How this harness authenticates its worker: "device" (default) or "api"
   *  (a stored LLM-provider key). Persisted + user-switchable. */
  auth_mode?: 'device' | 'api' | null;
  /** Chosen LMApiProvider value when auth_mode === 'api' (null → driver default). */
  api_provider?: string | null;
  /** User overrides for the tier→model mapping, layered over the driver defaults:
   *  {provider: {name: slug}} where name is a tier (sm/md/lg) or a custom option. */
  model_map?: Record<string, Record<string, string>>;
}

// `implements ICapability` only checks the class; it contributes no members, so every
// field declared solely on ICapability read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// `icon` is omitted: `APIEntity` owns it as an accessor pair, and an
// optional `icon?:` here is not identical to that required accessor, which
// the merged interface cannot inherit from both sides.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Capability extends EntityMerge<ICapability, 'icon'> {}

@registerEntity
export class Capability extends APIEntity<Capability> implements ICapability {
  static type: string = 'capability';
  static icon: string | null = 'BadgeCheck';

  name: string = '';
  kind: string = '';
  scope_type: string | null = null;
  scope_id: string | null = null;
  description: string = '';
  homepage_url: string | null = null;
  dependent_capability_kinds: string[] = [];
  reference_kind: string | null = null;
  install_prompt: string | null = null;
  value: Record<string, unknown> | null = null;
  value_type: string | null = null;
  state: CapabilityState = 'none';
  last_check: CapabilityResult | null = null;
  last_setup: CapabilityResult | null = null;
  last_test: CapabilityResult | null = null;
  login_state: DeviceLoginState | null = null;
  login_url: string | null = null;
  login_code: string | null = null;
  login_accepts_code: boolean | null = null;
  login_message: string | null = null;
  auth_mode: 'device' | 'api' | null = null;
  api_provider: string | null = null;
  model_map: Record<string, Record<string, string>> = {};

  // The `_icon` holder, the prototype accessor pair and the own-enumerable
  // defineProperty that used to live here are now on APIEntity — this entity
  // hit the getter-only-`icon` crash first and fixed it locally; the base does
  // it for every entity now.

  constructor(entity: Partial<ICapability> = {}) {
    super(entity);
    this.name = entity.name ?? this.name;
    this.kind = entity.kind ?? this.kind;
    this.scope_type = entity.scope_type ?? this.scope_type;
    this.scope_id = entity.scope_id ?? this.scope_id;
    this.description = entity.description ?? this.description;
    this.icon = entity.icon ?? this.icon;
    this.homepage_url = entity.homepage_url ?? this.homepage_url;
    this.dependent_capability_kinds = entity.dependent_capability_kinds ?? this.dependent_capability_kinds;
    this.reference_kind = entity.reference_kind ?? this.reference_kind;
    this.install_prompt = entity.install_prompt ?? this.install_prompt;
    this.value = entity.value ?? this.value;
    this.value_type = entity.value_type ?? this.value_type;
    this.state = entity.state ?? this.state;
    this.last_check = entity.last_check ?? this.last_check;
    this.last_setup = entity.last_setup ?? this.last_setup;
    this.last_test = entity.last_test ?? this.last_test;
    this.login_state = entity.login_state ?? this.login_state;
    this.login_url = entity.login_url ?? this.login_url;
    this.login_code = entity.login_code ?? this.login_code;
    this.login_accepts_code = entity.login_accepts_code ?? this.login_accepts_code;
    this.login_message = entity.login_message ?? this.login_message;
    this.auth_mode = entity.auth_mode ?? this.auth_mode;
    this.api_provider = entity.api_provider ?? this.api_provider;
    this.model_map = entity.model_map ?? this.model_map;
  }

  static kindMatches(queryKind: string, capabilityKind: string): boolean {
    return kindMatches(queryKind, capabilityKind);
  }

  private async callCapabilityAction(actionName: CapabilityActionName): Promise<CapabilityCheck> {
    if (!this.id) {
      throw new Error('Cannot call capability action without an ID');
    }
    const action = new ActionInfo(actionName, Capability.type, this.id, 'POST' as HttpMethod);
    const response = await dataManager.callAction<undefined, CapabilityCheck>(action);
    if (actionName === 'test') this.last_test = response.result;
    if (actionName === 'setup') this.last_setup = response.result;
    if (actionName === 'test') this.last_test = response.result;
    return response;
  }

  async setup(): Promise<CapabilityCheck> {
    return this.callCapabilityAction('setup');
  }

  async test(): Promise<CapabilityCheck> {
    return this.callCapabilityAction('test');
  }

  // ── Device login (harness CLIs) ──────────────────────────────────────────
  // Progress arrives via the entity's login_* fields over WS (data_op), not
  // via these responses — watch the entity, don't poll.

  /** Start (or restart) this harness CLI's login flow. Idempotent: the
   *  backend pre-probes and short-circuits when already authenticated. */
  async deviceLogin(): Promise<DeviceLoginStatus> {
    const action = new ActionInfo('device-login', Capability.type, this.id, 'POST' as HttpMethod);
    return dataManager.callAction<undefined, DeviceLoginStatus>(action);
  }

  /** Inject the browser-shown code into the login flow (paste-back vendors). */
  async submitLoginCode(code: string): Promise<{ submitted: boolean }> {
    const action = new ActionInfo('device-login-code', Capability.type, this.id, 'POST' as HttpMethod);
    action.bodyParameters = { code };
    return dataManager.callAction<{ code: string }, { submitted: boolean }>(action);
  }

  async cancelDeviceLogin(): Promise<{ cancelled: boolean }> {
    const action = new ActionInfo('device-login-cancel', Capability.type, this.id, 'POST' as HttpMethod);
    return dataManager.callAction<undefined, { cancelled: boolean }>(action);
  }

  /** Cheap login-state probe (no version run) — used by the startup gate. */
  async authStatus(): Promise<WorkerAuthStatus> {
    const action = new ActionInfo('auth-status', Capability.type, this.id, 'GET' as HttpMethod);
    return dataManager.callAction<undefined, WorkerAuthStatus>(action);
  }
}
