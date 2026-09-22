import { PageId, TypeId, type ShowTarget } from '@sdk';
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

/**
 * The dock a show target opens, or null when it addresses nothing openable.
 *
 * Null is a real answer, not a failure: an entity type with no registered
 * editor and no path has no surface to open (the `dataset` hole). Callers skip
 * silently rather than inventing a destination; the target still lands in the
 * process's display history.
 *
 * An `app` is always addressable: `ViewType.APP` takes the typeid it was shown by
 * (its endpoint, artifact or webapp definition) and derives what serves it, which
 * is what lets an app be shown, bookmarked and restored without a port ever
 * becoming its identity.
 */
export function dockForDisplayTarget(target: ShowTarget | null | undefined): DockPointer | null {
  if (!target) return null;
  if (target.kind === 'url' && target.url) return DockPointer.forWebUrl(target.url);

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

  // An APP is addressed by the typeid it was shown by — its artifact, its webapp
  // definition, or the endpoint itself. `runtime` rides in options — it is derived
  // state that changes without the app changing (a dev server dies, a build lands),
  // and options are excluded from `tabHash`, so switching dev⇄served re-points the
  // SAME tab rather than forking one per runtime. The pointer is the TypeId the
  // backend already minted rather than one re-assembled here — the `<type>-<id>`
  // spelling is what lets the backend's own pointer-entity gate 404 a bogus app
  // address instead of handing the frontend a dock that renders nothing.
  if (target.kind === 'app') {
    const runtime = target.runtime === 'dev' || target.runtime === 'served' ? { runtime: target.runtime } : undefined;
    return target.typeid ? new DockPointer(ViewType.APP, target.typeid, runtime) : null;
  }

  // Entity first, path second: an indexed asset opens in its bespoke editor,
  // and the raw file view is the fallback for a type with no editor. `path`
  // routes through `dockPointerForFile` — the shared extension chokepoint —
  // rather than a local `editorForPath` call, so a shown file opens exactly
  // like the same file opened from the explorer or a chat attachment.
  const editor = target.type ? editorForType(target.type) : undefined;
  if (editor && target.typeid) {
    const options = target.line ? { initialLine: String(target.line) } : undefined;
    return AssetDocPointer.forTypeId(editor, new TypeId(target.typeid), options).toDockPointer();
  }
  return target.path ? dockPointerForFile(target.path, { line: target.line, column: target.column }) : null;
}
