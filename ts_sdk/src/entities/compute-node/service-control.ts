/**
 * Service control types for managing artifact processes on compute nodes.
 * Low-level local process controls use an explicit runtime descriptor. These
 * fields are intentionally not part of the logical Artifact entity.
 */

/**
 * Ephemeral local process coordinates used by ComputeNode controls.
 * Provider deployments use the Deployment entity instead.
 */
export interface ServiceRuntimeDescriptor {
  id?: string;
  port?: string;
  start_cmd?: string;
}

export function isServiceRuntime(service: ServiceRuntimeDescriptor): service is Required<ServiceRuntimeDescriptor> {
  return Boolean(service.id && service.port && service.start_cmd);
}

export function canStartService(service: ServiceRuntimeDescriptor): boolean {
  return Boolean(service.port && service.start_cmd);
}

/**
 * Error thrown when service control operation fails.
 */
export class ServiceControlError extends Error {
  constructor(
    message: string,
    public readonly artifactId: string,
    public readonly operation: 'start' | 'stop' | 'restart' | 'get',
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ServiceControlError';
  }
}
