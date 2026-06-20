/**
 * Asset dock loader for
 *   /dock/assets/editor/<editor>/<method>/<value>
 *   /dock/assets/wiki/<space>/<name>
 *   /dock/assets/list/<typeName>            (browser view — no-op here)
 *   /dock/assets/folder/<typeName>/<id>/... (browser view — no-op here)
 *
 * URL-first asset resolution: parse the pointer, resolve the backing entity by
 * its routing method, and write it into context (warm the cache + set the active
 * entity) so the editor renders without doing its own path resolution. No
 * redirect — every routing method (`vfs`, `typeid`, `wiki`) is a first-class
 * resting URL. Best-effort: a miss/parse-failure is non-fatal (the view renders
 * its own missing/error state); never throws into the parent dock loader.
 */
import { TypeId, VFSPath, apiClient, dataContext, dataManager } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod, isBrowseListPointer } from '@src/navigation/asset-doc-types';

interface WikiResolveResult {
  type: string;
  id: string;
  asset_ref?: string;
}

/** Resolve a wiki name within a space to an entity ref. Mirrors WikiResolveView. */
async function wikiResolve(name: string, space: string): Promise<WikiResolveResult | null> {
  try {
    const body = (await apiClient.get<WikiResolveResult | null>('/wiki/resolve', {
      params: { name, space },
      transformResponse: (raw: string) => ({ data: JSON.parse(raw) }),
    })) as WikiResolveResult | null;
    if (!body || typeof body !== 'object' || !('type' in body) || !('id' in body)) return null;
    return body;
  } catch {
    return null;
  }
}

/** Put a resolved entity into context: warm the cache + mark it active. */
async function ensureInContext(typeId: TypeId): Promise<void> {
  await dataManager.getByTypeId(typeId).catch(() => null);
  await dataContext.setActiveEntityTypeId(typeId);
}

export async function loadAssetRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return; // assets list / no editor open — nothing to resolve.

  // `list/<typeName>` and `folder/<...>` are multi-entity browser views (the
  // Skills list, a markdown folder), not single editor targets. They have no
  // backing entity to warm into context — the view resolves its own contents —
  // so short-circuit before parsing rather than letting AssetDocPointer.parse
  // throw `unknown mode "list"` / `unknown mode "folder"`.
  if (isBrowseListPointer(pointer)) return;

  let ptr: AssetDocPointer;
  try {
    ptr = AssetDocPointer.parse(pointer);
    ptr.validate();
  } catch (e) {
    console.warn('[load-asset] invalid asset pointer (view will handle):', pointer, e);
    return;
  }

  try {
    if (ptr.mode === AssetMode.WIKI) {
      const hit = await wikiResolve(ptr.wikiName, ptr.space);
      if (hit) await ensureInContext(new TypeId(hit.type, hit.id));
      return;
    }

    // EDITOR mode
    if (ptr.editor === AssetEditor.CODE) return; // file-only, no backing entity.

    if (ptr.method === AssetRoutingMethod.TYPEID) {
      await ensureInContext(new TypeId(ptr.value));
      return;
    }

    // VFS: resolve via the CHEAP exact path→entity lookup (`/assets/entity`,
    // `getEntityByPath`) — a pure indexed DB match, NOT the heavy
    // `/fs-records/discover` recovery scan (same cost class as the typeid
    // `getByTypeId` above, so "loaders must be fast" holds). This warms the
    // cache AND sets active context so vfs behaves like typeid/wiki.
    // `machinePath` (not `absVfsPath`) is the form `asset_ref` is stored in.
    // On a miss (not-yet-indexed) the view still self-resolves via
    // `AssetEditorRouter` → `EntityResolutionGate` → `useEntityByPath` (lazy
    // discover). `getEntityByPath` already caches the hit, so this is the only
    // network round-trip.
    const machine = VFSPath.parse(ptr.value).machinePath;
    if (machine) {
      const e = await dataManager.getEntityByPath(machine).catch(() => null);
      if (e) await dataContext.setActiveEntityTypeId(e.typeId);
    }
  } catch (e) {
    console.warn('[load-asset] resolve failed (view will handle):', pointer, e);
  }
}
