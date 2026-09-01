/**
 * The `flow show` display-target contract.
 *
 * Its own module, not a member of `process/agentic-process.ts`: this is the
 * shape of a backend payload (`flow_sdk/core/display_target.py`), not something
 * a process owns, and four separate declarations of it had already drifted
 * apart across the tree. `APIEntity` needs it too — for `ReceiveShowTarget` —
 * and reaching into a SUBCLASS's module from the base class for a type would be
 * a (type-only, but real) circular import.
 */

/**
 * Resolved `flow show` display target — the payload of the `on_show` entity
 * event, produced by the backend's `resolve_display_target`
 * (flow_sdk/core/display_target.py). Discriminated by `kind`.
 */
export interface ShowTarget {
  /** Mirrors python `DisplayTargetKind` (flow_sdk/core/display_target.py). */
  kind?: 'entity' | 'vfs' | 'webapp' | 'app' | 'shell' | string;
  /** entity: canonical `<type>-<id>` string. */
  typeid?: string;
  type?: string;
  id?: string;
  /** entity (when shown by path) | vfs: the resolved absolute path. */
  path?: string;
  /** webapp: the dev-server port. */
  port?: number | string;
  /** app: the Artifact IS the address — the runtime below is derived from its
   *  companions, never pinned into the target (`_app_payload`). */
  artifact_id?: string;
  /** app: the delivery row. Sent whenever a MicroApp exists, and the only id a
   *  webapp ASSET has — it has no Artifact (`_asset_app_payload`). */
  micro_app_id?: string;
  /** app: which plane is live right now. `dev` = a Deployment's port is up,
   *  `served` = we serve the built MicroApp, `unbuilt` = neither. */
  runtime?: 'dev' | 'served' | 'unbuilt';
  /** Display label the backend resolved for the target (artifact/app/entity
   *  name, falling back to its title). */
  name?: string;
  /** dock: a SCREEN — the frontend's own dock-address fields, so the client
   *  builds its DockPointer without re-parsing a URL. */
  view_type?: string;
  pointer?: string | null;
  options?: Record<string, string> | null;
  page?: string;
}

/**
 * One entry in a process's display history — `context_data.display_stack`. The
 * backend flattens the `flow show` target and stamps it with `shown_at`, so an
 * entry IS a {@link ShowTarget} plus its server timestamp. Newest last.
 */
export interface DisplayEntry extends ShowTarget {
  /** ISO 8601 server timestamp — when the agent showed this target. */
  shown_at?: string;
}
