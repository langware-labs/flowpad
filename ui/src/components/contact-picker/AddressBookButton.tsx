import { useMemo, useState } from 'react';
import { BookUser, IdCard, Loader2, RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ActionInfo, dataManager, type ConversationParticipant, type User } from '@sdk';
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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The contact whose detail dialog is open (null = closed).
  const [detailFor, setDetailFor] = useState<User | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { contacts, refetch } = useContacts(excludeUserId, enabled && open);

  const filtered = useMemo(() => filterContacts(contacts, query), [contacts, query]);

  // Rule 5: scan every local conversation and upsert its members into the
  // address book, then refetch the list. The scanned contacts also stream in
  // live via the entity-query watch, so this is belt-and-suspenders.
  const refresh = async () => {
    setRefreshing(true);
    try {
      const action = new ActionInfo('address-book-scan', null, null, 'POST');
      await dataManager.callAction<null, unknown>(action);
      refetch();
    } finally {
      setRefreshing(false);
    }
  };

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
        aria-label={t`Open address book`}
        title={t`Address book`}
        data-testid={testId}
      >
        <BookUser className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm" data-testid={`${testId}-modal`}>
          <DialogHeader>
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
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <Trans>Refresh</Trans>
              </Button>
            </DialogTitle>
          </DialogHeader>

          <Input
            placeholder={t`Search by name or email`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid={`${testId}-search`}
          />

          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                <Trans>No contacts found.</Trans>
              </p>
            ) : (
              filtered.map((u) => {
                const key = participantKey(participantFromContact(u));
                const checked = !!key && selectedKeys.has(key);
                // Rule 1: a contact known only by hub user_id (no email) still
                // belongs in the book — flag it so it reads as intentional.
                const idOnly = !u.email && !!u.user_id;
                return (
                  <div
                    key={u.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                    data-testid={`${testId}-row-${u.id}`}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggle(u)} />
                    <button
                      type="button"
                      onClick={() => setDetailFor(u)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={t`View contact details`}
                      data-testid={`${testId}-open-${u.id}`}
                    >
                      <span className="flex-1 truncate">{u.name || u.email || 'unknown'}</span>
                      {idOnly && (
                        <IdCard
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-label={t`Known by user id only`}
                        />
                      )}
                      {u.name && u.email && (
                        <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {detailFor && (
        <ContactPermissionsDialog
          open
          onClose={() => setDetailFor(null)}
          user={detailFor}
        />
      )}
    </>
  );
}
