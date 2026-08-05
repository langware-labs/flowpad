import { PageId, TypeId } from '@sdk';
import { AssetDocPointer } from './AssetDocPointer';
import { editorForType } from './asset-doc-types';
import { DockPointer } from './DockPointer';
import { dockPointerForFile } from './local-file-pointer';
import { shellIdFromShowTarget } from './shell-show-target';
import { ViewType } from '@src/types/ViewType';

/**
 * The ONE rule for "which dock does a `flow show` target open".
 *
 * A display target is an ADDRESS produced by the backend's
 * `resolve_display_target` (`flow_sdk/core/display_target.py`) — it says WHAT
 * the agent wants presented, never HOW. This module is the single place that
 * turns that address into a `DockPointer`; how the pointer is then used is the
 * caller's business and differs per view mode:
 *
 * - Vibe mounts the target in its Display pane and uses this only for the
 *   history popover's "open as its own tab".
 * - Every other mode mints a tab from it (`use-show-target-listener`).
 *
 * Keeping one mapper is what stops the two modes from drifting into different
 * answers for the same target — they were three near-copies before this.
 */

/** Structural shape of every resolved show target — deliberately all-optional so
 *  the SDK's `ShowTarget`, `ReceiveShowTarget` and `DisplayShowTarget` all fit. */
export interface DisplayTargetLike {
  kind?: string;
  typeid?: string;
  type?: string;
  id?: string;
  path?: string;
  port?: number | string;
  /** kind: 'app' — the Artifact is the address; runtime is derived, not pinned. */
  artifact_id?: string;
  runtime?: string;
  name?: string;
  /** kind: 'dock' — a SCREEN. The backend sends the frontend's own field names
   *  (`flow_sdk/core/dock_address.py`, pinned by dock_address_contract.json) so
   *  the pointer is built here without re-parsing a URL. */
  view_type?: string;
  pointer?: string | null;
  options?: Record<string, string> | null;
  page?: string;
}

/** Port targets (`webapp`, and an `app` whose dev server is up) → the port preview. */
function webAppPointer(port: number | string | undefined): DockPointer | null {
  const value = port == null ? '' : String(port).trim();
  return value ? DockPointer.forTab(ViewType.WEB_APP, { port: value }) : null;
}

/**
 * The dock a show target opens, or null when it addresses nothing openable.
 *
 * Null is a real answer, not a failure: an entity type with no registered
 * editor and no path has no surface to open (the `dataset` hole), and an `app`
 * that is `served`/`unbuilt` carries no port — its only runtime lives behind
 * Vibe's artifact-driven chrome. Callers skip silently rather than inventing a
 * destination; the target still lands in the process's display history.
 */
export function dockForDisplayTarget(target: DisplayTargetLike | null | undefined): DockPointer | null {
  if (!target) return null;

  // A terminal is an address, not content — same dock a journey's open_terminal
  // uses. Checked first because a shell target also carries type/id, which the
  // entity branch below would otherwise try to resolve to an editor.
  const shellId = shellIdFromShowTarget(target);
  if (shellId) return DockPointer.forShell(shellId);

  // A SCREEN is already a dock address — the backend validated the view and its
  // pointer requirement, so this is a construction, not a resolution. Checked
  // before the entity/path branches because a dock target carries neither a
  // `type` nor a `path` for them to match on.
  if (target.kind === 'dock' && target.view_type) {
    return new DockPointer(
      target.view_type as ViewType,
      target.pointer ?? undefined,
      target.options ?? undefined,
      undefined,
      (target.page as PageId | undefined) ?? undefined,
    );
  }

  if (target.kind === 'webapp' || target.kind === 'app') return webAppPointer(target.port);

  // Entity first, path second: an indexed asset opens in its bespoke editor,
  // and the raw file view is the fallback for a type with no editor. `path`
  // routes through `dockPointerForFile` — the shared extension chokepoint —
  // rather than a local `editorForPath` call, so a shown file opens exactly
  // like the same file opened from the explorer or a chat attachment.
  const editor = target.type ? editorForType(target.type) : undefined;
  if (editor && target.typeid) {
    return AssetDocPointer.forTypeId(editor, new TypeId(target.typeid)).toDockPointer();
  }
  return target.path ? dockPointerForFile(target.path) : null;
}
