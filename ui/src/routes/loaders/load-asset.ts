/**
 * Asset dock loader for
 *   /dock/assets/editor/<editor>/<method>/<value>
 *   /dock/assets/wiki/<space>/<name>
 *
 * URL-first asset resolution: parse the pointer, resolve the backing entity by
 * its routing method, and write it into context (warm the cache + set the active
 * entity) so the editor renders without doing its own path resolution. No
 * redirect — every routing method (`vfs`, `typeid`, `wiki`) is a first-class
 * resting URL. Best-effort: a miss/parse-failure is non-fatal (the view renders
 * its own missing/error state); never throws into the parent dock loader.
 */
import { TypeId, VFSPath, apiClient, dataContext, dataManager, systemTools } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod, EDITOR_TYPES } from '@src/navigation/asset-doc-types';

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

/** Discover a vfs-addressed asset, trying each record type the editor can edit.
 *  Candidates run concurrently (one round-trip latency, not N) — for the markdown
 *  family that's 6 types; a 404 on a wrong-type candidate is expected. */
async function discoverByEditor(editor: AssetEditor, absPath: string): Promise<TypeId | null> {
  const results = await Promise.allSettled(
    EDITOR_TYPES[editor].map((type) => systemTools.discoverByPath(type, absPath)),
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.type && r.value?.id) {
      return new TypeId(r.value.type, r.value.id);
    }
  }
  return null;
}

/** Put a resolved entity into context: warm the cache + mark it active. */
async function ensureInContext(typeId: TypeId): Promise<void> {
  await dataManager.getByTypeId(typeId).catch(() => null);
  await dataContext.setActiveEntityTypeId(typeId);
}

export async function loadAssetRoute(pointer: string | undefined): Promise<void> {
  if (!pointer) return; // assets list / no editor open — nothing to resolve.

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

    // VFS: discover the entity for the file, then warm context.
    const vfs = VFSPath.parse(ptr.value);
    const absPath = '/' + vfs.entitySubPath;
    const typeId = await discoverByEditor(ptr.editor!, absPath);
    if (typeId) await ensureInContext(typeId);
  } catch (e) {
    console.warn('[load-asset] resolve failed (view will handle):', pointer, e);
  }
}
