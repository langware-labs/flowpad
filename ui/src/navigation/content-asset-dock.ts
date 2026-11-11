import { type TypeId, VFSPath } from '@sdk';
import { AssetDocPointer } from './AssetDocPointer';
import { DockPointer, normalizeRel } from './DockPointer';
import { AssetMode, AssetRoutingMethod, LOCAL_COMPUTE_NODE, hasOwnChat, isFilelessEditor, isPreviewEditor } from './asset-doc-types';
import { ViewType } from '@src/types/ViewType';

export interface ContentAssetTarget {
  /** Stable identity used by prompt context, process reuse, and target_typeid_str. */
  targetVfsPath: string;
  label: string;
  typeId?: string;
  /** Canonical machine/source path when the dock is path-addressed. */
  path?: string;
}

function assetPointerForDock(dock: DockPointer): AssetDocPointer | null {
  const pointer =
    dock.viewType === ViewType.ASSETS
      ? dock.pointer
      : dock.viewType === ViewType.PROJECT
        ? DockPointer.splitProjectPointer(dock.pointer).assetSubPointer
        : null;
  if (!pointer) return null;
  try {
    const parsed = AssetDocPointer.parse(pointer);
    parsed.validate();
    return parsed;
  } catch {
    return null;
  }
}

function labelFromPath(path: VFSPath): string {
  return path.filename || path.entitySubPath.split('/').filter(Boolean).at(-1) || path.absVfsPath;
}

function rawFilePath(pointer: string): VFSPath {
  const parsed = VFSPath.parse(pointer);
  if (parsed.isAbsolute) return parsed;
  if (pointer.startsWith('/') || /^[A-Za-z]:[/\\]/.test(pointer)) {
    return VFSPath.fromMachinePath(pointer, LOCAL_COMPUTE_NODE);
  }
  return VFSPath.fromTypeId(LOCAL_COMPUTE_NODE, normalizeRel(pointer));
}

/** Grammar-first classification for single asset/file content surfaces.
 *
 *  A FILELESS editor is not one of them, and that exclusion is what keeps the assets tree
 *  beside it: this predicate is what routes a dock into `AssetVibeWorkspace` (a work-context
 *  chat plus a chrome-less content pane). That arrangement assumes the dock names a file an
 *  agent could work on — an LLM endpoint names a hub budget with nothing on disk, so it stays
 *  an ordinary browser surface instead of being handed a chat about a path that never
 *  existed. See `FILELESS_EDITORS`. */
export function isContentAssetDock(dock: DockPointer): boolean {
  if (dock.viewType === ViewType.EDITOR) return !!dock.pointer?.trim();
  const pointer = assetPointerForDock(dock);
  if (pointer?.mode === AssetMode.EDITOR) return !isFilelessEditor(pointer.editor);
  return pointer?.mode === AssetMode.WIKI;
}

/** A content-asset dock whose editor is a passive PREVIEW, not an editing surface.
 *  A `flow show` pin of one belongs in the vibe Display pane; routing it to
 *  `AssetVibeWorkspace` instead swaps that pane off screen entirely. */
export function isPreviewAssetDock(dock: DockPointer): boolean {
  const pointer = assetPointerForDock(dock);
  return pointer?.mode === AssetMode.EDITOR && isPreviewEditor(pointer.editor);
}

/** A content-asset dock whose subject has its own chat (an agent): the Vibe chat pane stays shut. */
export function isOwnChatAssetDock(dock: DockPointer): boolean {
  const pointer = assetPointerForDock(dock);
  return pointer?.mode === AssetMode.EDITOR && hasOwnChat(pointer.editor);
}

/** How a viewer takes part in "chat with this doc" — the ONE table every chat
 *  control reads (the viewer toggle, `enterChat`):
 *  - `beside`  — editors: the chat opens beside the doc (`AssetVibeWorkspace`).
 *  - `display` — passive previews (html, image, pdf…): shown in the Vibe Display.
 *  - `own`     — the subject is itself a chat (agent): no doc chat.
 *  - `none`    — not a single content doc (lists, shells, fileless editors). */
export type DocChatMode = 'beside' | 'display' | 'own' | 'none';

export function chatModeOfDock(dock: DockPointer): DocChatMode {
  if (!isContentAssetDock(dock)) return 'none';
  if (isOwnChatAssetDock(dock)) return 'own';
  return isPreviewAssetDock(dock) ? 'display' : 'beside';
}

/** The dock shows one doc you can chat about (`beside` or `display`). */
export function offersDocChat(dock: DockPointer): boolean {
  const mode = chatModeOfDock(dock);
  return mode === 'beside' || mode === 'display';
}

/**
 * Pure canonical process target for a content dock. A loader-resolved entity
 * TypeId wins; otherwise the URL's TypeId or normalized compute-node VFS path
 * is used. The optional argument keeps entity resolution outside navigation.
 */
export function contentAssetTargetForDock(
  dock: DockPointer,
  resolvedTypeId?: TypeId | string | null,
): ContentAssetTarget | null {
  if (!isContentAssetDock(dock)) return null;

  const resolved = typeof resolvedTypeId === 'string' ? resolvedTypeId : resolvedTypeId?.toString();
  if (resolved) {
    return {
      targetVfsPath: resolved,
      label: resolved,
      typeId: resolved,
    };
  }

  if (dock.viewType === ViewType.EDITOR && dock.pointer) {
    const path = rawFilePath(dock.pointer);
    return {
      targetVfsPath: path.absVfsPath,
      label: labelFromPath(path),
      path: path.machinePath || dock.pointer,
    };
  }

  const pointer = assetPointerForDock(dock);
  if (!pointer) return null;
  if (pointer.mode === AssetMode.WIKI) {
    const target = VFSPath.fromTypeId(
      LOCAL_COMPUTE_NODE,
      `wiki/${normalizeRel(`${pointer.space}/${pointer.wikiName}`)}`,
    );
    return {
      targetVfsPath: target.absVfsPath,
      label: pointer.wikiName,
      path: target.machinePath,
    };
  }
  if (pointer.method === AssetRoutingMethod.TYPEID) {
    return {
      targetVfsPath: pointer.value,
      label: pointer.value,
      typeId: pointer.value,
    };
  }

  const path = VFSPath.parse(pointer.value);
  return {
    targetVfsPath: path.absVfsPath,
    label: labelFromPath(path),
    path: path.machinePath,
  };
}
