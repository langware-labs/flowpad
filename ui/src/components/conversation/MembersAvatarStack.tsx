import { useState } from 'react';
import { Users } from 'lucide-react';
import { type TypeId } from '@sdk';
import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useMembers } from '@src/hooks/use-members';
import {
  participantInitials,
  participantLabel,
  participantRoleLabel,
} from './participant-display';

const MAX_INLINE_AVATARS = 4;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const { members, addMember } = useMembers(typeId);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const handleInvite = async () => {
    const candidate = email.trim();
    if (!EMAIL_RE.test(candidate)) {
      setInviteError('Enter a valid email');
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      await addMember(candidate);
      setEmail('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Invite failed');
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
      // error from a previous attempt.
      setEmail('');
      setInviteError(null);
      setInviting(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center -space-x-2"
          aria-label={members.length === 0 ? 'Add members' : `${members.length} members`}
          data-testid="members-avatar-stack"
        >
          {members.length === 0 ? (
            <Avatar className="h-6 w-6 ring-2 ring-background">
              <AvatarFallback className="text-[10px]">
                <Users className="h-3 w-3" />
              </AvatarFallback>
            </Avatar>
          ) : (
            inline.map((p, i) => (
              <Avatar key={p.user_id || p.email || i} className="h-6 w-6 ring-2 ring-background">
                <AvatarFallback className="text-[10px]">
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
      <PopoverContent className="w-64 p-2" align="start">
        {members.length === 0 && (
          <div className="px-1 py-1 text-[11px] text-muted-foreground">
            No members yet — invite someone below.
          </div>
        )}
        <ul className="flex flex-col gap-1.5">
          {members.map((p, i) => {
            const role = participantRoleLabel(p);
            return (
              <li
                key={p.user_id || p.email || i}
                className="flex items-center gap-2 text-xs"
              >
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-[10px]">
                    {participantInitials(p)}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{participantLabel(p)}</span>
                {role && (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {role}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-2 border-t border-border pt-2">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void handleInvite();
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (inviteError) setInviteError(null);
              }}
              placeholder="Invite by email…"
              className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-primary"
              disabled={inviting}
              data-testid="members-invite-input"
            />
            <button
              type="submit"
              disabled={inviting || !email.trim()}
              className="rounded border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent disabled:opacity-50"
              data-testid="members-invite-submit"
            >
              {inviting ? 'Inviting…' : '+ Add'}
            </button>
          </form>
          {inviteError && (
            <div className="mt-1 text-[10px] text-destructive" role="alert">
              {inviteError}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
