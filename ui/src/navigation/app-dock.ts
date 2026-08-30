import type { AppRuntime } from '@src/hooks/flow-hooks';

// Re-exported, not re-declared: the runtime vocabulary has one owner
// (`useAppDisplay`), and consumers of the dock grammar get it from here.
export type { AppRuntime };
import type { DockPointer } from './DockPointer';

export const APP_RUNTIME_PARAM = 'runtime';

export interface AppDockAddress {
  /** Bare artifact uuid — the app's identity. */
  artifactId: string;
  /** The workspace whose display is showing it, needed to resolve a `dev` server. */
  host: string | null;
  /** The user's runtime preference, if the URL pins one. */
  runtime: AppRuntime | null;
}

/**
 * Read an app dock's inputs off its pointer — the one place that grammar is split.
 *
 * `/dock/app/artifact-<uuid>[?runtime=dev|served][&host=agentic_process-<uuid>]`.
 * The artifact is the address because the runtime is DERIVED from its Deployment /
 * MicroApp companions at render time; a port in the pointer would let a dev server
 * that has since died become the app's identity.
 *
 * Null when the pointer is missing or not a TypeId — the caller renders nothing
 * rather than guessing at an artifact.
 */
export function appDockAddress(dock: DockPointer | null): AppDockAddress | null {
  // `targetTypeId` is the documented accessor for "the entity this dock targets"
  // and already returns null instead of throwing on a malformed pointer.
  const artifactId = dock?.targetTypeId?.id ?? null;
  if (!artifactId) return null;
  const pinned = dock.options?.[APP_RUNTIME_PARAM];
  return {
    artifactId,
    host: dock.hostProcessId,
    runtime: pinned === 'dev' || pinned === 'served' ? pinned : null,
  };
}
