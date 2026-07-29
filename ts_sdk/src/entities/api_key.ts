import { IEntity } from '../IEntity';
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
    const result = await dataManager.callAction<
      unknown,
      { id: string; key: string; name: string; bind_typeid: string }
    >(info);
    return {
      api_key: result.key,
      var_name: result.name,
      name: result.name,
      description: ApiKey.SELF_KEY_DESCRIPTION,
      visible_value: `****${result.key.slice(-4)}`,
      target_typeid: result.bind_typeid,
      is_active: true,
    };
  }

  /** DELETE /graph/<user>/api-keys {id} — keys are addressed by id, not name. */
  static async deleteById(userTypeId: TypeId, keyId: string): Promise<void> {
    const info = new ActionInfo('api-keys', userTypeId.type, userTypeId.id, 'DELETE');
    info.bodyParameters = { id: keyId };
    await dataManager.callAction(info);
  }
}
