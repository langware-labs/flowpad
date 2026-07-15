import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { X } from 'lucide-react';
import { type ConversationParticipant, type TypeId } from '@sdk';
import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useMembers } from '@src/hooks/use-members';
import { ContactPicker } from '@src/components/contact-picker/ContactPicker';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import { useLocalUser } from './useLocalUser';
import { avatarColorForParticipant } from './avatar-color';
import { ContactPermissionsDialog } from './ContactPermissionsDialog';
import {
  assignableRoles,
  canInviteMembers,
  contactFromParticipant,
  participantInitials,
  participantIsUser,
  participantLabel,
  participantRank,
  participantRoleLabel,
  type ContactIdentity,
} from './participant-display';

const MAX_INLINE_AVATARS = 4;

interface MembersAvatarStackProps {
  typeId: TypeId;
}

/**
 * Generic avatar stack + roster popover for any entity's member list.
 *
 * Renders up to ``MAX_INLINE_AVATARS`` overlapping avatars; remaining
 * participants surface as ``+K``. Clicking the stack opens a popover with
 * the full ``{name, role}`` roster.
 *
 * The hook (``useMembers``) handles the local-cache-first + on-mount refresh
 * pattern; this component is purely presentational.
 */
export function MembersAvatarStack({ typeId }: MembersAvatarStackProps) {
  const { t } = useLingui();
  const { members, addMembers, removeMember, setRole } = useMembers(typeId);
  const { localUser } = useLocalUser();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ConversationParticipant[]>([]);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [permissionsContact, setPermissionsContact] = useState<ContactIdentity | null>(null);

  // My roster row drives every affordance gate: rank for the role selector
  // (mirrors the hub's ``can_assign`` ceiling), owner for remove, admin+ for
  // invite. The hub enforces all of these too — hiding here just keeps the UI
  // from offering controls that would 403.
  const me = members.find((m) => !!m.user_id && !!localUser?.id && m.user_id === localUser.id) ?? null;
  const iAmOwner = participantRank(me) === 0;
  // Invite gate applies only when my roster row resolved. A local-only /
  // not-yet-shared conversation has an empty roster (no ``me``) — keep the
  // form there, since this popover is also the first-share entry point and
  // the sharer becomes the owner.
  const mayInvite = me === null ? true : canInviteMembers(me);

  const handleRemove = async (userId: string) => {
    setRemovingId(userId);
    try {
      await removeMember(userId);
    } catch {
      // Hub rejects non-owner/owner-self with 403; the control is already
      // owner-gated, so a failure here is a transient/again-case — leave the
      // row as-is rather than surfacing a modal in this compact popover.
    } finally {
      setRemovingId(null);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    setChangingId(userId);
    try {
      await setRole(userId, role);
    } catch {
      // The selector is already ceiling-gated, so a hub denial here is a
      // stale-roster/transient case; the post-change refresh in setRole didn't
      // run, so the row simply keeps showing the hub-authoritative role.
    } finally {
      setChangingId(null);
    }
  };

  // Existing members keyed by email so a staged contact who's already on the
  // roster is dropped before invite (the hub would 400 "use change_role" on a
  // re-invite, which would fail the whole batch share).
  const existingEmails = useMemo(
    () => new Set(members.map((m) => (m.email ?? '').trim().toLowerCase()).filter(Boolean)),
    [members],
  );

  const handleSelectionChange = (next: ConversationParticipant[]) => {
    setSelected(next);
    if (inviteError) setInviteError(null);
  };

  const handleInvite = async () => {
    const emails = selected
      .map((p) => (p.email ?? '').trim().toLowerCase())
      .filter((e) => !!e && !existingEmails.has(e));
    if (!emails.length) {
      setInviteError(t`Pick a contact or enter an email`);
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await addMembers(emails);
      setSelected([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invite failed';
      // Re-inviting an accepted member is hub-rejected (400 "use change_role")
      // — point at the roster's role selector instead of echoing the raw error.
      setInviteError(/change_role/i.test(message)
        ? t`Already a member — change their role in the list above`
        : message);
    } finally {
      setInviting(false);
    }
  };

  const inline = members.slice(0, MAX_INLINE_AVATARS);
  const overflow = members.length - inline.length;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Reset transient state so reopening the popover doesn't show a stale
      // selection or error from a previous attempt.
      setSelected([]);
      setInviteError(null);
      setInviting(false);
    }
  };

  return (
    <>
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center -space-x-2"
          aria-label={members.length === 0 ? 'Add members' : `${members.length} members`}
          data-testid="members-avatar-stack"
        >
          {members.length === 0 ? (
            // An empty roster says so in words — a lone avatar glyph reads as
            // "someone is here" when the point is that nobody is.
            <span className="text-xs text-muted-foreground">
              <Trans>No members</Trans>
            </span>
          ) : (
            inline.map((p, i) => (
              <Avatar key={p.user_id || p.email || i} className="h-6 w-6 ring-2 ring-background">
                <AvatarFallback
                  className={`text-[10px] text-white ${avatarColorForParticipant(p, participantIsUser(p, localUser))}`}
                >
                  {participantInitials(p)}
                </AvatarFallback>
              </Avatar>
            ))
          )}
          {overflow > 0 && (
            <Avatar className="h-6 w-6 ring-2 ring-background">
              <AvatarFallback className="text-[10px]">+{overflow}</AvatarFallback>
            </Avatar>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        {members.length === 0 && (
          <div className="px-1 py-1 text-[11px] text-muted-foreground">
            <Trans>No members yet — invite someone below.</Trans>
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {members.map((p, i) => {
            const role = participantRoleLabel(p);
            // Role selector mirrors the hub ``can_assign`` ceiling: options
            // strictly below my rank, only on members strictly below my rank,
            // never my own row / the owner. Empty = render the static label.
            const roles = assignableRoles(me, p);
            const contact = participantIsUser(p, localUser) ? null : contactFromParticipant(p);
            const identity = (
              <>
                <Avatar className="h-6 w-6">
                  <AvatarFallback
                    className={`text-[10px] text-white ${avatarColorForParticipant(p, participantIsUser(p, localUser))}`}
                  >
                    {participantInitials(p)}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{participantLabel(p)}</span>
              </>
            );
            return (
              <li
                key={p.user_id || p.email || i}
                className="flex items-center gap-2 text-xs"
              >
                {contact ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted"
                    onClick={() => {
                      setPermissionsContact(contact);
                      setOpen(false);
                    }}
                    aria-label={`Open permissions for ${participantLabel(p)}`}
                    data-testid={`member-contact-${p.user_id || p.email || i}`}
                  >
                    {identity}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
                    {identity}
                  </div>
                )}
                {roles.length > 0 ? (
                  <select
                    aria-label={`Change role of ${participantLabel(p)}`}
                    data-testid="member-role-select"
                    value={(p.role ?? '').toLowerCase()}
                    disabled={changingId === p.user_id}
                    onChange={(e) => void handleRoleChange(p.user_id as string, e.target.value)}
                    className="rounded border border-transparent bg-transparent text-[10px] uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:border-border focus:border-primary disabled:opacity-40"
                  >
                    {/* Current role stays selectable when it's outside the
                        offered menu (a rankable-but-not-assignable role like
                        ``guest``, or a comma-joined multi-role value) so the
                        select never shows a blank value. */}
                    {!roles.includes((p.role ?? '').toLowerCase()) && (
                      <option value={(p.role ?? '').toLowerCase()} disabled>
                        {role}
                      </option>
                    )}
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : role && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {role}
                  </span>
                )}
                {/* Remove — owner only, never on the owner's own row. */}
                {iAmOwner
                  && (p.role ?? '').toLowerCase() !== 'owner'
                  && p.user_id
                  && (
                    <button
                      type="button"
                      aria-label={`Remove ${participantLabel(p)}`}
                      data-testid="member-remove"
                      disabled={removingId === p.user_id}
                      onClick={() => void handleRemove(p.user_id as string)}
                      className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
              </li>
            );
          })}
        </ul>
        {/* Invite — admin+/owner only (the hub policy method-scopes the
            mutating ``members`` action; a plain member's POST would 403). */}
        {mayInvite && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <ContactPicker
                value={selected}
                onChange={handleSelectionChange}
                excludeUserId={localUser?.id}
                disabled={inviting}
                placeholder={t`Invite by name or email…`}
                testId="members-invite-input"
              />
            </div>
            <AddressBookButton
              value={selected}
              onChange={handleSelectionChange}
              excludeUserId={localUser?.id}
              disabled={inviting}
              testId="members-address-book"
            />
          </div>
          <div className="mt-1.5 flex justify-end">
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={inviting || selected.length === 0}
              className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent disabled:opacity-50"
              data-testid="members-invite-submit"
            >
              {inviting ? t`Inviting…` : t`+ Add`}
            </button>
          </div>
          {inviteError && (
            <div className="mt-1 text-[10px] text-destructive" role="alert">
              {inviteError}
            </div>
          )}
        </div>
        )}
      </PopoverContent>
    </Popover>
    {permissionsContact && (
      <ContactPermissionsDialog
        open
        onClose={() => setPermissionsContact(null)}
        contact={permissionsContact}
      />
    )}
    </>
  );
}
