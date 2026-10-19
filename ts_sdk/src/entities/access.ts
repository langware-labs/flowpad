import { dataManager } from '../APIEntity';
import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';

/** The wildcard both sides of a pass-through mapping carry. */
export const WILDCARD_ROLE = '*';

/**
 * One role mapping on a parent -> child edge: a role arriving at the parent
 * (`'*'` matches any) and what the child confers for it. These are the two ends
 * of the hub's `RoleRelationship` mapping and nothing more — there is
 * deliberately no parallel capability vocabulary.
 */
export interface AccessRule {
  from_role: string;
  to_role: string;
}

/**
 * What one parent confers on one child.
 *
 * `inherit` is the single `('*','*')` edge every child starts with — roles pass
 * through unchanged. `override` is anything else, and its rules come back in a
 * stable order so a re-read does not reshuffle the rows the user is editing.
 */
export interface ChildAccess {
  parent: string;
  mode: 'inherit' | 'override';
  rules: AccessRule[];
}

function accessAction(child: TypeId, parent: TypeId, method: 'GET' | 'PUT' | 'DELETE'): ActionInfo {
  const info = new ActionInfo('access', child.type, child.id, method);
  // The CHILD is the target and the parent rides in the path. The scoped form
  // (`/<parent>/<child>/access`) parses, but scope is enforced — so a child's
  // own owner who holds nothing THROUGH the parent would 403 on their own
  // entity. Keeping the parent in the sub-path also means DELETE needs no body,
  // which enough proxies drop to be a support burden.
  info.subpath = [parent.type, parent.id ?? ''];
  info.hubReflect = true;
  return info;
}

/** Read what `parent` confers on `child`. 404s when `parent` is not its parent. */
export async function getAccess(child: TypeId, parent: TypeId): Promise<ChildAccess> {
  return await dataManager.callAction<undefined, ChildAccess>(accessAction(child, parent, 'GET'));
}

/**
 * Replace every rule `parent` confers on `child`.
 *
 * An empty `rules` restores inherit, which is exactly what `clearAccess` sends.
 * Throws on refusal (403 for a rule above the caller's own rank, 404 for a
 * non-parent) — the caller surfaces it rather than this swallowing it.
 */
export async function setAccess(child: TypeId, parent: TypeId, rules: AccessRule[]): Promise<ChildAccess> {
  const info = accessAction(child, parent, 'PUT');
  info.bodyParameters = { rules };
  return await dataManager.callAction<unknown, ChildAccess>(info);
}

/** Drop every override and return the child to inheriting from `parent`. */
export async function clearAccess(child: TypeId, parent: TypeId): Promise<ChildAccess> {
  return await dataManager.callAction<undefined, ChildAccess>(accessAction(child, parent, 'DELETE'));
}

/**
 * Who a public grant reaches: `visitor` reaches anonymous callers AND every signed-in
 * user, `authenticated` reaches every signed-in human. Mirrors the hub's `PublicAudience`.
 */
export type PublicAudience = 'visitor' | 'authenticated';

/** The role an owner grants to make an agent readable — the row only, no files or verbs. */
export const PUBLIC_VIEWER_ROLE = 'anonymous_viewer';

/** The hub's `PublicAccess`: the role one audience holds on the target, or null when private to it. */
export interface PublicAccess {
  audience: PublicAudience;
  role: string | null;
}

function publicAccessAction(target: TypeId, audience: PublicAudience, method: 'GET' | 'PUT' | 'DELETE'): ActionInfo {
  const info = new ActionInfo('access', target.type, target.id, method);
  info.subpath = ['public', audience];
  info.hubReflect = true;
  return info;
}

/**
 * Read the role `audience` holds on `target`: `GET <type>/<id>/access/public/<audience>`.
 *
 * Owner-only on the hub, reads included — so a rejection also means "this caller may
 * not change it", and callers can gate their controls on it.
 */
export async function getPublicAccess(target: TypeId, audience: PublicAudience): Promise<PublicAccess> {
  return await dataManager.callAction<undefined, PublicAccess>(publicAccessAction(target, audience, 'GET'));
}

/**
 * Grant `audience` a role on `target`: `PUT <type>/<id>/access/public/<audience>` with `{role}`.
 *
 * Owner-only and opt-in per type on the hub (`public_access` in its policies), so a
 * refusal (403 not the owner, 400 a type or role that cannot be public) is thrown for
 * the caller to surface. Applies to the target only — its children stay private.
 */
export async function setPublicAccess(target: TypeId, audience: PublicAudience, role: string): Promise<PublicAccess> {
  const info = publicAccessAction(target, audience, 'PUT');
  info.bodyParameters = { role };
  return await dataManager.callAction<unknown, PublicAccess>(info);
}

/** Revoke `audience`'s access to `target`: `DELETE <type>/<id>/access/public/<audience>`. */
export async function clearPublicAccess(target: TypeId, audience: PublicAudience): Promise<PublicAccess> {
  return await dataManager.callAction<undefined, PublicAccess>(publicAccessAction(target, audience, 'DELETE'));
}
