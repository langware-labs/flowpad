import { dataManager } from '../APIEntity';
import { ActionInfo } from './ActionInfo';
import { TypeId } from './TypeId';

// ============================================================================
// Types & Enums (matching backend)
// ============================================================================

export enum EnvVarType {
  API_KEY = 'api_key',
  OAUTH_TOKEN = 'oauth_token',
  OAUTH_PROVIDER_ID = 'oauth_provider',
  PLAIN = 'plain',
}

export enum EnvStatusEnum {
  NA = 'NA SOD',
  AVAILABLE = 'AVAILABLE',
  MISSING = 'MISSING',
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  ERROR = 'ERROR',
}

// ============================================================================
// API Models
// ============================================================================

export interface EnvVar {
  name: string;
  var_type: EnvVarType;
  description?: string;
  value?: string; // Context-dependent: full value for writes, visible value for reads
}

export interface EnvVarStatus {
  name: string;
  description?: string;
  var_type: EnvVarType;
  value?: string;
  visible_value?: string; // Added for consistency with backend
  allowed_to_use?: TypeId[];
  ref_type?: string;
  ref_name?: string;
  icon?: string;
  /** OAUTH_PROVIDER_ID rows: which OAuth grant runs ('code' | 'loopback' | 'device'). */
  oauth_kind?: string;
  /** OAUTH_PROVIDER_ID rows: the scopes the flow requests, when published. */
  oauth_scopes?: string[];
  /** Explicit provider label; older servers encoded it in `description`. */
  oauth_display_name?: string;
  /** True only when the owning provider declares a live read-only verifier. */
  oauth_verifiable?: boolean;
  /** Version of the correlated wait/cancel + strict verification protocol. */
  oauth_protocol?: number;
  /** Epoch seconds the access token expires. The hub carries this from the user's
   *  token row onto the provider row (`_carry_oauth_freshness`); absent means the
   *  provider never said, which the hub treats as "never expires". */
  expires_at?: number;
  /** The hub tried to refresh and was permanently refused — the credential is
   *  held but dead, and only a new grant fixes it. Deliberately separate from
   *  `var_status`, which answers "do we hold it and may this project use it",
   *  not "does it still work". */
  needs_reauth?: boolean;
  sod_status?: EnvStatusEnum;
  var_status?: EnvStatusEnum;
}

export interface EntityEnvVars {
  values: EnvVarStatus[];
}

/** Provider label from the explicit protocol field, with the legacy description fallback. */
export function oauthProviderDisplayName(
  envVar: Pick<EnvVarStatus, 'name' | 'description' | 'oauth_display_name'>,
): string {
  if (envVar.oauth_display_name) return envVar.oauth_display_name;
  return envVar.description?.match(/OAuth integration for (.+)/)?.[1] || envVar.name;
}

// ============================================================================
// EntityEnv Class - Entity-level operations
// ============================================================================

/**
 * Manages environment variables for a specific entity.
 * Symmetric to backend entity.env_vars pattern.
 *
 * Usage:
 *   const envVars = new EntityEnv(projectTypeId);
 *   await envVars.create({ name: 'API_KEY', var_type: EnvVarType.API_KEY, value: 'env-var' });
 *   const vars = await envVars.list();
 *   const table = await envVars.getTable();
 */
export class EntityEnv {
  private entityTypeId: TypeId;

  constructor(entityTypeId: TypeId) {
    this.entityTypeId = entityTypeId;
  }

  // =========================================================================
  // CRUD Operations (matching backend endpoints)
  // =========================================================================

  /**
   * Create a new environment variable
   * POST /<entity-typeid>/env-var
   */
  async create(data: EnvVar): Promise<EnvVar> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'POST');

    actionInfo.bodyParameters = {
      name: data.name,
      var_type: data.var_type,
      value: data.value,
      description: data.description,
    };

    interface ApiResponseData {
      name: string;
      var_type: EnvVarType;
      description?: string;
      visible_value?: string;
    }

    // Note: apiClient interceptor already unwraps response.data.data
    const response = await dataManager.callAction<any, ApiResponseData>(actionInfo);

    // Map visible_value from API to value in our interface
    return {
      name: response.name,
      var_type: response.var_type,
      description: response.description,
      value: response.visible_value,
    };
  }

  /**
   * Get a specific environment variable by name
   * GET /<entity-typeid>/env-var/{VAR_NAME}
   */
  async get(varName: string): Promise<EnvVar> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'GET');
    actionInfo.subpath = [varName];

    interface ApiResponseData {
      name: string;
      var_type: EnvVarType;
      description?: string;
      visible_value?: string;
    }

    // Note: apiClient interceptor already unwraps response.data.data
    const response = await dataManager.callAction<any, ApiResponseData>(actionInfo);

    // Map visible_value from API to value in our interface
    return {
      name: response.name,
      var_type: response.var_type,
      description: response.description,
      value: response.visible_value,
    };
  }

  /**
   * List all environment variables for this entity
   * GET /<entity-typeid>/env-var
   * @param typeFilter Optional filter by var_type (e.g., [EnvVarType.API_KEY, EnvVarType.OAUTH_TOKEN])
   */
  async list(typeFilter?: EnvVarType[]): Promise<EnvVar[]> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'GET');

    if (typeFilter && typeFilter.length > 0) {
      actionInfo.queryParameters = {
        var_type: typeFilter.join(','),
      };
    }

    interface ApiResponseItem {
      name: string;
      var_type: EnvVarType;
      description?: string;
      visible_value?: string;
    }

    // Note: apiClient interceptor already unwraps response.data.data
    const response = await dataManager.callAction<any, ApiResponseItem[]>(actionInfo);

    // Map visible_value from API to value in our interface
    return response.map((item) => ({
      name: item.name,
      var_type: item.var_type,
      description: item.description,
      value: item.visible_value,
    }));
  }

  /**
   * Update an existing environment variable
   * PUT /<entity-typeid>/env-var/{VAR_NAME}
   */
  async update(varName: string, data: Partial<EnvVar>): Promise<EnvVar> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'PUT');
    actionInfo.subpath = [varName];

    actionInfo.bodyParameters = {
      name: varName,
      var_type: data.var_type,
      value: data.value,
      description: data.description,
    };

    interface ApiResponseData {
      name: string;
      var_type: EnvVarType;
      description?: string;
      visible_value?: string;
    }

    // Note: apiClient interceptor already unwraps response.data.data
    const response = await dataManager.callAction<any, ApiResponseData>(actionInfo);

    // Map visible_value from API to value in our interface
    return {
      name: response.name,
      var_type: response.var_type,
      description: response.description,
      value: response.visible_value,
    };
  }

  /**
   * Delete an environment variable
   * DELETE /<entity-typeid>/env-var/{VAR_NAME}
   */
  async delete(varName: string): Promise<{ message: string }> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'DELETE');
    actionInfo.subpath = [varName]; // Use the original case, don't convert to uppercase

    interface ApiResponse {
      message: string;
    }

    const response = await dataManager.callAction<any, ApiResponse>(actionInfo);
    return response;
  }

  /**
   * Get the environment variables table with status and merged data
   * GET /<entity-typeid>/env-var/table
   *
   * Behavior:
   * - For USER entities: Returns OAuth providers with connection status
   * - For PROJECT entities: Returns merged project vars + user vars + OAuth providers
   */
  async getTable(): Promise<EntityEnvVars> {
    const actionInfo = new ActionInfo('env-var', this.entityTypeId.type, this.entityTypeId.id, 'GET');
    actionInfo.subpath = ['table'];

    // Note: apiClient interceptor already unwraps response.data.data
    // So dataManager.callAction returns the data directly, not wrapped in { data: ... }
    const response = await dataManager.callAction<any, EntityEnvVars>(actionInfo);
    return response;
  }

  // =========================================================================
  // Utility/Helper Methods
  // =========================================================================

  /**
   * Check if a variable name is valid (uppercase letters, numbers, underscores)
   */
  static isValidName(name: string): boolean {
    return /^[A-Z0-9_]+$/.test(name);
  }

  /**
   * Validate variable name or throw error
   */
  static validateName(name: string): void {
    if (!this.isValidName(name)) {
      throw new Error('Environment variable name must contain only uppercase letters, numbers, and underscores');
    }
  }

  /**
   * Check if a variable type requires confidential storage (SOD)
   */
  static isConfidential(varType: EnvVarType): boolean {
    return varType === EnvVarType.API_KEY || varType === EnvVarType.OAUTH_TOKEN;
  }
}
