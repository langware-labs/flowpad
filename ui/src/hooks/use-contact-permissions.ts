import { useMemo } from 'react';
import { ContactPermission, normalizeEmail, PermissionAction, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/** Minimal contact identity for keying permissions (user id preferred, email fallback). */
export interface ContactKey {
  userId?: string | null;
  email?: string | null;
}

/** True when a permission row keys the given contact (user id OR email). */
export function rowMatchesContact(p: ContactPermission, c: ContactKey | null): boolean {
  if (!c) return false;
  if (c.userId && p.contact_user_id && p.contact_user_id === c.userId) return true;
  if (c.email && p.contact_email) {
    return normalizeEmail(p.contact_email) === normalizeEmail(c.email);
  }
  return false;
}

/** The standing-grant scope a contact holds for live sessions: the
 *  project-scoped row wins, then the global row, else null. Pure. */
export function sessionGrantScope(
  permissions: readonly ContactPermission[],
  projectId: string | null,
): 'project' | 'global' | null {
  const has = (p: ContactPermission) => (p.allowed_actions ?? []).includes(PermissionAction.AUTO_APPROVE_SESSION);
  if (projectId && permissions.some((p) => (p.project_id ?? null) === projectId && has(p))) return 'project';
  if (permissions.some((p) => (p.project_id ?? null) === null && has(p))) return 'global';
  return null;
}

/** Live list of one contact's permission rows (the host's local policy). */
export function useContactPermissions(contact: ContactKey | null) {
  const request = useMemo(() => new QueryRequest({ type: ContactPermission.type }), []);
  const { data = [], refetch } = useEntitiesQuery<ContactPermission>(request);
  const permissions = useMemo(
    () => data.filter((p) => rowMatchesContact(p, contact)),
    [data, contact],
  );
  return { permissions, refetch };
}

/** The (contact, project) row, or null. project null = the global row. */
async function findRow(contact: ContactKey, projectId: string | null): Promise<ContactPermission | null> {
  const all = await ContactPermission.query(new QueryRequest({ type: ContactPermission.type }), true).catch(() => [] as ContactPermission[]);
  return (
    all.find(
      (p) => rowMatchesContact(p, contact) && (p.project_id ?? null) === (projectId ?? null),
    ) ?? null
  );
}

/** Grant `action` to a contact for a project (null = global), creating the row if needed. */
export async function grantContactPermission(
  contact: ContactKey,
  projectId: string | null,
  action: PermissionAction,
): Promise<void> {
  const existing = await findRow(contact, projectId);
  if (existing) {
    if (!(existing.allowed_actions ?? []).includes(action)) {
      existing.allowed_actions = [...(existing.allowed_actions ?? []), action];
      await existing.save([]);
    }
    return;
  }
  const row = new ContactPermission({
    contact_user_id: contact.userId ?? null,
    contact_email: normalizeEmail(contact.email),
    project_id: projectId,
    allowed_actions: [action],
  });
  await row.save([]);
}

/** Revoke `action`; deletes the row when it has no actions left. */
export async function revokeContactPermission(
  contact: ContactKey,
  projectId: string | null,
  action: PermissionAction,
): Promise<void> {
  const row = await findRow(contact, projectId);
  if (!row) return;
  const next = (row.allowed_actions ?? []).filter((a) => a !== action);
  if (next.length === 0) {
    await row.delete();
    return;
  }
  row.allowed_actions = next;
  await row.save([]);
}
