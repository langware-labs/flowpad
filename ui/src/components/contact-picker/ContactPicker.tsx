import { ConversationParticipant, QueryRequest, User } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { Input } from '@src/components/ui/input';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
}: ContactPickerProps) {
  const [filterText, setFilterText] = useState('');

  const usersRequest = useMemo(() => new QueryRequest({ type: User.type }), []);
  const { data: allUsers = [] } = useEntitiesQuery<User>(usersRequest, { enabled });

  const contacts = useMemo(
    () => allUsers.filter((u) => !excludeUserId || u.id !== excludeUserId),
    [allUsers, excludeUserId],
  );

  const filteredContacts = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (u) =>
        (u.name ?? '').toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q),
    );
  }, [contacts, filterText]);

  const isFull = typeof max === 'number' && value.length >= max;

  const alreadyAdded = (email: string) =>
    value.some((p) => p.email.toLowerCase() === email.toLowerCase());

  const addContact = (u: User) => {
    if (!u.email || alreadyAdded(u.email) || isFull) return;
    onChange([...value, { user_id: u.id, email: u.email!, name: u.name ?? null }]);
    setFilterText('');
  };

  const addFreeFormEmail = () => {
    const v = filterText.trim();
    if (!v || !EMAIL_RE.test(v) || alreadyAdded(v) || isFull) return;
    onChange([...value, { email: v, name: null }]);
    setFilterText('');
  };

  const removeParticipant = (email: string) => {
    onChange(value.filter((p) => p.email !== email));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span
              key={p.email}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
            >
              {p.name || p.email}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => removeParticipant(p.email)}
                aria-label={`Remove ${p.email}`}
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
          onKeyDown={(e) => {
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

      {!isFull && filterText.trim() && filteredContacts.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border">
          {filteredContacts.slice(0, 8).map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              onClick={() => addContact(u)}
              disabled={!u.email || alreadyAdded(u.email) || disabled}
            >
              <span className="truncate">{u.name || u.email}</span>
              {u.name && u.email && (
                <span className="truncate text-xs text-muted-foreground">{u.email}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {!isFull &&
        filterText.trim() &&
        filteredContacts.length === 0 &&
        EMAIL_RE.test(filterText.trim()) &&
        !alreadyAdded(filterText.trim()) && (
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
