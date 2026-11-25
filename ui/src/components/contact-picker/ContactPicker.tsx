import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ContactDialog } from '@src/components/conversation/ContactDialog';
import { useOrgRoute } from '@src/components/organization/tabs/org-route';
import { ContactsGroup, ConversationParticipant, normalizeEmail, Team, User } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Input } from '@src/components/ui/input';
import { Separator } from '@src/components/ui/separator';
import { Bot, UsersRound, X, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EMAIL_RE, filterContacts, participantFromContact, participantKey, useContacts } from './use-contacts';
import { filterGroups, mergeGroupMembers, useContactsGroups } from './use-contacts-groups';
import { useRecentContacts } from './use-recent-contacts';
import { filterTeams, useMessageableTeams, type MessageableTeam } from './use-team-suggestions';
import { agentParticipant, filterAgents, useAgentSuggestions, type AgentSuggestion } from './use-agent-suggestions';
import { participantSubtitle, personName } from '@src/components/conversation/participant-display';

interface ContactPickerProps {
  /** Currently selected contacts as ConversationParticipant entries. */
  value: ConversationParticipant[];
  onChange: (next: ConversationParticipant[]) => void;
  /** Hide this user id from the typeahead (typically the local user). */
  excludeUserId?: string | null;
  /** Cap on how many contacts can be selected. Omit for unlimited. */
  max?: number;
  disabled?: boolean;
  enabled?: boolean;
  placeholder?: string;
  testId?: string;
  /** Offer contacts GROUPS in the dropdown (default on). Selecting a group
   *  bulk-adds its members as individual chips (deduped) — groups never
   *  become chips themselves. The group-create dialog turns this off. */
  includeGroups?: boolean;
  /** Offer the user's hub TEAMS in the dropdown (default off) — only those whose
   *  roster the user may read. Selecting one adds every member as an individual
   *  chip (deduped); like a group, the team itself is never a chip. */
  includeTeams?: boolean;
  /** Offer the agents the user may add to a conversation (default off). Unlike a team, a picked
   *  agent IS a chip: the hub adds it as one member. */
  includeAgents?: boolean;
}

/**
 * Typeahead picker for ConversationParticipant: searches existing User entities
 * (the contact list) by name/email, accepts a free-form email if no match, and
 * surfaces selections as removable chips.
 *
 * Used by NewConversationDialog (multi-select) and SendPlanNotificationDialog
 * (single-select via `max={1}`). Keeps the contact-picker UX consistent
 * everywhere it's offered.
 */
export function ContactPicker({
  value,
  onChange,
  excludeUserId,
  max,
  disabled,
  enabled = true,
  placeholder = 'Search by name or email — Enter to add',
  testId = 'contact-input',
  includeGroups = true,
  includeTeams = false,
  includeAgents = false,
}: ContactPickerProps) {
  const [filterText, setFilterText] = useState('');
  const typedEmail = filterText.trim();
  const [listOpen, setListOpen] = useState(false);
  const { t } = useLingui();
  const { openTeam } = useOrgRoute();
  // The contact whose detail dialog is open from a row's open icon (null = closed).
  const [detailFor, setDetailFor] = useState<User | null>(null);
  const PersonIcon = iconForType(User.type);

  const { contacts } = useContacts(excludeUserId, enabled);
  const recent = useRecentContacts(contacts, enabled);
  const { groups } = useContactsGroups(enabled && includeGroups);
  const { teams } = useMessageableTeams(enabled && includeTeams, excludeUserId);
  const TeamIcon = iconForType(Team.type);
  const { agents } = useAgentSuggestions(enabled && includeAgents);

  const filteredContacts = useMemo(() => filterContacts(contacts, filterText), [contacts, filterText]);
  const filteredGroups = useMemo(
    () => (includeGroups ? filterGroups(groups, filterText) : []),
    [includeGroups, groups, filterText],
  );

  const filteredTeams = useMemo(() => filterTeams(teams, filterText), [teams, filterText]);
  const filteredAgents = useMemo(() => filterAgents(agents, filterText), [agents, filterText]);

  const isFull = typeof max === 'number' && value.length >= max;

  const alreadyAdded = (participant: ConversationParticipant) => {
    const key = participantKey(participant);
    return !!key && value.some((p) => participantKey(p) === key);
  };

  const addContact = (u: User) => {
    const participant = participantFromContact(u);
    if ((!participant.user_id && !participant.email) || alreadyAdded(participant) || isFull) return;
    onChange([...value, participant]);
    setFilterText('');
    setListOpen(false);
  };

  const addFreeFormEmail = () => {
    const v = normalizeEmail(filterText) || '';
    if (!v || !EMAIL_RE.test(v) || alreadyAdded({ email: v }) || isFull) return;
    onChange([...value, { email: v, name: null }]);
    setFilterText('');
    setListOpen(false);
  };

  // Bulk-add a group's members (deduped, self excluded); the group itself is
  // never a chip.
  const addGroup = (group: ContactsGroup) => {
    if (isFull) return;
    const next = mergeGroupMembers(value, group.contacts ?? [], excludeUserId);
    const capped = typeof max === 'number' ? next.slice(0, max) : next;
    if (capped.length === value.length) return;
    onChange(capped);
    setFilterText('');
    setListOpen(false);
  };

  // A team adds its members (deduped, self excluded); the team itself is never
  // a chip, so the conversation is sent to each member individually.
  const addTeam = (team: MessageableTeam) => {
    if (isFull) return;
    const next = mergeGroupMembers(value, team.members, excludeUserId);
    const capped = typeof max === 'number' ? next.slice(0, max) : next;
    if (capped.length === value.length) return;
    onChange(capped);
    setFilterText('');
    setListOpen(false);
  };

  const addAgent = (agent: AgentSuggestion) => {
    const participant = agentParticipant(agent);
    if (alreadyAdded(participant) || isFull) return;
    onChange([...value, participant]);
    setFilterText('');
    setListOpen(false);
  };

  const trimmed = filterText.trim();
  const showList = !isFull && (trimmed.length > 0 || listOpen);
  const listSource = trimmed.length > 0 ? filteredContacts : contacts;
  // The open, unfiltered list starts with the people last talked to, then a line, then everyone else.
  const recentRows = trimmed ? [] : recent;
  const otherContacts = useMemo(
    () => (trimmed || !recent.length ? listSource : listSource.filter((u) => !recent.includes(u))),
    [listSource, recent, trimmed],
  );
  const visibleContacts = listOpen && !trimmed ? otherContacts : otherContacts.slice(0, 8);
  const groupSource = trimmed.length > 0 ? filteredGroups : groups;
  const visibleGroups = listOpen && !trimmed ? groupSource : groupSource.slice(0, 4);
  const visibleTeams = listOpen && !trimmed ? filteredTeams : filteredTeams.slice(0, 4);
  const visibleAgents = listOpen && !trimmed ? filteredAgents : filteredAgents.slice(0, 4);

  const removeParticipant = (participant: ConversationParticipant) => {
    const key = participantKey(participant);
    onChange(value.filter((p) => participantKey(p) !== key));
  };

  const contactRow = (u: User) => (
    <div key={u.id} className="flex items-center hover:bg-muted">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-start text-sm disabled:opacity-50"
        onClick={() => addContact(u)}
        disabled={alreadyAdded(participantFromContact(u)) || disabled}
      >
        <span className="truncate">{personName(u)}</span>
        {participantSubtitle(u) && (
          <span className="truncate text-xs text-muted-foreground">{participantSubtitle(u)}</span>
        )}
      </button>
      <OpenButton
        Icon={PersonIcon}
        title={t`View contact details`}
        onClick={() => setDetailFor(u)}
        testId={`contact-open-${u.id}`}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span
              key={participantKey(p)}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
            >
              {personName(p)}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => removeParticipant(p)}
                aria-label={`Remove ${personName(p)}`}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {!isFull && (
        <Input
          placeholder={placeholder}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onDoubleClick={() => setListOpen(true)}
          onBlur={() => {
            // Moving on from a complete email adds it, as Enter would: the person typed who they
            // meant and went to the next field. A partial name is left for the list.
            if (EMAIL_RE.test(filterText.trim())) addFreeFormEmail();
            setTimeout(() => setListOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setListOpen(false);
              return;
            }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (filteredContacts.length === 1) {
              addContact(filteredContacts[0]);
            } else if (EMAIL_RE.test(filterText.trim())) {
              addFreeFormEmail();
            }
          }}
          disabled={disabled}
          data-testid={testId}
        />
      )}

      {showList &&
        (recentRows.length > 0 ||
          visibleContacts.length > 0 ||
          visibleGroups.length > 0 ||
          visibleTeams.length > 0 ||
          visibleAgents.length > 0) && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border">
          {/* Groups first — one click adds every member. */}
          {visibleGroups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => addGroup(g)}
              disabled={disabled}
              data-testid={`contact-group-option-${g.id}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <UsersRound className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{g.displayName}</span>
                {g.computed && (
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground/70">
                    <Trans>auto</Trans>
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <Plural value={(g.contacts ?? []).length} one="# member" other="# members" />
              </span>
            </button>
          ))}
          {/* Teams — one click adds every member of the team. */}
          {visibleTeams.map((team) => (
            <div key={team.id} className="flex items-center hover:bg-muted">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-start text-sm disabled:opacity-50"
                onClick={() => addTeam(team)}
                disabled={disabled}
                data-testid={`contact-team-option-${team.id}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <TeamIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  <span className="truncate">{team.name}</span>
                </span>
                <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                  <Trans>Team</Trans>
                </span>
              </button>
              <OpenButton
                Icon={TeamIcon}
                title={t`Open team`}
                onClick={() => openTeam(team.id)}
                testId={`contact-team-open-${team.id}`}
              />
            </div>
          ))}
          {/* Agents — one click adds the agent as a member. */}
          {visibleAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-start text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => addAgent(agent)}
              disabled={alreadyAdded(agentParticipant(agent)) || disabled}
              data-testid={`contact-agent-option-${agent.id}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Bot className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{agent.name}</span>
              </span>
              <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
                <Trans>Agent</Trans>
              </span>
            </button>
          ))}
          {recentRows.map(contactRow)}
          {recentRows.length > 0 && visibleContacts.length > 0 && (
            <Separator data-testid="contact-recent-divider" />
          )}
          {visibleContacts.map(contactRow)}
        </div>
      )}

      {!isFull &&
        filterText.trim() &&
        filteredContacts.length === 0 &&
        EMAIL_RE.test(filterText.trim()) &&
        !alreadyAdded({ email: filterText.trim() }) && (
          <button
            type="button"
            className="rounded-md border border-dashed border-border px-2 py-1.5 text-start text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            onClick={addFreeFormEmail}
            disabled={disabled}
          >
            <Trans>
              Add <span className="font-medium text-foreground">{typedEmail}</span>
            </Trans>
          </button>
        )}
      {detailFor && <ContactDialog open onClose={() => setDetailFor(null)} user={detailFor} />}
    </div>
  );
}

/** A row's trailing open icon — the row's type glyph; opens the entity instead of adding it. */
function OpenButton({
  Icon,
  title,
  onClick,
  testId,
}: {
  Icon: LucideIcon;
  title: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
      onClick={onClick}
      title={title}
      aria-label={title}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
