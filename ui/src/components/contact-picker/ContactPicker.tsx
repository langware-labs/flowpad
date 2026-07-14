import { ContactsGroup, ConversationParticipant, normalizeEmail, User } from '@sdk';
import { Input } from '@src/components/ui/input';
import { UsersRound, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EMAIL_RE, filterContacts, participantFromContact, participantKey, useContacts } from './use-contacts';
import { filterGroups, mergeGroupMembers, useContactsGroups } from './use-contacts-groups';

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
}: ContactPickerProps) {
  const [filterText, setFilterText] = useState('');
  const [listOpen, setListOpen] = useState(false);

  const { contacts } = useContacts(excludeUserId, enabled);
  const { groups } = useContactsGroups(enabled && includeGroups);

  const filteredContacts = useMemo(() => filterContacts(contacts, filterText), [contacts, filterText]);
  const filteredGroups = useMemo(
    () => (includeGroups ? filterGroups(groups, filterText) : []),
    [includeGroups, groups, filterText],
  );

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

  // Bulk-add a group's members (deduped); the group itself is never a chip.
  const addGroup = (group: ContactsGroup) => {
    if (isFull) return;
    const next = mergeGroupMembers(value, group);
    const capped = typeof max === 'number' ? next.slice(0, max) : next;
    if (capped.length === value.length) return;
    onChange(capped);
    setFilterText('');
    setListOpen(false);
  };

  const trimmed = filterText.trim();
  const showList = !isFull && (trimmed.length > 0 || listOpen);
  const listSource = trimmed.length > 0 ? filteredContacts : contacts;
  const visibleContacts = listOpen && !trimmed ? listSource : listSource.slice(0, 8);
  const groupSource = trimmed.length > 0 ? filteredGroups : groups;
  const visibleGroups = listOpen && !trimmed ? groupSource : groupSource.slice(0, 4);

  const removeParticipant = (participant: ConversationParticipant) => {
    const key = participantKey(participant);
    onChange(value.filter((p) => participantKey(p) !== key));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span
              key={participantKey(p)}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
            >
              {p.name || p.email || 'unknown'}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => removeParticipant(p)}
                aria-label={`Remove ${p.name || p.email || 'unknown'}`}
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
          onBlur={() => setTimeout(() => setListOpen(false), 150)}
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

      {showList && (visibleContacts.length > 0 || visibleGroups.length > 0) && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border">
          {/* Groups first — one click adds every member. */}
          {visibleGroups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => addGroup(g)}
              disabled={disabled}
              data-testid={`contact-group-option-${g.id}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <UsersRound className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{g.displayName}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{(g.contacts ?? []).length} members</span>
            </button>
          ))}
          {visibleContacts.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => addContact(u)}
              disabled={alreadyAdded(participantFromContact(u)) || disabled}
            >
              <span className="truncate">{u.name || u.email || 'unknown'}</span>
              {u.name && u.email && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
            </button>
          ))}
        </div>
      )}

      {!isFull &&
        filterText.trim() &&
        filteredContacts.length === 0 &&
        EMAIL_RE.test(filterText.trim()) &&
        !alreadyAdded({ email: filterText.trim() }) && (
          <button
            type="button"
            className="rounded-md border border-dashed border-border px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            onClick={addFreeFormEmail}
            disabled={disabled}
          >
            Add <span className="font-medium text-foreground">{filterText.trim()}</span>
          </button>
        )}
    </div>
  );
}
