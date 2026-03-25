import { IEntity } from '../IEntity';
import { APIEntity, registerEntity } from '../APIEntity';

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
}
