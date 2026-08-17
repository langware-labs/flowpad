import type { EntityMember, TypeId } from '@sdk';
import { Loader2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { avatarColorForParticipant } from '@src/components/conversation/avatar-color';
import {
  assignableRoles,
  participantInitials,
  participantLabel,
  participantRank,
  participantRoleLabel,
} from '@src/components/conversation/participant-display';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

/**
 * The member roster primitives, shared by the account dialog's organization tab
 * and the Organization WorldView drawer.
 *
 * One component, two densities: the dialog renders a read-only summary, the
 * drawer passes ``manage`` to reveal the role control and the remove button. The
 * interaction vocabulary is deliberately the same one the conversation roster
 * already uses (a native ``select`` for the role, an ``X`` to remove), so there is
 * one way to manage members in the product rather than three.
 */

/** A team/org that holds a role appears in the roster as a first-class row with
 *  ``user_id === null`` — the principal id lives in ``id``. */
export function isGroupMember(member: EntityMember): boolean {
  const type = (member as { type?: string }).type;
  return type === 'team' || type === 'organization';
}

/** The id the hub's members endpoints expect for this row (people and groups
 *  share the ``user_id`` slot on the wire; for a group it carries the principal). */
export function memberPrincipalId(member: EntityMember): string | undefined {
  return member.user_id ?? ((member as { id?: string }).id || undefined);
}

/**
 * Roles the caller may assign to this row.
 *
 * Delegates to the shared ``assignableRoles`` for people. Group rows need their
 * own path because that helper bails on a missing ``user_id``  — correctly, since
 * for a conversation such a row is a pending email invite that cannot be re-roled
 * by id. A group row is the opposite: it has no ``user_id`` by nature and is
 * always re-rolable, and it can never be "self", so only the ladder applies.
 */
export function assignableRolesForMember(me: EntityMember | null | undefined, member: EntityMember): string[] {
  if (!isGroupMember(member)) return assignableRoles(me as never, member as never);
  const myRank = participantRank(me as never);
  const targetRank = participantRank(member as never);
  if (myRank === null || targetRank === null) return [];
  if (targetRank <= myRank) return [];
  return assignableRoles(me as never, { ...(member as object), user_id: 'group' } as never);
}

export interface MemberActions {
  /** Change a member's role. Receives the principal id (user or group). */
  onSetRole: (principalId: string, role: string) => Promise<void>;
  /** Remove a member. Receives the principal id (user or group). */
  onRemove: (principalId: string) => Promise<void>;
}

export function MemberRow({
  member,
  isSelf,
  me,
  manage,
  actions,
}: {
  member: EntityMember;
  isSelf: boolean;
  me?: EntityMember | null;
  manage?: boolean;
  actions?: MemberActions;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const color = avatarColorForParticipant(member as never, isSelf);
  const label = participantLabel(member as never);
  const initials = participantInitials(member as never);
  const role = participantRoleLabel(member as never);
  const pending = (member.status || '').toLowerCase() === 'pending';
  const isGroup = isGroupMember(member);
  const principalId = memberPrincipalId(member);

  const options = manage && actions ? assignableRolesForMember(me, member) : [];
  const currentRole = (member.role || '').toLowerCase();
  // A group is rendered with its own glyph rather than initials, so a class
  // inside a school reads as a class and not as a person with odd initials.
  const GroupIcon = isGroup ? iconForType((member as { type?: string }).type || 'team') : null;

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <li className={`flex items-center gap-2 ${busy ? 'opacity-40' : ''}`} data-testid="member-row">
      {GroupIcon ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <GroupIcon size={14} />
        </span>
      ) : (
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${color}`}
        >
          {initials}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm">
        {label}
        {isSelf && (
          <span className="text-muted-foreground">
            <Trans> (you)</Trans>
          </span>
        )}
      </span>
      {manage && actions && options.length > 0 && principalId ? (
        <select
          data-testid="member-role-select"
          aria-label={t`Role`}
          className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs"
          value={currentRole}
          disabled={busy}
          onChange={(e) => void run(() => actions.onSetRole(principalId, e.target.value))}
        >
          {/* The current role may sit outside what the caller can assign (e.g.
              ``guest``, or a comma-joined multi-role). Injected as disabled so the
              control is never blank. */}
          {!options.includes(currentRole) && (
            <option value={currentRole} disabled>
              {role || currentRole}
            </option>
          )}
          {options.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      ) : (
        role && <span className="text-xs text-muted-foreground">{role}</span>
      )}
      {pending && (
        <span className="text-xs italic text-muted-foreground">
          <Trans>pending</Trans>
        </span>
      )}
      {manage && actions && principalId && !isSelf && options.length > 0 && (
        <button
          type="button"
          data-testid="member-remove"
          aria-label={t`Remove member`}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          disabled={busy}
          onClick={() => void run(() => actions.onRemove(principalId))}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X size={14} />}
        </button>
      )}
    </li>
  );
}

export function MemberSection({
  title,
  members,
  ready,
  updating,
  stale,
  selfId,
  me,
  manage,
  actions,
  footer,
}: {
  title?: string;
  members: EntityMember[];
  ready: boolean;
  /** Refresh in flight over the shown cache → "updating…". */
  updating?: boolean;
  /** Signed in but the refresh failed → "can't update — showing last synced". */
  stale?: boolean;
  selfId: string;
  me?: EntityMember | null;
  manage?: boolean;
  actions?: MemberActions;
  /** Invite control, rendered by the caller so each surface picks its own. */
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {title && (
        <div className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
          <span>{title}</span>
          {updating && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
      )}
      {!ready && members.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          <Trans>Loading members…</Trans>
        </div>
      ) : members.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          <Trans>No members yet.</Trans>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((m, i) => (
            <MemberRow
              key={memberPrincipalId(m) ?? m.email ?? i}
              member={m}
              isSelf={m.user_id === selfId}
              me={me}
              manage={manage}
              actions={actions}
            />
          ))}
        </ul>
      )}
      {stale && (
        <div className="text-[11px] text-muted-foreground">
          <Trans>Can't update — showing last synced</Trans>
        </div>
      )}
      {/* Mutations are hidden while offline (stale) — they would only 409. */}
      {!stale && footer}
    </div>
  );
}

export type { EntityMember, TypeId };
