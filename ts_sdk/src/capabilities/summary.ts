/**
 * The capability summary payload — 1:1 with the backend `core/capabilities/summary.py`.
 *
 * It lives beside the manager rather than inside it: the bootstrap payload carries
 * a summary, and the manager holds the `Capability` CLASS, which cannot be loaded
 * from the layers below the entity classes.
 */
import { CapabilityState } from '../entities/capability-types';

/** One dependency edge in a CapabilityAccess (mirror of backend summary.py). */
export interface CapabilityDependency {
  kind: string;
  available: boolean;
}

/**
 * One capability + everything the UI needs to show/use it. 1:1 with the
 * backend `CapabilityAccess` pydantic model (core/capabilities/summary.py).
 */
export interface CapabilityAccess {
  kind: string;
  intent: string;
  name: string;
  description: string;
  icon: string;
  available: boolean;
  checked: boolean;
  /** Persisted four-state readiness (mirror of CapabilityState). */
  state: CapabilityState;
  runnable: boolean;
  installable: boolean;
  worker_type: string | null;
  homepage_url: string | null;
  /** Install one-liner for this machine, or null. See `Capability.install_command`. */
  install_command: string | null;
  reference_kind: string | null;
  dependencies: CapabilityDependency[];
  value: unknown | null;
  value_type: string | null;
  last_process_id: string | null;
  message: string;
}

/** All capabilities answering one intent (segment-1 handle). */
export interface CapabilityIntent {
  intent: string;
  label: string;
  available: boolean;
  capabilities: CapabilityAccess[];
}

export interface CapabilitiesSummary {
  intents: CapabilityIntent[];
  capabilities: CapabilityAccess[];
  generated_at: string;
}
