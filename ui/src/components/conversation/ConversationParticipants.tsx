import { useState } from 'react';
import { Users } from 'lucide-react';
import { ConversationKind, isHelpdeskKind, type ConversationParticipant } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Avatar, AvatarFallback } from '@src/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import {
  contactFromParticipant,
  participantInitials,
  participantIsUser,
  participantName,
  participantRoleLabel,
  type ContactIdentity,
} from './participant-display';
import { avatarColorForParticipant } from './avatar-color';
import { ContactPermissionsDialog } from './ContactPermissionsDialog';

// Show names inline only when the room allows them AND the roster is small
// enough to fit; otherwise fall back to overlapping initials-avatars.
const NAME_LIMIT = 3;
const MAX_INLINE_AVATARS = 4;

interface ConversationParticipantsProps {
  participants: ConversationParticipant[];
  /**
   * HELPDESK rooms mask responder identity, so names aren't shown — we render
   * circles instead. DIRECT rooms allow names.
   */
  kind?: ConversationKind;
}

/**
 * Read-only participant summary for compact surfaces (e.g. the home Inbox row
 * footer). Renders a short name list when the room allows names and the roster
 * is small, otherwise overlapping initials-avatars. Click opens a popover with
 * the full {name, role} roster. For an EDITABLE roster (invite / role / remove)
 * use MembersAvatarStack instead.
 */
export function ConversationParticipants({ participants, kind }: ConversationParticipantsProps) {
  const [open, setOpen] = useState(false);
  const [permissionsContact, setPermissionsContact] = useState<ContactIdentity | null>(null);
  const { cloudUser, currentUser } = useAuth();

  if (!participants || participants.length === 0) return null;

  // Inline summary shows OTHERS only — not me. (I still appear in the full
  // popover roster below.) "Me" = cloud identity when logged in, else local.
  const me = cloudUser ?? currentUser;
  const others = participants.filter((p) => !participantIsUser(p, me));
  if (others.length === 0) return null;

  const allowNames = !isHelpdeskKind(kind);
  const showNames = allowNames && others.length <= NAME_LIMIT;

  const trigger = showNames ? (
    <span className="truncate">{others.map(participantName).join(', ')}</span>
  ) : (
    <span className="flex items-center -space-x-1.5">
      {others.slice(0, MAX_INLINE_AVATARS).map((p, i) => (
        <Avatar key={p.user_id || p.email || i} className="h-4 w-4 ring-1 ring-background">
          <AvatarFallback className={`text-[7px] text-white ${avatarColorForParticipant(p, false)}`}>
            {participantInitials(p)}
          </AvatarFallback>
        </Avatar>
      ))}
      {others.length > MAX_INLINE_AVATARS && (
        <Avatar className="h-4 w-4 ring-1 ring-background">
          <AvatarFallback className="text-[7px]">+{others.length - MAX_INLINE_AVATARS}</AvatarFallback>
        </Avatar>
      )}
    </span>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            // Stop the click from bubbling to the conversation row (which would
            // navigate). The popover still opens — Radix's own handler runs.
            onClick={(e) => e.stopPropagation()}
            className="flex min-w-0 max-w-[150px] items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`${participants.length} participant${participants.length === 1 ? '' : 's'}`}
            data-testid="conversation-participants"
          >
            <Users className="h-2.5 w-2.5 shrink-0" />
            {trigger}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Participants ({participants.length})
          </div>
          <ul className="flex flex-col gap-1">
            {participants.map((p, i) => {
              const role = participantRoleLabel(p);
              const contact = participantIsUser(p, me) ? null : contactFromParticipant(p);
              const row = (
                <>
                  <Avatar className="h-5 w-5">
                    <AvatarFallback
                      className={`text-[9px] text-white ${avatarColorForParticipant(p, participantIsUser(p, me))}`}
                    >
                      {participantInitials(p)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate">{participantName(p)}</span>
                  {role && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{role}</span>}
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
                      aria-label={`Open permissions for ${participantName(p)}`}
                      data-testid={`conversation-participant-contact-${p.user_id || p.email || i}`}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {permissionsContact && (
        <ContactPermissionsDialog open onClose={() => setPermissionsContact(null)} contact={permissionsContact} />
      )}
    </>
  );
}
