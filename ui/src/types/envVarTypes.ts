/**
 * Environment variable types - matches backend EnvVarType enum exactly
 *
 * These match the Python enum in hub/core/entity/entity_env/env_types.py
 */
export enum EnvVarType {
  API_KEY = 'api_key',
  OAUTH_TOKEN = 'oauth_token',
  OAUTH_PROVIDER_ID = 'oauth_provider',
  PLAIN = 'plain',
}

/**
 * SOD (Secure Object Database) environment variable status
 * Indicates whether a confidential value is available/connected
 */
export enum SodEnvStatus {
  CONNECTED = 'connected',
  AVAILABLE = 'available',
  DISCONNECTED = 'disconnected',
}

/**
 * Environment variable status enum - matches backend EnvStatusEnum
 * Indicates the availability status of an environment variable
 */
export enum EnvStatusEnum {
  NA = 'NA SOD',
  AVAILABLE = 'AVAILABLE',
  MISSING = 'MISSING',
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  ERROR = 'ERROR',
}

/**
 * Environment variable operation type - matches backend EnvOpType enum
 * Indicates the operation type for flow-env-var messages
 */
export enum EnvOpType {
  PENDING = 'pending', // Default: user input expected
  CREATED = 'created', // Notification: env var was created
  UPDATED = 'updated', // Notification: env var was updated
  DELETED = 'deleted', // Notification: env var was deleted
}

/**
 * Builtin entity types that can own environment variables
 */
export enum BuiltinEntityType {
  PROJECT = 'project',
  USER = 'user',
}

/**
 * Helper function to check if a var type is confidential (requires masking)
 * Confidential types are stored in SOD and show masked values
 */
export function isConfidential(varType: EnvVarType): boolean {
  return varType === EnvVarType.API_KEY || varType === EnvVarType.OAUTH_TOKEN;
}

/**
 * Get display label for env var type
 */
export function getEnvVarTypeLabel(varType: EnvVarType): string {
  switch (varType) {
    case EnvVarType.API_KEY:
      return 'API Key';
    case EnvVarType.OAUTH_TOKEN:
      return 'OAuth Token';
    case EnvVarType.OAUTH_PROVIDER_ID:
      return 'OAuth Provider';
    case EnvVarType.PLAIN:
      return 'Non Confidential';
    default:
      return 'Unknown';
  }
}

/**
 * Get badge color class for env var type
 */
export function getEnvVarTypeBadgeColor(varType: EnvVarType): string {
  switch (varType) {
    case EnvVarType.API_KEY:
      return 'bg-red-100 text-red-800 border-red-300';
    case EnvVarType.OAUTH_TOKEN:
      return 'bg-purple-100 text-purple-800 border-purple-300';
    case EnvVarType.OAUTH_PROVIDER_ID:
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case EnvVarType.PLAIN:
      return 'bg-gray-100 text-gray-800 border-gray-300';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}
