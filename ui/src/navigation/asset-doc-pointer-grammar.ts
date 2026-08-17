import { canonicalWikiWord, splitWikiValue, TypeId, VFSPath, type AssetWikiRef } from '@sdk';
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
    // Canonical: wiki/<wiki-ref>/<word...>. Keep the historical
    // wiki/<word> deep link as the project-scoped @local Wiki.
    const legacy = parts.length === 2;
    const space = legacy ? DEFAULT_WIKI_SPACE : (parts[1] ?? '');
    const name = legacy ? (parts[1] ?? '') : parts.slice(2).join('/');
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

/**
 * Read `space`, `name` and the canonical `word` off a `wiki/…` asset pointer,
 * or null for any other mode. The inverse of `assetWikiValue`.
 *
 * A wiki route is the one asset form addressed by NAME rather than by typeid or
 * path — deliberate (it survives a rename), but it also means callers that want
 * to say what the route points at get nothing from `targetTypeId` or `vfsPath`.
 * This is what they parse instead. The splitting rules live in the SDK
 * (`splitWikiValue`) because the SDK's own tab naming needs the same answer.
 */
export function parseAssetWikiRef(assetsPointer: string | null | undefined): AssetWikiRef | null {
  if (!assetsPointer) return null;
  let parsed: ParsedAssetDocPointer;
  try {
    parsed = parseAssetDocPointer(assetsPointer);
  } catch {
    return null;
  }
  if (parsed.mode !== AssetMode.WIKI) return null;
  return splitWikiValue(parsed.value);
}

export function serializeAssetDocPointer(pointer: ParsedAssetDocPointer): string {
  if (pointer.mode === AssetMode.WIKI) {
    return `${AssetMode.WIKI}/${pointer.value}`;
  }
  return `${AssetMode.EDITOR}/${pointer.editor}/${pointer.method}/${pointer.value}`;
}

export { canonicalWikiWord, type AssetWikiRef };
