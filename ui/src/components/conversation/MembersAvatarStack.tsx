import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Link as LinkIcon, Loader2, UserPlus, X } from 'lucide-react';
import { mintInviteLink, type ConversationParticipant, type TypeId } from '@sdk';
import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useMembers } from '@src/hooks/use-members';
import { useLoginRequired } from '@src/hooks/use-login-required';
import LoginDialog, { ActionType } from '@src/components/login-required-dialog';
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
  /** Offer "Generate link & copy" alongside the email invite. Off by default:
   *  a link is a standing self-invite, so each surface opts in deliberately
   *  (today the project MEMBERS row). */
  allowInviteLink?: boolean;
  /** Show a visible invite trigger beside the member avatars. */
  showInviteButton?: boolean;
  /** Optional entity-specific prerequisite. Returning false keeps both invite
   *  paths closed; project sharing uses this for its GitHub capability test. */
  beforeInvite?: () => Promise<boolean>;
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
export function MembersAvatarStack({
  typeId,
  allowInviteLink = false,
  showInviteButton = false,
  beforeInvite,
}: MembersAvatarStackProps) {
  const { t } = useLingui();
  const { entity, members, addMembers, removeMember, setRole, refresh, updating, stale, available, reason } =
    useMembers(typeId);
  const { localUser } = useLocalUser();
  const { checkLoginAndProceed, showLoginDialog, closeLoginDialog } = useLoginRequired();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ConversationParticipant[]>([]);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
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

  /**
   * Mint a shareable invite link and put it on the clipboard.
   *
   * The URL is returned exactly once — the hub stores only a hash of the token
   * — so it goes straight to the clipboard and is never rendered. There is
   * deliberately no "show link": anyone who can open this popover could
   * otherwise redeem it to raise their own role.
   *
   * An unshared project has no hub row to hang the link off (reflection needs
   * ``remote``), so publish it first — the same first-share step the email
   * invite above takes, which makes the sharer its owner.
   */
  const handleGenerateLink = async () => {
    if (!entity) return;
    setLinking(true);
    setLinkError(null);
    try {
      if (beforeInvite && !(await beforeInvite())) return;
      if (!(entity as { remote?: boolean }).remote) await entity.share();
      const link = await mintInviteLink(typeId);
      await navigator.clipboard.writeText(link.url);
      setLinkCopied(true);
      await refresh(); // the first share seeds the roster with me as owner
    } catch (err) {
      // The hub's own message is the useful one here (e.g. the grant ceiling's
      // "Cannot mint a link at role '<role>'").
      setLinkError(err instanceof Error ? err.message : t`Could not generate a link`);
    } finally {
      setLinking(false);
    }
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
      if (beforeInvite && !(await beforeInvite())) return;
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

  // Membership is hub-driven: with no hub, clicking either opens the sign-in
  // popup (not authenticated) or, in Local mode, opens the popover to a short
  // "unavailable" notice. Offline-but-authenticated is NOT gated here — it shows
  // the cached roster + a "can't update" note (the ``stale`` flag below).
  const handleOpenChange = (next: boolean) => {
    if (next && reason === 'unauthenticated') {
      // Route through the shared sign-in dialog; don't open the roster popover.
      checkLoginAndProceed(ActionType.MEMBERS, t`Sign in to see who's a member`, undefined, {
        forceLogin: true,
      });
      return;
    }
    setOpen(next);
    if (!next) {
      // Reset transient state so reopening the popover doesn't show a stale
      // selection or error from a previous attempt.
      setSelected([]);
      setInviteError(null);
      setInviting(false);
      setLinkError(null);
      setLinkCopied(false);
    }
  };

  return (
    <>
    <div className="flex items-center gap-2">
      {showInviteButton && (
        <button
          type="button"
          onClick={() => handleOpenChange(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-xs font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1"
          aria-label={t`Invite members`}
          data-testid="members-invite-button"
        >
          <UserPlus className="h-3.5 w-3.5" />
          <Trans>Invite</Trans>
        </button>
      )}
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
        {reason === 'local' ? (
          <div className="px-1 py-2 text-[11px] text-muted-foreground" data-testid="members-local-notice">
            <Trans>Members are unavailable in Local mode.</Trans>
          </div>
        ) : (
          <>
        {/* Stale-while-revalidate status: "updating…" during a refresh over the
            shown cache; "can't update" when signed in but the hub is unreachable. */}
        {(updating || stale) && (
          <div
            className="mb-1 flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground"
            data-testid="members-refresh-status"
          >
            {updating ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <Trans>Updating…</Trans>
              </>
            ) : (
              <Trans>Can't update — showing last synced</Trans>
            )}
          </div>
        )}
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
            mutating ``members`` action; a plain member's POST would 403).
            Also requires an available hub; hidden when stale/offline so an
            invite can't be attempted only to 409. */}
        {mayInvite && available && !stale && (
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
          {allowInviteLink && (
            <div className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                onClick={() => void handleGenerateLink()}
                disabled={linking}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-border bg-muted px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent disabled:opacity-50"
                data-testid="members-invite-link"
              >
                {linkCopied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
                {linking ? t`Generating…` : linkCopied ? t`Link copied` : t`Generate link & copy`}
              </button>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {linkCopied
                  ? t`Anyone with the link can join as a member. It's on your clipboard — it can't be shown again.`
                  : t`Creates a link anyone can use to join as a member.`}
              </p>
              {linkError && (
                <div className="mt-1 text-[10px] text-destructive" role="alert">
                  {linkError}
                </div>
              )}
            </div>
          )}
        </div>
        )}
          </>
        )}
      </PopoverContent>
    </Popover>
    </div>
    {permissionsContact && (
      <ContactPermissionsDialog
        open
        onClose={() => setPermissionsContact(null)}
        contact={permissionsContact}
      />
    )}
    {/* Sign-in popup for the unauthenticated case (handleOpenChange routes here
        instead of opening the roster). */}
    <LoginDialog open={showLoginDialog} onOpenChange={closeLoginDialog} />
    </>
  );
}
