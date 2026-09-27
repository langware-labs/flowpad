/**
 * Asset dock loader for
 *   /dock/assets/editor/<editor>/<method>/<value>
 *   /dock/assets/wiki/<space>/<name>
 *   /dock/assets/list/<typeName>            (browser view — no-op here)
 *   /dock/assets/folder/<typeName>/<id>/... (browser view — no-op here)
 *   /dock/assets/project-home               (browser view — no-op here)
 *
 * URL-first asset resolution: parse the pointer, resolve the backing entity by
 * its routing method, and write it into context (warm the cache + set the active
 * entity) so the editor renders without doing its own path resolution. No
 * redirect — every routing method (`vfs`, `typeid`, `wiki`) is a first-class
 * resting URL. Best-effort: a miss/parse-failure is non-fatal (the view renders
 * its own missing/error state); never throws into the parent dock loader.
 */
import { ContextEntitiesEnum, Project, TypeId, VFSPath, dataContext, dataManager } from '@sdk';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetMode, AssetRoutingMethod, isBrowseListPointer, isFileOnlyEditor } from '@src/navigation/asset-doc-types';
import { resolveWikiWord } from '@src/components/wiki/resolve-wiki';
import type { WikiAuthority } from '@src/components/wiki/resolve-wiki';
import { getWikiResolveResult, setWikiResolveResult } from './wiki-resolve-store';

// The fields the loader derives context from. `project_id` is a backend
// projection, not a typed field on the base entity, so resolved entities are
// narrowed to this shape rather than carried as their full type.
type ContextEntity = { typeId: TypeId; project_id?: string; asset_ref?: string };

/** True when `path` is `mount` or lives inside it (path-segment safe). */
function mountContains(mount: string, path: string): boolean {
  const m = mount.replace(/\/+$/, '');
  return path === m || path.startsWith(`${m}/`);
}

/**
 * Mark a resolved entity active AND load its owning project into context, so the
 * editor renders inside the right project (the loader is the single writer of
 * context — derive project from the entity, never optimistically elsewhere).
 * Project is best-effort: an entity without `project_id` (user/system-scoped)
 * leaves the current project untouched.
 *
 * Current-project priority: when the asset's path lives inside the CURRENT
 * project's mount, opening it must NOT switch the active project — even if the
 * entity's stamped `project_id` names a different (e.g. nested or umbrella)
 * project. The switch is for crossing into a genuinely different project, not
 * for re-deriving ownership of a file the user is already working on.
 */
async function setEntityContext(entity: ContextEntity | null): Promise<void> {
  if (!entity) return;
  await dataContext.setActiveEntityTypeId(entity.typeId);
  if (!entity.project_id || entity.project_id === dataContext.project?.id) return;
  const currentMount = dataContext.project?.fs_storage_mount_path;
  if (currentMount && entity.asset_ref && mountContains(currentMount, entity.asset_ref)) return;
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProjectTypeId,
    new TypeId(Project.type, entity.project_id),
  );
}

/** Machine paths `/assets/entity` answered with nothing, this session. */
const pathMisses = new Set<string>();
/** Machine paths `/assets/entity` answered with an entity — the URL's own spelling of the path, which
 *  need not match the entity's `asset_ref` (a symlinked dir: `/var/…` in the URL, `/private/var/…` stored). */
const pathHits = new Map<string, TypeId>();

/** The cached entity whose `asset_ref` is `machinePath` (the form asset_ref is stored in). */
function cachedEntityAtPath(machinePath: string): ContextEntity | null {
  for (const ref of dataManager.entities.values()) {
    const entity = ref.entity as unknown as ContextEntity | undefined;
    if (entity?.asset_ref === machinePath) return entity;
  }
  return null;
}

/** Warm the cache by typeid, then push the resolved entity into context. */
async function ensureInContext(typeId: TypeId): Promise<void> {
  const entity = await dataManager.getByTypeId(typeId).catch(() => null);
  // Fall back to a typeId-only context set if the fetch missed, so active state
  // is still derived from the URL even when the entity isn't cacheable.
  await setEntityContext((entity as ContextEntity | null) ?? { typeId });
}

export async function loadAssetRoute(
  pointer: string | undefined,
  options: {
    allowLocalWikiAlias?: boolean;
    wikiAuthority?: WikiAuthority;
  } = {},
): Promise<void> {
  if (!pointer) return; // assets list / no editor open — nothing to resolve.

  // `list/<typeName>`, `folder/<...>`, and `project-home` are browser views,
  // not single editor targets. They have no backing entity to warm into context
  // — the view resolves its own contents — so short-circuit before parsing
  // rather than letting AssetDocPointer.parse throw `unknown mode "list"` /
  // `unknown mode "folder"`.
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
      const authority = options.wikiAuthority ?? 'local';
      // Reuse what this session already resolved (dock-loading I4). The one event
      // that changes the answer — creating the missing page — clears the result in
      // the view that creates it, so the next visit resolves afresh.
      const result =
        getWikiResolveResult(ptr.space, ptr.wikiName, authority) ??
        (await resolveWikiWord(ptr.space, ptr.wikiName, {
          allowLocalAlias: options.allowLocalWikiAlias,
          authority,
        }));
      setWikiResolveResult(ptr.space, ptr.wikiName, result, authority);
      if (result.kind === 'resolved') await ensureInContext(result.target_typeid);
      return;
    }

    // EDITOR mode
    if (ptr.editor && isFileOnlyEditor(ptr.editor)) return; // file-only (code/html/media…), no backing entity.

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
    // discover).
    const machine = VFSPath.parse(ptr.value).machinePath;
    if (machine) {
      // Cache-first (dock-loading I4): a revisit must not wait on a lookup it
      // already made. A remembered miss (a file nothing indexed) stays a miss
      // until an entity for the path reaches the cache — the scan above finds it
      // first — so the negative memo heals itself; the view resolves a miss on
      // its own either way.
      const known = pathHits.get(machine);
      const cached =
        (known ? (dataManager.getByTypeIdFromCache(known) as unknown as ContextEntity | null) : null) ??
        cachedEntityAtPath(machine);
      if (cached) {
        await setEntityContext(cached);
      } else if (!pathMisses.has(machine)) {
        const e = (await dataManager.getEntityByPath(machine).catch(() => null)) as ContextEntity | null;
        if (e) pathHits.set(machine, e.typeId);
        else pathMisses.add(machine);
        await setEntityContext(e);
      }
    }
  } catch (e) {
    console.warn('[load-asset] resolve failed (view will handle):', pointer, e);
  }
}
