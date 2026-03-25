/**
 * Compute node type definitions.
 * Enums and interfaces for compute provider configuration.
 */

/**
 * Available compute provider types.
 */
export enum ComputeProviderType {
  LOCAL_MACHINE = 'local_machine',
  E2B = 'e2b',
}

/**
 * Runtime types for compute environments.
 */
export enum RuntimeType {
  VM = 'VM_RUNTIME',
  DOCKER = 'DOCKER_RUNTIME',
  PROCESS = 'PROCESS_RUNTIME',
}

/**
 * Supported operating system types.
 */
export enum OSType {
  LINUX = 'Linux',
  UBUNTU = 'Ubuntu',
  DEBIAN = 'DEBIAN',
  CENTOS = 'CENTOS',
  ALPINE = 'ALPINE',
  WINDOWS = 'Windows',
  MACOS = 'macOS',
}

/**
 * Compute node execution environment status.
 */
export enum ExecutionEnvironmentStatus {
  NEW = 'NEW',
  READY = 'READY',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
  NOT_FOUND = 'NOT_FOUND',
}

/**
 * Runtime environment configuration.
 */
export interface RuntimeEnvironment {
  name: string;
  description?: string;
  os_type?: OSType;
  os_version?: string;
}
