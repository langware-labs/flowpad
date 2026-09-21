import type { AppRuntime } from '@src/hooks/flow-hooks';

// Re-exported, not re-declared: the runtime vocabulary has one owner
// (`useAppDisplay`), and consumers of the dock grammar get it from here.
export type { AppRuntime };
import type { DockPointer } from './DockPointer';

export const APP_RUNTIME_PARAM = 'runtime';

/** The entity types an app dock may address. */
const APP_TYPES = new Set(['artifact', 'micro_app', 'service_endpoint']);

export interface AppDockAddress {
  /** Bare artifact uuid, for an app addressed by its source plane. */
  artifactId: string | null;
  /** Bare micro_app uuid, for a webapp ASSET addressed by its definition. */
  microAppId: string | null;
  /** Bare service_endpoint uuid, for an app addressed by what serves it — e.g. a
   *  dev server shown by port, which has no artifact and no definition. */
  endpointId: string | null;
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
 * `/dock/app/<artifact|micro_app|service_endpoint>-<uuid>[?runtime=dev|served]`.
 *
 * Every form resolves to the `ServiceEndpoint`s that serve the app (`useAppDisplay`),
 * and none carries a port: a port belongs to whichever server happens to be up, so
 * one baked into the address goes stale the moment the server moves.
 *
 * - `artifact-<uuid>` — an app built from source. Its endpoints (a dev server, a
 *   served build) are found by `artifact_id`, and which one shows is derived.
 * - `micro_app-<uuid>` — a webapp ASSET, found by the endpoint whose `webapp_id`
 *   names it. Addressing the definition is also what gives it a breadcrumb.
 * - `service_endpoint-<uuid>` — the endpoint itself (a bare dev server).
 *
 * Null when the pointer is missing, not a TypeId, or names some other type —
 * the caller renders nothing rather than guessing at an app.
 */
export function appDockAddress(dock: DockPointer | null): AppDockAddress | null {
  // `targetTypeId` is the documented accessor for "the entity this dock targets"
  // and already returns null instead of throwing on a malformed pointer.
  const target = dock?.targetTypeId ?? null;
  if (!target?.id || !APP_TYPES.has(target.type)) return null;
  const { [APP_RUNTIME_PARAM]: pinned, ...passthrough } = dock!.options ?? {};
  return {
    artifactId: target.type === 'artifact' ? target.id : null,
    microAppId: target.type === 'micro_app' ? target.id : null,
    endpointId: target.type === 'service_endpoint' ? target.id : null,
    runtime: pinned === 'dev' || pinned === 'served' ? pinned : null,
    options: passthrough as Record<string, string>,
  };
}
