import { useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Link as LinkIcon, Loader2, Plus, UserPlus, UsersRound, X } from 'lucide-react';
import {
  mintInviteLink,
  normalizeEmail,
  type ContactsGroup,
  type ConversationParticipant,
  type TypeId,
} from '@sdk';
import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
import { Input } from '@src/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useMembers } from '@src/hooks/use-members';
import { useLoginRequired } from '@src/hooks/use-login-required';
import LoginDialog, { ActionType } from '@src/components/login-required-dialog';
import { AddressBookButton } from '@src/components/contact-picker/AddressBookButton';
import {
  EMAIL_RE,
  filterContacts,
  participantFromContact,
  participantKey,
  useContacts,
} from '@src/components/contact-picker/use-contacts';
import {
  filterGroups,
  mergeGroupMembers,
  useContactsGroups,
} from '@src/components/contact-picker/use-contacts-groups';
import { useLocalUser } from './useLocalUser';
import { avatarColorForParticipant } from './avatar-color';
import { ContactPermissionsDialog } from './ContactPermissionsDialog';
import {
  assignableRoles,
  canInviteMembers,
  contactFromParticipant,
  grantableRoles,
  participantInitials,
  participantIsUser,
  participantLabel,
  participantRank,
  participantRoleLabel,
  type ContactIdentity,
} from './participant-display';

const MAX_INLINE_AVATARS = 4;
const MAX_CONTACT_SUGGESTIONS = 6;
const MAX_GROUP_SUGGESTIONS = 3;

/** What the add row's text resolved to when a suggestion was picked. */
type DraftPick =
  | { kind: 'contact'; participant: ConversationParticipant }
  | { kind: 'group'; group: ContactsGroup };

/** A recipient added to the list but not sent yet — Apply sends the batch. */
interface PendingInvite {
  participant: ConversationParticipant;
  /** Unset on a surface with no ``inviteRoles`` (the entity's default applies). */
  role?: string;
}

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
  /** Roles the invite form may grant, e.g. ``['member', 'admin']`` for a
   *  project. Omitted = no picker, and the entity's own default role applies. */
  inviteRoles?: readonly string[];
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
  inviteRoles,
}: MembersAvatarStackProps) {
  const { t } = useLingui();
  const { entity, members, addMembers, removeMember, setRole, refresh, updating, stale, available, reason } =
    useMembers(typeId);
  const { localUser } = useLocalUser();
  const { checkLoginAndProceed, showLoginDialog, closeLoginDialog } = useLoginRequired();
  const [open, setOpen] = useState(false);
  // The add row's draft: the typed text, plus the suggestion it resolved to
  // when one was picked from the dropdown (dropped as soon as the text changes).
  const [draft, setDraft] = useState('');
  const [draftPick, setDraftPick] = useState<DraftPick | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  // Added recipients, each with the role it will be granted. Nothing reaches
  // the backend until Apply sends the whole list as one batch.
  const [pending, setPending] = useState<PendingInvite[]>([]);
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
  // Invite roles capped by my rank (the hub refuses a grant at or above it).
  // No roster row yet = first share, which makes me the owner: offer them all.
  const offeredRoles = useMemo(() => {
    if (!inviteRoles?.length) return [];
    if (me === null) return [...inviteRoles];
    const grantable = grantableRoles(me);
    return inviteRoles.filter((r) => grantable.includes(r));
  }, [inviteRoles, me]);
  // The role selector on the add row — defaults to ``member``. Whatever it
  // shows when Add is clicked is the role that recipient joins the list with;
  // each listed row can still be changed individually (a project invite is one
  // ``MembershipRequest`` per person, and each may carry a different role).
  const [inviteRole, setInviteRole] = useState('member');
  const effectiveInviteRole: string | undefined = offeredRoles.includes(inviteRole) ? inviteRole : offeredRoles[0];
  // A listed row's role, re-checked against the offer (it can shrink when the
  // roster refreshes my rank) so Apply never sends a grant the hub would 403.
  const roleOf = (invite: PendingInvite) =>
    invite.role && offeredRoles.includes(invite.role) ? invite.role : effectiveInviteRole;

  // Contacts + groups feed the add row's suggestions — only queried while the
  // form is actually on screen (every conversation header renders this stack).
  const formOpen = open && mayInvite && available && !stale;
  const { contacts } = useContacts(localUser?.id, formOpen);
  const { groups } = useContactsGroups(formOpen);
  const draftText = draft.trim();
  const suggestedGroups = useMemo(
    () => (draftText ? filterGroups(groups, draftText).slice(0, MAX_GROUP_SUGGESTIONS) : []),
    [groups, draftText],
  );
  const suggestedContacts = useMemo(
    () => (draftText ? filterContacts(contacts, draftText).slice(0, MAX_CONTACT_SUGGESTIONS) : []),
    [contacts, draftText],
  );
  const showSuggestions =
    suggestOpen && !draftPick && (suggestedGroups.length > 0 || suggestedContacts.length > 0);

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

  // Existing members keyed by email/user_id so a staged contact who's already
  // on the roster is dropped before invite (the hub would 400 "use
  // change_role" on a re-invite, which would fail the whole batch share).
  const existingEmails = useMemo(
    () => new Set(members.map((m) => (m.email ?? '').trim().toLowerCase()).filter(Boolean)),
    [members],
  );
  const existingUserIds = useMemo(
    () => new Set(members.map((m) => m.user_id).filter((id): id is string => !!id)),
    [members],
  );

  const isMember = (p: ConversationParticipant) => {
    const email = (p.email ?? '').trim().toLowerCase();
    return email ? existingEmails.has(email) : !!p.user_id && existingUserIds.has(p.user_id);
  };
  // Reachable = has an address the hub can invite by, and isn't on the roster.
  const isInvitable = (p: ConversationParticipant) => !!(p.email || p.user_id) && !isMember(p);

  /** Put people on the list at `role`; someone already listed just takes the new role. */
  const addToList = (people: ConversationParticipant[], role: string | undefined) => {
    setPending((prev) => {
      const next = [...prev];
      for (const participant of people) {
        const key = participantKey(participant);
        if (!key) continue;
        const at = next.findIndex((x) => participantKey(x.participant) === key);
        if (at >= 0) next[at] = { ...next[at], role };
        else next.push({ participant, role });
      }
      return next;
    });
  };

  /**
   * What the add row's draft means: the suggestion picked from the dropdown,
   * else the one contact the text names (exact name/email, or the only match),
   * else a free-form email. Returns a message when it names nobody.
   */
  const resolveDraft = (): ConversationParticipant[] | string => {
    if (draftPick?.kind === 'group') return mergeGroupMembers([], draftPick.group.contacts ?? [], localUser?.id);
    if (draftPick) return [draftPick.participant];
    if (!draftText) return t`Type an email or a name`;
    const q = draftText.toLowerCase();
    const matches = filterContacts(contacts, draftText);
    const exact = matches.find((u) => (u.email ?? '').toLowerCase() === q || (u.name ?? '').toLowerCase() === q);
    const contact = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (contact) return [participantFromContact(contact)];
    if (EMAIL_RE.test(draftText)) return [{ email: normalizeEmail(draftText) || q, name: null }];
    return matches.length > 1
      ? t`Several contacts match — pick one from the list`
      : t`No contact by that name — enter a full email`;
  };

  const clearDraft = () => {
    setDraft('');
    setDraftPick(null);
    setSuggestOpen(false);
  };

  const handleAdd = () => {
    const resolved = resolveDraft();
    if (typeof resolved === 'string') {
      setInviteError(resolved);
      return;
    }
    const fresh = resolved.filter(isInvitable);
    if (!fresh.length) {
      setInviteError(t`Already a member — change their role in the list above`);
      return;
    }
    addToList(fresh, effectiveInviteRole);
    clearDraft();
    setInviteError(null);
  };

  const pickSuggestion = (pick: DraftPick, label: string) => {
    setDraftPick(pick);
    setDraft(label);
    setSuggestOpen(false);
    setInviteError(null);
  };

  // The address book is a multi-select over the same list: a newly ticked
  // contact joins at the add row's role, an unticked one leaves the list.
  const handleAddressBookChange = (next: ConversationParticipant[]) => {
    const keep = new Set(next.map(participantKey));
    setPending((prev) => {
      const kept = prev.filter((x) => keep.has(participantKey(x.participant)));
      const listed = new Set(kept.map((x) => participantKey(x.participant)));
      const added = next
        .filter((p) => !listed.has(participantKey(p)) && isInvitable(p))
        .map((participant) => ({ participant, role: effectiveInviteRole }));
      return [...kept, ...added];
    });
    setInviteError(null);
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

  /** Apply — the one step that reaches the backend: every listed recipient, one batch. */
  const handleApply = async () => {
    // Two addressing forms, because the address book knows people two ways —
    // a contact learned from a conversation roster carries a hub ``user_id``
    // and NO email (the hub never discloses another member's email), so an
    // email-only invite makes exactly those contacts unreachable even though
    // the suggestions offer them. Mirrors ``Project.share`` / ``Conversation.share``.
    // One pass over the list: pick the identifier, skip anyone who joined the
    // roster since being listed, attach the row's role — the exact
    // ``{idOrEmail, role?}[]`` shape ``addMembers``/``share`` take.
    const invitable = pending.flatMap((invite) => {
      const p = invite.participant;
      const role = roleOf(invite);
      const email = (p.email ?? '').trim().toLowerCase();
      if (email) return existingEmails.has(email) ? [] : [{ idOrEmail: email, role }];
      const userId = (p.user_id ?? '').trim();
      if (userId) return existingUserIds.has(userId) ? [] : [{ idOrEmail: userId, role }];
      return [];
    });
    if (!invitable.length) {
      setInviteError(
        pending.length > 0 ? t`Already a member — change their role in the list above` : t`Add someone first`,
      );
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      if (beforeInvite && !(await beforeInvite())) return;
      await addMembers(invitable);
      setPending([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invite failed';
      // Re-inviting an accepted member is hub-rejected (400 "use change_role")
      // — point at the roster's role selector instead of echoing the raw error.
      setInviteError(
        /change_role/i.test(message) ? t`Already a member — change their role in the list above` : message,
      );
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
      clearDraft();
      setPending([]);
      setInviteRole('member');
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
          {/* Wider only when the add row grows a role selector (Project) — the
          input/address-book/role/Add row needs the room; a surface with no
          ``inviteRoles`` (Conversation) never renders that control and keeps
          the compact width. */}
          <PopoverContent className={offeredRoles.length > 0 ? 'w-[26rem] p-3' : 'w-80 p-3'} align="start">
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
                      <li key={p.user_id || p.email || i} className="flex items-center gap-2 text-xs">
                        {contact ? (
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-start transition-colors hover:bg-muted"
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
                          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">{identity}</div>
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
                        ) : (
                          role && (
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{role}</span>
                          )
                        )}
                        {/* Remove — owner only, never on the owner's own row. */}
                        {iAmOwner && (p.role ?? '').toLowerCase() !== 'owner' && p.user_id && (
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
                {formOpen && (
                  <div className="mt-3 border-t border-border pt-3" data-testid="members-invite-form">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Trans>Invite people</Trans>
                    </div>
                    {/* The add row: who (typed, or picked from the suggestions /
                    address book) → role → Add. Order doesn't matter — Add
                    reads both at click time. Nothing is sent from here; Add
                    only puts the person on the list below. */}
                    <div className="flex items-center gap-1.5">
                      <div className="relative min-w-0 flex-1">
                        <Input
                          value={draft}
                          onChange={(e) => {
                            setDraft(e.target.value);
                            setDraftPick(null);
                            setSuggestOpen(true);
                            if (inviteError) setInviteError(null);
                          }}
                          onFocus={() => setSuggestOpen(true)}
                          onBlur={() => setSuggestOpen(false)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAdd();
                            } else if (e.key === 'Escape' && showSuggestions) {
                              // Close the suggestions, not the whole popover.
                              e.stopPropagation();
                              setSuggestOpen(false);
                            }
                          }}
                          disabled={inviting}
                          placeholder={t`Email or name`}
                          aria-label={t`Email or name to invite`}
                          className="h-9 text-xs md:text-xs"
                          data-testid="members-invite-input"
                        />
                        {showSuggestions && (
                          <div
                            className="absolute inset-x-0 top-full z-50 mt-1 max-h-52 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
                            data-testid="members-invite-suggestions"
                          >
                            {/* Groups first — adding one lists every member. */}
                            {suggestedGroups.map((g) => (
                              <button
                                key={g.id}
                                type="button"
                                // Keep focus in the input so its blur doesn't
                                // close the list before the click lands.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => pickSuggestion({ kind: 'group', group: g }, g.displayName ?? '')}
                                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-start text-xs hover:bg-muted"
                                data-testid={`members-invite-suggestion-group-${g.id}`}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{g.displayName}</span>
                                </span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {t`${(g.contacts ?? []).length} people`}
                                </span>
                              </button>
                            ))}
                            {suggestedContacts.map((u) => {
                              const participant = participantFromContact(u);
                              return (
                                <button
                                  key={u.id}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() =>
                                    pickSuggestion(
                                      { kind: 'contact', participant },
                                      u.name || u.email || participant.user_id || '',
                                    )
                                  }
                                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-start text-xs hover:bg-muted"
                                  data-testid={`members-invite-suggestion-${u.id}`}
                                >
                                  <Avatar className="h-5 w-5">
                                    <AvatarFallback
                                      className={`text-[9px] text-white ${avatarColorForParticipant(participant, false)}`}
                                    >
                                      {participantInitials(participant)}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="min-w-0 flex-1 truncate">{u.name || u.email || 'unknown'}</span>
                                  {u.name && u.email && (
                                    <span className="max-w-[45%] truncate text-[10px] text-muted-foreground">
                                      {u.email}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <AddressBookButton
                        value={pending.map((x) => x.participant)}
                        onChange={handleAddressBookChange}
                        excludeUserId={localUser?.id}
                        enabled={formOpen}
                        disabled={inviting}
                        testId="members-address-book"
                      />
                      {offeredRoles.length > 0 && (
                        <select
                          aria-label={t`Role`}
                          data-testid="members-invite-role"
                          value={effectiveInviteRole}
                          disabled={inviting}
                          onChange={(e) => setInviteRole(e.target.value)}
                          className="h-9 shrink-0 rounded-md border border-input bg-background px-2 text-xs capitalize text-foreground outline-none transition-colors hover:border-primary/60 focus:border-primary disabled:opacity-40"
                        >
                          {offeredRoles.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={handleAdd}
                        disabled={inviting || (!draftText && !draftPick)}
                        className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                        data-testid="members-invite-add"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <Trans>Add</Trans>
                      </button>
                    </div>
                    {inviteError && (
                      <div className="mt-1.5 text-[11px] text-destructive" role="alert">
                        {inviteError}
                      </div>
                    )}
                    {/* The list Apply sends — one row per recipient with the
                    role they'll be granted, changeable until Apply. A mixed
                    batch (some admin, some member, some addressed by email,
                    some only by hub id) is still one submission. */}
                    {pending.length > 0 && (
                      <ul
                        className="mt-2 flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1"
                        data-testid="members-invite-list"
                      >
                        {pending.map((invite) => {
                          const p = invite.participant;
                          const key = participantKey(p);
                          const label = p.name || p.email || p.user_id || key;
                          return (
                            <li
                              key={key}
                              className="flex items-center gap-2 rounded px-1.5 py-1 text-xs"
                              data-testid={`members-invite-row-${key}`}
                            >
                              <Avatar className="h-5 w-5">
                                <AvatarFallback
                                  className={`text-[9px] text-white ${avatarColorForParticipant(p, false)}`}
                                >
                                  {participantInitials(p)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="min-w-0 flex-1 truncate">
                                {label}
                                {p.name && p.email && (
                                  <span className="ms-1.5 text-[10px] text-muted-foreground">{p.email}</span>
                                )}
                              </span>
                              {offeredRoles.length > 0 && (
                                <select
                                  aria-label={t`Invite ${label} as`}
                                  data-testid={`members-invite-role-${key}`}
                                  value={roleOf(invite)}
                                  disabled={inviting}
                                  onChange={(e) => {
                                    const role = e.target.value;
                                    setPending((prev) =>
                                      prev.map((x) => (participantKey(x.participant) === key ? { ...x, role } : x)),
                                    );
                                  }}
                                  className="h-6 shrink-0 rounded border border-transparent bg-background px-1 text-[11px] capitalize text-muted-foreground outline-none transition-colors hover:border-border focus:border-primary disabled:opacity-40"
                                >
                                  {offeredRoles.map((r) => (
                                    <option key={r} value={r}>
                                      {r}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <button
                                type="button"
                                aria-label={t`Remove ${label} from the list`}
                                disabled={inviting}
                                onClick={() =>
                                  setPending((prev) => prev.filter((x) => participantKey(x.participant) !== key))
                                }
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                                data-testid={`members-invite-remove-${key}`}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {allowInviteLink && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => void handleGenerateLink()}
                          disabled={linking}
                          className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                          data-testid="members-invite-link"
                        >
                          {linkCopied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
                          {linking ? t`Generating…` : linkCopied ? t`Link copied` : t`Or copy an invite link`}
                        </button>
                        <p className="mt-0.5 px-1 text-[10px] text-muted-foreground">
                          {linkCopied
                            ? t`Anyone with the link can join as a member. It's on your clipboard — it can't be shown again.`
                            : t`Creates a link anyone can use to join as a member.`}
                        </p>
                        {linkError && (
                          <div className="mt-1 px-1 text-[10px] text-destructive" role="alert">
                            {linkError}
                          </div>
                        )}
                      </div>
                    )}
                    {/* Apply — the only control that reaches the backend. */}
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                      <span className="text-[11px] text-muted-foreground" data-testid="members-invite-count">
                        {pending.length === 0 ? t`No one added yet` : t`${pending.length} to invite`}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleApply()}
                        disabled={inviting || pending.length === 0}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-4 text-xs font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="members-invite-submit"
                      >
                        {inviting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {inviting ? t`Applying…` : t`Apply`}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {permissionsContact && (
        <ContactPermissionsDialog open onClose={() => setPermissionsContact(null)} contact={permissionsContact} />
      )}
      {/* Sign-in popup for the unauthenticated case (handleOpenChange routes here
        instead of opening the roster). */}
      <LoginDialog open={showLoginDialog} onOpenChange={closeLoginDialog} />
    </>
  );
}
