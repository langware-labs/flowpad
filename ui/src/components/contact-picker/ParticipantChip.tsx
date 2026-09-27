import { Team, type ConversationParticipant } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { X } from 'lucide-react';
import { isTeamParticipant, teamTypeIdOf } from './use-team-suggestions';

/**
 * One picked recipient as a removable chip. A team is ONE chip (its type icon,
 * testid `contact-team-chip-<id>`) — never its members.
 *
 * Shared by the ContactPicker and the members popover's add-member form.
 */
export function ParticipantChip({
  participant,
  onRemove,
  disabled,
}: {
  participant: ConversationParticipant;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const team = isTeamParticipant(participant);
  const TeamIcon = iconForType(Team.type);
  const label = participant.name || participant.email || 'unknown';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
      data-testid={team ? `contact-team-chip-${teamTypeIdOf(participant)?.id ?? ''}` : undefined}
    >
      {team && <TeamIcon className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
      {label}
      <button
        type="button"
        className="rounded-full p-0.5 hover:bg-muted-foreground/20"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        disabled={disabled}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
