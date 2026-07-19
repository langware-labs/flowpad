/**
 * Machine status types for process and network monitoring on compute nodes.
 * These types mirror the Python Pydantic models in flowpad/hub/types/machine_status.py
 */

import { ExecutionEnvironmentStatus } from './compute-node-types';

/**
 * Available compute node sizes for E2B sandboxes.
 */
export enum ComputeNodeSize {
  SMALL = 'sm',
  MEDIUM = 'md',
  LARGE = 'lg',
}

/**
 * Display labels for compute node sizes.
 */
export const ComputeNodeSizeLabels: Record<ComputeNodeSize, string> = {
  [ComputeNodeSize.SMALL]: 'Small (2 CPU, 1GB)',
  [ComputeNodeSize.MEDIUM]: 'Medium (4 CPU, 2GB)',
  [ComputeNodeSize.LARGE]: 'Large (8 CPU, 4GB)',
};

/**
 * Configured compute node specifications.
 */
export interface ComputeNodeInfo {
  /** Compute node size (sm, md, lg, or local) */
  size: string;
  /** Number of CPU cores */
  cpu_count: number;
  /** Configured memory in GB */
  memory_gb: number;
  /** Operating system type */
  os_type: string;
  /** E2B template version (e.g., v0-27-0) */
  template_version?: string | null;
}

/**
 * Service status enum indicating whether a service is running or not.
 */
export enum ServiceStatusEnum {
  RUNNING = 'RUNNING',
  NOT_RUNNING = 'NOT_RUNNING',
}

/**
 * Information about a running process on the compute node.
 */
export interface ProcessInfo {
  /** Process ID */
  pid: number;
  /** Process name */
  name: string;
  /** CPU usage percentage */
  cpu_percent: number;
  /** Memory usage in MB */
  memory_mb: number;
  /** Executable path */
  path: string;
  /** Process status (running, sleeping, etc) */
  status: string;
}

/**
 * Information about a network connection/listening port on the compute node.
 * Links to ProcessInfo via pid for cross-referencing.
 */
export interface NetworkConnection {
  /** Port number */
  port: number;
  /** Process ID owning the port - links to ProcessInfo.pid */
  pid: number;
  /** Name of the process */
  process_name: string;
  /** Path to the process executable */
  process_path: string;
  /** Connection status (LISTEN, ESTABLISHED, etc) */
  status: string;
  /** Connection type (TCP, UDP) */
  type: string;
}

/**
 * Complete machine status including processes and network connections.
 * Provides a snapshot of the compute node's resource usage.
 */
export interface MachineStatus {
  /** Provider status (READY, PAUSED, ERROR, NOT_FOUND) */
  node_provider_status: ExecutionEnvironmentStatus;
  /** Status message (informational or error) */
  status_msg?: string | null;
  /** List of running processes */
  processes: ProcessInfo[];
  /** List of network connections */
  network: NetworkConnection[];
  /** Overall CPU usage percentage */
  cpu_percent: number;
  /** Overall memory usage percentage */
  memory_percent: number;
  /** Total memory in GB */
  memory_total_gb: number;
  /** Available memory in GB */
  memory_available_gb: number;
  /** Configured node specifications (CPU, memory, OS) */
  node_info?: ComputeNodeInfo | null;
  /** Full path to the sandbox home directory */
  home_path?: string | null;
}

/**
 * Utility functions for working with MachineStatus data.
 * Provides helpers for querying and analyzing compute node status.
 */
export const MachineStatusUtils = {
  /**
   * Get the process info for a specific port from machine status data.
   * Uses NetworkConnection.pid to find the corresponding ProcessInfo.
   * @param status - The machine status data
   * @param port - The port number to look up
   * @returns The ProcessInfo for the process owning the port, or undefined if not found
   */
  getProcessByPort(status: MachineStatus, port: number): ProcessInfo | undefined {
    const connection = status.network.find((conn) => conn.port === port);
    if (!connection) return undefined;

    return status.processes.find((proc) => proc.pid === connection.pid);
  },

  /**
   * Get the network connection info for a specific port.
   * @param status - The machine status data
   * @param port - The port number to look up
   * @returns The NetworkConnection for the port, or undefined if not found
   */
  getConnectionByPort(status: MachineStatus, port: number): NetworkConnection | undefined {
    return status.network.find((conn) => conn.port === port);
  },

  /**
   * Get all network connections for a specific process.
   * @param status - The machine status data
   * @param pid - The process ID to look up
   * @returns All NetworkConnections owned by the process
   */
  getConnectionsByProcess(status: MachineStatus, pid: number): NetworkConnection[] {
    return status.network.filter((conn) => conn.pid === pid);
  },

  /**
   * Get all processes sorted by CPU usage (descending).
   * @param status - The machine status data
   * @returns Processes sorted by CPU usage
   */
  getProcessesByCpu(status: MachineStatus): ProcessInfo[] {
    return [...status.processes].sort((a, b) => b.cpu_percent - a.cpu_percent);
  },

  /**
   * Get all processes sorted by memory usage (descending).
   * @param status - The machine status data
   * @returns Processes sorted by memory usage
   */
  getProcessesByMemory(status: MachineStatus): ProcessInfo[] {
    return [...status.processes].sort((a, b) => b.memory_mb - a.memory_mb);
  },

  /**
   * Get all listening ports.
   * @param status - The machine status data
   * @returns Network connections with LISTEN status
   */
  getListeningPorts(status: MachineStatus): NetworkConnection[] {
    return status.network.filter((conn) => conn.status === 'LISTEN');
  },
};
