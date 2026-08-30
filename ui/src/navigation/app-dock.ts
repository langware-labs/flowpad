import type { AppRuntime } from '@src/hooks/flow-hooks';

// Re-exported, not re-declared: the runtime vocabulary has one owner
// (`useAppDisplay`), and consumers of the dock grammar get it from here.
export type { AppRuntime };
import type { DockPointer } from './DockPointer';

export const APP_RUNTIME_PARAM = 'runtime';

export interface AppDockAddress {
  /** Bare artifact uuid, for an app addressed by its source plane. Null for an
   *  app that has no Artifact at all — a webapp ASSET on disk. */
  artifactId: string | null;
  /** Bare micro_app uuid, for an app addressed by its own delivery row. */
  microAppId: string | null;
  /** The workspace whose display is showing it, needed to resolve a `dev` server. */
  host: string | null;
  /** The user's runtime preference, if the URL pins one. */
  runtime: AppRuntime | null;
  /**
   * Everything else on the dock, handed to the APP as its query string.
   *
   * An app is told what to act on through its URL and nothing else — the source
   * editor is opened with `?source=<id>` and reads it there. `runtime` is
   * excluded because it addresses the VIEWER, not the app.
   */
  options: Record<string, string>;
}

/**
 * Read an app dock's inputs off its pointer — the one place that grammar is split.
 *
 * `/dock/app/<artifact|micro_app>-<uuid>[?runtime=dev|served][&host=agentic_process-<uuid>]`.
 *
 * TWO addresses, because an app has two ways to exist. An app built from source
 * is addressed by its ARTIFACT: the runtime is DERIVED from its Deployment /
 * MicroApp companions at render time, and a port in the pointer would let a dev
 * server that has since died become the app's identity. A webapp ASSET on disk
 * has no Artifact and no dev server — its delivery row IS the thing, so it is
 * addressed directly. Addressing it by its own entity is also what gives it a
 * breadcrumb: `micro_app-<uuid>` has a parent, `artifact-<uuid>` names a plane.
 *
 * Null when the pointer is missing, not a TypeId, or names some other type —
 * the caller renders nothing rather than guessing at an app.
 */
export function appDockAddress(dock: DockPointer | null): AppDockAddress | null {
  // `targetTypeId` is the documented accessor for "the entity this dock targets"
  // and already returns null instead of throwing on a malformed pointer.
  const target = dock?.targetTypeId ?? null;
  if (!target?.id) return null;
  if (target.type !== 'artifact' && target.type !== 'micro_app') return null;
  const { [APP_RUNTIME_PARAM]: pinned, ...passthrough } = dock!.options ?? {};
  return {
    artifactId: target.type === 'artifact' ? target.id : null,
    microAppId: target.type === 'micro_app' ? target.id : null,
    host: dock!.hostProcessId,
    runtime: pinned === 'dev' || pinned === 'served' ? pinned : null,
    options: passthrough as Record<string, string>,
  };
}
