import { useMemo, useState } from 'react';
import { BookUser } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ConversationParticipant, type User } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ContactDialog } from '@src/components/conversation/ContactDialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@src/components/ui/dialog';
import { ContactRows, ContactsTitle } from './ContactRows';
import { filterContacts, participantFromContact, participantKey, useContacts } from './use-contacts';

interface AddressBookButtonProps {
  /** Currently selected contacts (shared with the sibling ContactPicker). */
  value: ConversationParticipant[];
  onChange: (next: ConversationParticipant[]) => void;
  /** Hide this user id (typically the local user) from the list. */
  excludeUserId?: string | null;
  /** Gate the underlying User query (mirrors ContactPicker's `enabled`). */
  enabled?: boolean;
  disabled?: boolean;
  testId?: string;
}

/**
 * Generic address-book affordance: an icon button that opens a modal with a
 * checkbox multi-select of all known contacts. Selections write into the SAME
 * `value` array a ContactPicker manages (keyed by `participantKey`), so it can
 * sit next to any recipient input — share screen, NewConversationDialog, etc.
 * Reuses `useContacts` so the listed people match the typeahead exactly.
 */
export function AddressBookButton({
  value,
  onChange,
  excludeUserId,
  enabled = true,
  disabled,
  testId = 'address-book-button',
}: AddressBookButtonProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The contact whose detail dialog is open (null = closed).
  const [detailFor, setDetailFor] = useState<User | null>(null);
  const { contacts, refetch } = useContacts(excludeUserId, enabled && open);

  const filtered = useMemo(() => filterContacts(contacts, query), [contacts, query]);

  const selectedKeys = useMemo(() => new Set(value.map(participantKey).filter(Boolean)), [value]);

  const toggle = (u: User) => {
    const participant = participantFromContact(u);
    const key = participantKey(participant);
    if (!key) return;
    if (selectedKeys.has(key)) {
      onChange(value.filter((p) => participantKey(p) !== key));
    } else {
      onChange([...value, participant]);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={t`Open address book`}
        title={t`Address book`}
        data-testid={testId}
      >
        <BookUser className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" data-testid={`${testId}-modal`}>
          <DialogHeader>
            <ContactsTitle refetch={refetch} testId={testId} />
          </DialogHeader>

          <Input
            placeholder={t`Search by name or email`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid={`${testId}-search`}
          />

          <ContactRows
            contacts={filtered}
            testId={testId}
            onOpen={setDetailFor}
            selection={{ keys: selectedKeys, onToggle: toggle }}
          />

          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {detailFor && <ContactDialog open onClose={() => setDetailFor(null)} user={detailFor} />}
    </>
  );
}
