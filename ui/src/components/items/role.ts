import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { ROLE_ORDER, roleCapabilities } from '@sdk/models/roles';

/** What the signed-in person is on an item, as one word on its card and header. */
export type ItemRole = 'owner' | 'admin' | 'reader';

export const ITEM_ROLES: Record<ItemRole, MessageDescriptor> = {
  owner: msg`Owner`,
  admin: msg`Admin`,
  reader: msg`Reader`,
};

interface Expandable {
  expand?: { roles?: string[] | null; allowed_actions?: string[] | null } | null;
  getType?: () => string;
}

/**
 * The strongest role the item's permission expansion names. `undefined` when the item was read
 * without `expand: ['permissions']` — the card then shows no chip rather than a wrong one.
 */
export function roleOf(entity: Expandable | null | undefined): ItemRole | undefined {
  const roles = entity?.expand?.roles;
  if (!roles?.length) return undefined;
  // The SDK's own role hierarchy; an owner by API key is an owner here, editor and runner read.
  // The backend names roles in either case ("OWNER" from a permissions expansion): compare lower-case,
  // or an owner reads as a Reader.
  const known = roles.map((r) => String(r).trim().toLowerCase()).filter((r) => (ROLE_ORDER as readonly string[]).includes(r));
  const held = roleCapabilities(known as (typeof ROLE_ORDER)[number][]);
  if (held.has('owner') || held.has('owner_by_api')) return 'owner';
  if (held.has('admin')) return 'admin';
  return 'reader';
}

/**
 * Whether the person may run `action` on the item. `undefined` when permissions were not expanded:
 * callers draw the control then (the server still refuses), never throw as `isAllowedAction` does.
 */
export function canDo(entity: Expandable | null | undefined, action: string): boolean | undefined {
  const allowed = entity?.expand?.allowed_actions;
  if (!allowed) return undefined;
  // `*`: the desktop backend's answer for an item's owner -- every action.
  if (allowed.includes('*')) return true;
  const type = entity?.getType?.();
  return allowed.includes(action) || (!!type && allowed.includes(`${type}.${action}`));
}

/** The list-query option an items tab passes so `roleOf` / `canDo` have something to read. */
export const WITH_PERMISSIONS = { expand: ['permissions'] } as const;
