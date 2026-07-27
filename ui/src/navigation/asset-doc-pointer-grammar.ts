import { TypeId, VFSPath } from '@sdk';
import {
  AssetEditor,
  AssetMode,
  AssetPointerError,
  AssetRoutingMethod,
  DEFAULT_WIKI_SPACE,
  isAssetEditor,
  isAssetRoutingMethod,
  LOCAL_COMPUTE_NODE,
} from './asset-doc-types';

export interface ParsedAssetDocPointer {
  mode: AssetMode;
  value: string;
  editor?: AssetEditor;
  method?: AssetRoutingMethod;
}

/**
 * Normalize every asset-editor path input to the route-safe absolute VFS form.
 * This pure grammar seam is shared by AssetDocPointer and DockPointer, keeping
 * their dependency one-way (AssetDocPointer may construct a DockPointer;
 * DockPointer never imports AssetDocPointer).
 */
export function normalizeAssetVfsPath(
  pathOrVpath: string,
  computeNode: TypeId = LOCAL_COMPUTE_NODE,
): VFSPath {
  const parsed = VFSPath.parse(pathOrVpath);
  if (parsed.isAbsolute) return parsed;

  const machinePath =
    pathOrVpath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(pathOrVpath)
      ? pathOrVpath
      : `/${pathOrVpath}`;
  return VFSPath.fromMachinePath(machinePath, computeNode);
}

export function parseAssetDocPointer(assetsPointer: string | undefined): ParsedAssetDocPointer {
  const parts = (assetsPointer ?? '').split('/');
  const mode = parts[0];

  if (mode === String(AssetMode.WIKI)) {
    const space = parts[1] ?? '';
    const name = parts.slice(2).join('/');
    return { mode: AssetMode.WIKI, value: `${space}/${name}` };
  }

  if (mode === String(AssetMode.EDITOR)) {
    const editor = parts[1] ?? '';
    const method = parts[2] ?? '';
    const value = parts.slice(3).join('/');
    if (!isAssetEditor(editor)) throw new AssetPointerError(`unknown editor "${editor}"`);
    if (!isAssetRoutingMethod(method)) throw new AssetPointerError(`unknown routing method "${method}"`);
    return { mode: AssetMode.EDITOR, value, editor, method };
  }

  throw new AssetPointerError(`unknown mode "${mode}"`);
}

export function assetEditorValue(
  pointer: string | null,
  method: AssetRoutingMethod,
): string | null {
  if (!pointer) return null;
  try {
    const parsed = parseAssetDocPointer(pointer);
    return parsed.mode === AssetMode.EDITOR && parsed.method === method
      ? parsed.value
      : null;
  } catch {
    return null;
  }
}

export function assetWikiValue(name: string, space: string = DEFAULT_WIKI_SPACE): string {
  return `${space}/${name}`;
}

export function serializeAssetDocPointer(pointer: ParsedAssetDocPointer): string {
  if (pointer.mode === AssetMode.WIKI) {
    return `${AssetMode.WIKI}/${pointer.value}`;
  }
  return `${AssetMode.EDITOR}/${pointer.editor}/${pointer.method}/${pointer.value}`;
}
