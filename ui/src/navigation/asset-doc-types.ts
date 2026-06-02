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
export { AssetEditor, EDITOR_TYPES, TYPE_TO_EDITOR, editorForType, isAssetEditor } from '@sdk';

/** How `<value>` identifies the asset — the `<method>` URL segment (editor mode only). */
export enum AssetRoutingMethod {
  VFS = 'vfs', // value = absVfsPath: "<computeNodeTypeId>/<relPath>"
  TYPEID = 'typeid', // value = the asset's own TypeId: "<type>-<uuid>"
}

/** Top-level asset pointer mode (the segment after `assets/`). */
export enum AssetMode {
  EDITOR = 'editor',
  WIKI = 'wiki',
}

/** Default wiki space (the local compute node). */
export const DEFAULT_WIKI_SPACE = '@local';

export function isAssetRoutingMethod(v: string): v is AssetRoutingMethod {
  return (Object.values(AssetRoutingMethod) as string[]).includes(v);
}

/** Thrown by AssetDocPointer.parse/validate on a malformed pointer. */
export class AssetPointerError extends Error {
  constructor(message: string) {
    super(`Invalid asset pointer: ${message}`);
    this.name = 'AssetPointerError';
  }
}
