import { IEntity, EntityMerge } from '../IEntity';
import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo } from '../models';
import { TypeId } from '../models/TypeId';

/**
 * ApiKey entity representing an API key for authentication.
 *
 * Architecture:
 * - Stores API key metadata (hash, expiration, usage tracking)
 * - Hash computed via double SHA256 for secure one-way verification
 * - Full key value stored in SOD (Secret on Demand)
 * - Connected to env_vars via key_id field
 * - target_typeid specifies which entity the key acts on behalf of
 */
export interface IApiKey extends IEntity {
  name?: string; // Friendly name
  api_key_hash: string; // Double SHA256 hash for secure lookup
  target_typeid: string; // Entity this key acts on behalf of
  expires_at?: string; // ISO datetime string
  last_used_at?: string; // ISO datetime string
  is_active: boolean;
}

/** The hub's `ApiKeyCreateOut` (app/actions/api_keys.py) — the wire row for a mint. */
export interface ApiKeyCreateOut extends Omit<ApiKeyCredentials, 'var_name' | 'description'> {
  id: string;
  description?: string;
}

/**
 * API key credentials returned from backend on creation.
 * Contains the full API key which is only shown once.
 */
export interface ApiKeyCredentials {
  api_key: string; // Full key value (only on creation!)
  var_name: string; // FLOWPAD_API_KEY_<normalized_name>
  name: string; // Friendly name
  description?: string;
  visible_value: string; // Masked value (****last4chars)
  target_typeid: string; // Entity this key acts on behalf of
  expires_at?: string; // ISO datetime string
  last_used_at?: string; // ISO datetime string
  is_active: boolean;
}

// `implements IApiKey` only checks the class; it contributes no members, so every
// field declared solely on IApiKey read as "does not exist". deepAssign populates
// them from the wire — this merge makes them part of the class type.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ApiKey extends EntityMerge<IApiKey> {}

@registerEntity
export class ApiKey extends APIEntity<ApiKey> implements IApiKey {
  name?: string;
  api_key_hash!: string;
  target_typeid!: string;
  expires_at?: string;
  last_used_at?: string;
  is_active!: boolean;
  static type: string = 'api_key';

  constructor(entity: Partial<IApiKey> = {}) {
    super(entity);
    this.name = entity.name;
    this.api_key_hash = entity.api_key_hash || '';
    this.target_typeid = entity.target_typeid || '';
    this.expires_at = entity.expires_at;
    this.last_used_at = entity.last_used_at;
    this.is_active = entity.is_active ?? true;
  }

  /** The one key every surface generates: a self-bound key for the flowpad API. */
  static readonly SELF_KEY_DESCRIPTION = 'API key for communicating with flowpad API itself';

  /**
   * POST /graph/<user>/api-keys — mint a self-bound key and shape the wire row
   * into `ApiKeyCredentials`. The full key value is returned ONCE; the masking
   * rule lives here rather than in each screen that shows it.
   */
  static async generateSelfKey(userTypeId: TypeId): Promise<ApiKeyCredentials> {
    const info = new ActionInfo('api-keys', userTypeId.type, userTypeId.id, 'POST');
    info.bodyParameters = {
      name: 'FLOWPAD_API_KEY',
      description: ApiKey.SELF_KEY_DESCRIPTION,
      bind_typeid: userTypeId.toString(),
    };
    // `visible_value` arrives already masked, so it is taken rather than recomputed.
    const result = await dataManager.callAction<unknown, ApiKeyCreateOut>(info);
    return { ...result, var_name: result.name, description: result.description ?? ApiKey.SELF_KEY_DESCRIPTION };
  }

  /**
   * DELETE /graph/<user>/api-keys/<name> — the hub addresses keys by name on the
   * request sub-path, never by id.
   *
   * Names are unique among *active* keys per bound entity, so this resolves to one
   * key in the steady state. The exception is desktop-login rotation, which mints a
   * same-named grace key with `allow_duplicate_name=True`; during that window the
   * hub's lookup picks the first active match. Addressing by id would close that,
   * but that is the hub's API to change.
   */
  static async deleteByName(userTypeId: TypeId, name: string): Promise<void> {
    const info = new ActionInfo('api-keys', userTypeId.type, userTypeId.id, 'DELETE');
    info.subpath = name;
    await dataManager.callAction(info);
  }
}
