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

/**
 * What a node's backing machine is doing — the answer to `ops/status`.
 *
 * Normalized SERVER-side (`NodeStatus` in the hub) rather than being whatever
 * dict the provider happened to return. Before that, this type was by
 * construction one provider's field set unioned with another's: the hub's own
 * docstring said "and for E2B also started_at/end_at/cpu_count/memory_mb", and
 * the browser consumed it untyped.
 *
 * The optional fields are optional because a provider that cannot answer
 * cheaply must be allowed to say nothing — `undefined` means unknown, never zero.
 */
export interface NodeStatus {
  status: ExecutionEnvironmentStatus;
  /** Start of the CURRENT run. Resets on resume. */
  started_at?: string | null;
  /** When the machine auto-pauses or expires. */
  end_at?: string | null;
  cpu_count?: number;
  memory_mb?: number;
}

/**
 * The answer to `ops/workspace-ready`: the app inside the box is up, and who it
 * is signed in as.
 *
 * `login_detail` is read back FROM the box, not the identity the hub asked for —
 * the two used to be the same value, which is how a box signed in as the wrong
 * person went unnoticed.
 */
export interface WorkspaceReady {
  healthy: boolean;
  started_fallback?: boolean;
  port?: number;
  logged_in: boolean;
  login_detail: string;
}
