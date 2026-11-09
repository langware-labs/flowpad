import type { ReactNode } from 'react';
import { BookUser, IdCard, Loader2, RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { User } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { DialogTitle } from '@src/components/ui/dialog';
import { participantFromContact, participantKey, useAddressBookScan } from './use-contacts';
import { personName } from '@src/components/conversation/participant-display';

/** The Contacts dialog title, with the address-book scan behind Refresh. */
export function ContactsTitle({ refetch, testId }: { refetch: () => void; testId: string }) {
  const { t } = useLingui();
  const { refreshing, refresh } = useAddressBookScan(refetch);
  return (
    <DialogTitle className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        <BookUser className="h-4 w-4 text-primary" />
        <Trans>Contacts</Trans>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => void refresh()}
        disabled={refreshing}
        data-testid={`${testId}-refresh`}
        title={t`Scan conversations for new contacts`}
      >
        {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        <Trans>Refresh</Trans>
      </Button>
    </DialogTitle>
  );
}

/** The bordered, scrolling list both address-book lists sit in. */
export function ContactListBox({ empty, children }: { empty: ReactNode; children: ReactNode[] }) {
  return (
    <div className="max-h-72 overflow-y-auto rounded-md border border-border">
      {children.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}

interface ContactRowsProps {
  contacts: User[];
  testId: string;
  /** Opens the contact's details. */
  onOpen: (u: User) => void;
  /** Given: each row gets a checkbox (the picker). Left out: rows only open (the manager). */
  selection?: { keys: Set<string>; onToggle: (u: User) => void };
}

/** The address book's person list — shared by the picker and the Contacts manager. */
export function ContactRows({ contacts, testId, onOpen, selection }: ContactRowsProps) {
  const { t } = useLingui();
  return (
    <ContactListBox empty={<Trans>No contacts found.</Trans>}>
      {contacts.map((u) => {
        // Rule 1: a contact known only by hub user_id (no email) still
        // belongs in the book — flag it so it reads as intentional.
        const idOnly = !u.email && !!u.user_id;
        return (
          <div
            key={u.id}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
            data-testid={`${testId}-row-${u.id}`}
          >
            {selection && (
              <Checkbox
                checked={selection.keys.has(participantKey(participantFromContact(u)))}
                onCheckedChange={() => selection.onToggle(u)}
              />
            )}
            <button
              type="button"
              onClick={() => onOpen(u)}
              className="flex min-w-0 flex-1 items-center gap-2 text-start"
              title={t`View contact details`}
              data-testid={`${testId}-open-${u.id}`}
            >
              <span className="flex-1 truncate">{personName(u)}</span>
              {idOnly && (
                <IdCard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t`Known by user id only`} />
              )}
              {u.name && u.email && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
            </button>
          </div>
        );
      })}
    </ContactListBox>
  );
}
