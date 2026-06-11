import { useMemo, useState } from 'react';
import { BookUser, ShieldCheck } from 'lucide-react';
import type { ConversationParticipant, User } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Input } from '@src/components/ui/input';
import { ContactPermissionsDialog } from '@src/components/conversation/ContactPermissionsDialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import {
  filterContacts,
  participantFromContact,
  participantKey,
  useContacts,
} from './use-contacts';

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The contact whose permissions dialog is open (null = closed).
  const [permsFor, setPermsFor] = useState<User | null>(null);
  const { contacts } = useContacts(excludeUserId, enabled && open);

  const filtered = useMemo(() => filterContacts(contacts, query), [contacts, query]);

  const selectedKeys = useMemo(
    () => new Set(value.map(participantKey).filter(Boolean)),
    [value],
  );

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
        aria-label="Open address book"
        title="Address book"
        data-testid={testId}
      >
        <BookUser className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" data-testid={`${testId}-modal`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookUser className="h-4 w-4 text-primary" />
              Contacts
            </DialogTitle>
          </DialogHeader>

          <Input
            placeholder="Search by name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid={`${testId}-search`}
          />

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                No contacts found.
              </p>
            ) : (
              filtered.map((u) => {
                const key = participantKey(participantFromContact(u));
                const checked = !!key && selectedKeys.has(key);
                return (
                  <div
                    key={u.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                    data-testid={`${testId}-row-${u.id}`}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <Checkbox checked={checked} onCheckedChange={() => toggle(u)} />
                      <span className="flex-1 truncate">{u.name || u.email || 'unknown'}</span>
                      {u.name && u.email && (
                        <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                      )}
                    </label>
                    <button
                      type="button"
                      onClick={() => setPermsFor(u)}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                      aria-label="Permissions"
                      title="Prompt permissions"
                      data-testid={`${testId}-perms-${u.id}`}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {permsFor && (
        <ContactPermissionsDialog
          open
          onClose={() => setPermsFor(null)}
          contact={{ userId: permsFor.id, email: permsFor.email, name: permsFor.name }}
        />
      )}
    </>
  );
}
