import { dataManager, isTypeId, isValidUUIDv4, TypeId } from '@sdk';
import type { TypeShape } from '@sdk/FlowSync/schema';

/**
 * Resolve a descriptor's typeid string to the cached entity's `displayName`.
 *
 * `fallbackName` is the descriptor's own `name` — sent by the backend only for
 * an on-disk asset with no entity row yet. Such a row can never resolve from
 * cache, so without it the picker would render a raw `skill-<uuid>`. It is
 * preferred over the typeid but never over a real cached entity, so an indexed
 * asset keeps showing its live `displayName` (which a rename updates).
 */
export function displayLabelForTypeid(typeid: string, fallbackName?: string | null): string {
  const fallback = fallbackName?.trim() || typeid;
  // Name-form pseudo-typeids (entity-less inline personas, `subagent-<name>`)
  // aren't cache-resolvable — show the bare name, not the raw pair.
  if (!isTypeId(typeid)) return parseTypeid(typeid).id || fallback;
  try {
    const entity = dataManager.getByTypeIdFromCache(new TypeId(typeid));
    return entity?.displayName ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Descriptor-level label. Every surface already holds the whole descriptor, so
 * take it whole — a call site cannot forget to thread the on-disk `name`
 * fallback (forgetting it silently regresses to a raw `skill-<uuid>`).
 */
export function displayLabelForDescriptor(d: { typeid: string; name?: string | null }): string {
  return displayLabelForTypeid(d.typeid, d.name);
}

export function parseTypeid(typeid: string): { type: string; id: string } {
  const dash = typeid.indexOf('-');
  if (dash < 0) return { type: typeid, id: '' };
  return { type: typeid.slice(0, dash), id: typeid.slice(dash + 1) };
}

/**
 * Whether a descriptor's typeid points at a real backing entity that can be
 * opened in an editor/viewer. Entity ids are always UUID v4/v5 (policy), so
 * gate on that rather than the looser isTypeId grammar: an entity-less inline
 * persona carries a name-form pseudo-typeid (e.g. `subagent-team.lead`) that
 * parses as well-formed but has nothing to open. Single source of truth for
 * the "click to open" affordance shared by the asset picker and manager rows.
 */
export function isOpenableTypeid(typeid: string): boolean {
  return isTypeId(typeid) && isValidUUIDv4(parseTypeid(typeid).id);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Canonicalize a filesystem/VFS path for comparison and basename extraction:
 * backslashes → `/`, collapse repeated `/`, drop a trailing `/`. Shared by
 * `dirname`/`descriptorKey` below and `improvableMainFile` so the normalization
 * can't drift between them.
 */
export function normalizePath(path: string | null | undefined): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

/** The directory containing `path`, normalized. `.` when there is no separator. */
export function dirname(path: string): string {
  const n = normalizePath(path);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(0, idx) || '/' : '.';
}

/**
 * Stable identity for a descriptor's *asset* (not its row): typeid + normalized
 * path. The improve flow keys its busy state on this, so the host that launches
 * an improvement and the row that renders the spinner agree on one key.
 */
export function descriptorKey(descriptor: { typeid: string; posix_path?: string | null }): string {
  return `${descriptor.typeid}@${normalizePath(descriptor.posix_path)}`;
}

/** The subset of a type's TypeInfo that decides its improvable main file. */
export interface ImprovableTypeInfo {
  shape?: TypeShape | null;
}

/**
 * The main file the asset "Improve" flow would edit for a descriptor, or `null`
 * when it can't be resolved — in which case the wand must be HIDDEN rather than
 * shown-then-errored ("no main file metadata"). Single source of truth shared by
 * the row's `canImprove` gate and `resolveImproveTarget`, so the affordance is
 * offered iff improvement can actually run:
 *   - folder-shaped type → its TypeInfo `shape.main` (empty ⇒ not improvable)
 *   - flat type          → the path basename
 */
export function improvableMainFile(
  descriptor: { typeid: string; posix_path?: string | null },
  typeInfoByName: Map<string, ImprovableTypeInfo>,
): string | null {
  const assetPath = normalizePath(descriptor.posix_path);
  if (!assetPath) return null;
  const { type } = parseTypeid(descriptor.typeid);
  const ti = typeInfoByName.get(type);
  const shape = ti?.shape;
  const file = shape?.kind === 'folder' ? (shape.main ?? '') : basename(assetPath);
  return file || null;
}
