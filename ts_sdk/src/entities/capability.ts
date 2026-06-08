import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';
import { ActionInfo } from '../models/ActionInfo';
import { HttpMethod } from '../models/ApiUrl';

export type CapabilityActionName = 'check' | 'install' | 'test';

export interface CapabilityResult {
  ok: boolean;
  available: boolean;
  message: string;
  details?: Record<string, unknown>;
  process_id?: string | null;
  checked_at?: string;
}

export interface CapabilityCheck {
  kind: string;
  result: CapabilityResult;
  dependencies?: Record<string, CapabilityResult>;
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
  last_check?: CapabilityResult | null;
  last_install?: CapabilityResult | null;
  last_test?: CapabilityResult | null;
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
  last_check: CapabilityResult | null = null;
  last_install: CapabilityResult | null = null;
  last_test: CapabilityResult | null = null;

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
    this.last_check = entity.last_check ?? this.last_check;
    this.last_install = entity.last_install ?? this.last_install;
    this.last_test = entity.last_test ?? this.last_test;
  }

  static kindMatches(queryKind: string, capabilityKind: string): boolean {
    const query = queryKind.trim().toLowerCase();
    const candidate = capabilityKind.trim().toLowerCase();
    return candidate === query || candidate.startsWith(`${query}.`);
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
}
