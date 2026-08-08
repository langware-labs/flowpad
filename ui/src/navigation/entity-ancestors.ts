import { APIEntity, dataManager, Project, TypeId } from '@sdk';

/**
 * Walk an entity's containment chain — the `parent_type_id` edges — so a
 * surface can show WHERE something lives rather than just what it is.
 *
 * `parent_type_id` is the single source of truth for parentage. `group_id` is
 * deliberately NOT consulted: it is a separate containment axis (Groups), and
 * mixing the two would make the chain non-deterministic depending on which edge
 * happened to be set.
 *
 * The loop shape mirrors the sdk's `projectOfParentChain`, which walks the same
 * edges to answer a narrower question ("which project owns this?") and stops at
 * the first hit. Ours collects every hop. They should agree about the shape of
 * the chain even though they return different things — if that walk ever moves
 * or changes its stop conditions, this one should follow.
 */

/**
 * A containment chain deeper than this is a data bug, not a UI case — and the
 * address bar collapses past three crumbs anyway, so the cap costs nothing
 * visible while bounding the sequential fetches on a cold cache.
 *
 * This is a structural depth limit, NOT a timeout: it does not make a slow walk
 * "succeed", it refuses to follow a chain that cannot be legitimate.
 */
export const MAX_ANCESTOR_HOPS = 8;

export interface AncestorNode {
  typeId: TypeId;
  entity: APIEntity<any>;
}

/**
 * Walk `parent_type_id` upward from `startParentRef`, NEAREST-FIRST.
 *
 * Cycle-safe (a `seen` set, so A→B→A terminates) and missing-row-safe (a gap or
 * a rejected fetch truncates the chain rather than failing the whole walk — a
 * partial trail is still useful, a thrown error is not).
 *
 * Stops at a `project`: the project is supplied separately as the LEADING crumb,
 * and rendering it twice would be wrong.
 *
 * `isLive` is the caller's cancellation token. It is checked after every await,
 * not just at the end, so a navigation mid-walk abandons the remaining hops
 * instead of racing the walk that replaced it.
 */
export async function resolveAncestorChain(
  startParentRef: string | null | undefined,
  isLive: () => boolean = () => true,
): Promise<AncestorNode[]> {
  const seen = new Set<string>();
  const out: AncestorNode[] = [];
  let ref: string | null = startParentRef ?? null;

  while (ref && !seen.has(ref) && out.length < MAX_ANCESTOR_HOPS) {
    seen.add(ref);

    let typeId: TypeId;
    try {
      typeId = new TypeId(ref);
    } catch {
      break; // malformed parent ref — stop, don't throw
    }
    if (typeId.type === Project.type) break;

    let entity: APIEntity<any> | null = null;
    try {
      entity = await dataManager.getByTypeId<APIEntity<any>>(typeId);
    } catch {
      break; // missing / unauthorized / hub 404 — truncate the trail
    }
    if (!isLive()) return [];
    if (!entity) break;

    out.push({ typeId, entity });
    ref = (entity as { parent_type_id?: string | null }).parent_type_id ?? null;
  }

  return out;
}
