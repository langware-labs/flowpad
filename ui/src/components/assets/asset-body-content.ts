import { AssetMode } from '@src/navigation/asset-doc-types';

/**
 * Does the assets body show the project landing?
 *
 * Under a project scope an EMPTY sub-pointer IS the landing — on both hosts.
 * `/dock/project/<id>` always read it that way; `/dock/assets` used to demand
 * the literal `project-home` and otherwise fell through to "Select a type to
 * browse". Nothing navigates there on purpose (`NavigationActions.openAssets`
 * picks project-home under a project), yet the bare URL is minted constantly:
 * `DockPointer.toJSON` folds the sub-pointer to `''` for scope-keyed views so
 * the backend mints ONE tab row per scope, which means every click on a
 * persisted Assets chip — and the carry-over in `dockForScopeEntry` on a
 * project switch — arrives bare. The two hosts now agree.
 *
 * Bare and UNSCOPED stays a type picker: with no project there is no landing.
 */
export function isProjectHomeSurface(args: {
  /** Rendering under `/dock/project/<id>` rather than `/dock/assets`. */
  isProjectView: boolean;
  /** The assets sub-pointer; empty when the URL addresses no content. */
  pointer: string | null | undefined;
  /** The project the URL scope names — null when the scope isn't a project. */
  scopedProjectId: string | null;
}): boolean {
  const { isProjectView, pointer, scopedProjectId } = args;
  if (!scopedProjectId) return false;
  if (!pointer) return true;
  // The project dock reaches its landing only by addressing nothing; the
  // `project-home` sub-pointer belongs to the assets URL grammar.
  return !isProjectView && pointer === (AssetMode.PROJECT_HOME as string);
}

/**
 * Which "nothing selected" surface the assets body shows, once the
 * editor/list/folder branches have been ruled out.
 *
 * The order matters and is the whole point: the never-indexed **Build Index**
 * prompt must not preempt the **project-home** landing. The prompt is for
 * "you're browsing assets and nothing is indexed"; project home is a landing of
 * its own that happens to be hosted by the assets body. When the rails project
 * icon opens `/dock/assets/project-home`, the index status is read UNSCOPED
 * (global) — so on a fresh instance `neverIndexed` is true and, without this
 * guard, the prompt hid project home entirely (only in Advanced view, since the
 * prompt is Advanced-only). See AssetsPage's render chain.
 */
export function shouldShowIndexPrompt(args: {
  neverIndexed: boolean;
  isAdvanced: boolean;
  isProjectHomeMode: boolean;
}): boolean {
  const { neverIndexed, isAdvanced, isProjectHomeMode } = args;
  // Project home always wins over the build prompt — it is a real surface, not
  // an "empty" state.
  return neverIndexed && isAdvanced && !isProjectHomeMode;
}
