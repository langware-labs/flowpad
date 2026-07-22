import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';
import { kindMatches } from '../models/Kind';

export type CapabilityActionName = 'check' | 'install' | 'test';

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
  last_install?: CapabilityResult | null;
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

@registerEntity
export class Capability extends APIEntity<Capability> implements ICapability {
  static type: string = 'capability';
  static icon: string | null = 'BadgeCheck';

  name: string = '';
  kind: string = '';
  description: string = '';
  homepage_url: string | null = null;
  dependent_capability_kinds: string[] = [];
  reference_kind: string | null = null;
  install_prompt: string | null = null;
  value: Record<string, unknown> | null = null;
  value_type: string | null = null;
  state: CapabilityState = 'none';
  last_check: CapabilityResult | null = null;
  last_install: CapabilityResult | null = null;
  last_test: CapabilityResult | null = null;
  login_state: DeviceLoginState | null = null;
  login_url: string | null = null;
  login_code: string | null = null;
  login_accepts_code: boolean | null = null;
  login_message: string | null = null;
  auth_mode: 'device' | 'api' | null = null;
  api_provider: string | null = null;
  model_map: Record<string, Record<string, string>> = {};

  private _icon: string | null = null;

  // NOT redundant with the constructor's defineProperty: APIEntity's
  // prototype exposes a getter-only `icon`, and `super(entity)` assigns
  // fields before the constructor can install the own accessor — without
  // this prototype-level setter that assignment throws. The defineProperty
  // below additionally makes `icon` an own enumerable prop so serialization
  // sees it.
  get icon(): string | null {
    return this._icon ?? Capability.icon;
  }

  set icon(value: string | null) {
    this._icon = value ?? null;
  }

  constructor(entity: Partial<ICapability> = {}) {
    super(entity);
    Object.defineProperty(this, 'icon', {
      enumerable: true,
      configurable: true,
      get: () => this._icon ?? Capability.icon,
      set: (value: string | null | undefined) => {
        this._icon = value ?? null;
      },
    });
    this.name = entity.name ?? this.name;
    this.kind = entity.kind ?? this.kind;
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
    this.last_install = entity.last_install ?? this.last_install;
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
    if (actionName === 'check') this.last_check = response.result;
    if (actionName === 'install') this.last_install = response.result;
    if (actionName === 'test') this.last_test = response.result;
    return response;
  }

  async check(): Promise<CapabilityCheck> {
    return this.callCapabilityAction('check');
  }

  async install(): Promise<CapabilityCheck> {
    return this.callCapabilityAction('install');
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
