/**
 * Canonical asset-editor URL vocabulary.
 *
 * Every asset/editor URL is `/dock/assets/editor/<AssetEditor>/<AssetRoutingMethod>/<value>`
 * (or the wiki form `/dock/assets/wiki/<space>/<name>`). The editor segment selects
 * the editor COMPONENT (one editor serves many record types — see EDITOR_TYPES); the
 * routing-method segment makes the addressing scheme explicit so a filesystem path can
 * never be mistaken for a TypeId. Parsing/building/validation lives in `AssetDocPointer`.
 */
// AssetEditor + the editor↔type mapping live in the SDK (single source of truth,
// reused by the SDK entity pointer getters); re-exported here for UI imports.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { TypeId } from '@sdk';
export {
  AssetEditor,
  EDITOR_TYPES,
  FILELESS_EDITORS,
  PREVIEW_EDITORS,
  TYPE_TO_EDITOR,
  editorForPath,
  editorForType,
  hasOwnChat,
  isAssetEditor,
  isFileOnlyEditor,
  isFilelessEditor,
  isPreviewEditor,
  primaryTypeForEditor,
} from '@sdk';

/** How `<value>` identifies the asset — the `<method>` URL segment (editor mode only). */
export enum AssetRoutingMethod {
  VFS = 'vfs', // value = absVfsPath: "<computeNodeTypeId>/<relPath>"
  TYPEID = 'typeid', // value = the asset's own TypeId: "<type>-<uuid>"
}

/** Top-level asset pointer mode (the segment after `assets/`). */
export enum AssetMode {
  EDITOR = 'editor',
  WIKI = 'wiki',
  // Multi-entity browser view (`list/<typeName>`), e.g. the Skills list folded
  // into the Assets browser. No single backing entity — the list view resolves
  // its own contents, so `AssetDocPointer` doesn't model it and the asset loader
  // treats it as a no-op rather than a parse error.
  LIST = 'list',
  // Folder browser view (`folder/<typeName>/<typeid>/<relPath>`), parsed by
  // `DockPointer.parseAssetFolderPointer`. Like LIST it browses a directory
  // rather than addressing one entity, so the asset loader no-ops it instead of
  // letting AssetDocPointer.parse throw `unknown mode "folder"`.
  FOLDER = 'folder',
  // Project landing rendered inside the project-scoped Assets tab. It is a
  // browser surface, not a single asset entity, so the asset loader no-ops it.
  PROJECT_HOME = 'project-home',
  // The project's setup page (Project Home ☰ → Project setup): every setup step, its state, Edit/Run/Rerun.
  // A surface like the landing, so the asset loader no-ops it too.
  PROJECT_SETUP = 'project-setup',
}

/** Default wiki space (the local compute node). */
export const DEFAULT_WIKI_SPACE = '@local';

/**
 * Query-param key carrying a wiki page's heading anchor (a GFM slug like
 * "auto-run"). Lives in `DockPointer.options`, mirroring `HIGHLIGHT_PARAM`, so a
 * wiki link can deep-link into a section without changing the path grammar.
 */
export const WIKI_FRAGMENT_PARAM = 'wikiFragment';

/** The local compute node's TypeId — the always-available `@local` filesystem
 *  root. Single source for `new TypeId('compute_node', '@local')`. */
export const LOCAL_COMPUTE_NODE = new TypeId('compute_node', DEFAULT_WIKI_SPACE);

export function isAssetRoutingMethod(v: string): v is AssetRoutingMethod {
  return (Object.values(AssetRoutingMethod) as string[]).includes(v);
}

/**
 * True for browser-only pointers — `list/<type>`, `folder/<…>`, and the project
 * landing — which address a directory/list/surface rather than a single backing
 * entity. These are NOT modeled by `AssetDocPointer` (the browser views resolve
 * their own contents), so the asset route loader no-ops them instead of letting
 * `AssetDocPointer.parse` throw `unknown mode "list"` / `unknown mode "folder"`.
 * Pure + dependency-free so it's unit-testable in isolation.
 */
export function isBrowseListPointer(pointer: string): boolean {
  return (
    pointer.startsWith(`${AssetMode.LIST}/`) ||
    pointer.startsWith(`${AssetMode.FOLDER}/`) ||
    isProjectLandingPointer(pointer)
  );
}

/**
 * The project's own pages, hosted by Project Home: no backing entity, the project's own tab, and the last
 * breadcrumb says which page. A new Project Home page is a row here.
 */
export interface ProjectLandingPage {
  /** The last breadcrumb on this page. */
  label: MessageDescriptor;
  /** Addressed under `/dock/project/<id>/<pointer>` too. The landing itself is not: the project dock
   *  reaches it by addressing nothing, and `project-home` belongs to the `/dock/assets` grammar. */
  underProjectDock: boolean;
}

export const PROJECT_LANDING_PAGES: Record<string, ProjectLandingPage> = {
  [AssetMode.PROJECT_HOME]: { label: msg`Home`, underProjectDock: false },
  [AssetMode.PROJECT_SETUP]: { label: msg`Project setup`, underProjectDock: true },
};

/** The Project Home page `pointer` addresses under the given dock, else null. */
export function projectLandingPageOf(
  pointer: string | null | undefined,
  { underProjectDock = false }: { underProjectDock?: boolean } = {},
): ProjectLandingPage | null {
  const page = pointer && Object.hasOwn(PROJECT_LANDING_PAGES, pointer) ? PROJECT_LANDING_PAGES[pointer] : null;
  return page && (!underProjectDock || page.underProjectDock) ? page : null;
}

export function isProjectLandingPointer(pointer: string | null | undefined): boolean {
  return projectLandingPageOf(pointer) !== null;
}

/** Thrown by AssetDocPointer.parse/validate on a malformed pointer. */
export class AssetPointerError extends Error {
  constructor(message: string) {
    super(`Invalid asset pointer: ${message}`);
    this.name = 'AssetPointerError';
  }
}
