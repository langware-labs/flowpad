/**
 * Service control types for managing artifact processes on compute nodes.
 * Services are WEBAPP or APP_SERVICE artifacts with port and start_cmd.
 */

import type { Artifact } from '../artifact';

/**
 * Service artifact - an Artifact with required service fields.
 * Used to validate artifacts before service control operations.
 */
export interface ServiceArtifact extends Artifact {
  /** Port the service runs on (required for service control) */
  port: string;
  /** Command to start the service (required for start/restart) */
  start_cmd: string;
}

/**
 * Check if an artifact is a valid service artifact with required fields.
 */
export function isServiceArtifact(artifact: Artifact): artifact is ServiceArtifact {
  return Boolean(artifact.port);
}

/**
 * Check if an artifact can be started (has start_cmd).
 */
export function canStartArtifact(artifact: Artifact): boolean {
  return Boolean(artifact.port && artifact.start_cmd);
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
