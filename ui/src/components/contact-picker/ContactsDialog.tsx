import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { User } from '@sdk';
import { ContactPermissionsDialog } from '@src/components/conversation/ContactPermissionsDialog';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { SegmentedControl } from '@src/components/ui/segmented-control';
import { ContactListBox, ContactRows, ContactsTitle } from './ContactRows';
import { CreateContactsGroupDialog } from './CreateContactsGroupDialog';
import { filterContacts, useContacts } from './use-contacts';
import { filterGroups, useContactsGroups } from './use-contacts-groups';

type Tab = 'people' | 'groups';

interface ContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hide this user id (the local user) from People. */
  excludeUserId?: string | null;
}

/** Contacts — the one place to see and manage everyone: people and contacts groups. */
export function ContactsDialog({ open, onOpenChange, excludeUserId }: ContactsDialogProps) {
  const { t } = useLingui();
  const [tab, setTab] = useState<Tab>('people');
  const [query, setQuery] = useState('');
  const [detailFor, setDetailFor] = useState<User | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const { contacts, refetch } = useContacts(excludeUserId, open);
  const { groups } = useContactsGroups(open);

  const people = useMemo(() => filterContacts(contacts, query), [contacts, query]);
  const shownGroups = useMemo(() => filterGroups(groups, query), [groups, query]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" data-testid="contacts-dialog">
          <DialogHeader>
            <ContactsTitle refetch={refetch} testId="contacts" />
          </DialogHeader>

          <SegmentedControl
            options={[
              ['people', t`People`],
              ['groups', t`Groups`],
            ]}
            value={tab}
            onChange={(next) => {
              setTab(next);
              setQuery('');
            }}
            testId="contacts-tab"
            className="justify-self-start"
          />

          <Input
            placeholder={tab === 'people' ? t`Search by name or email` : t`Search groups`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="contacts-search"
          />

          {tab === 'people' ? (
            <ContactRows contacts={people} testId="contacts" onOpen={setDetailFor} />
          ) : (
            <>
              <ContactListBox empty={<Trans>No groups yet.</Trans>}>
                {shownGroups.map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm"
                    data-testid={`contacts-group-row-${g.id}`}
                  >
                    <span className="flex-1 truncate">{g.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      <Plural value={g.contacts.length} one="# member" other="# members" />
                    </span>
                  </div>
                ))}
              </ContactListBox>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit justify-self-start"
                onClick={() => setCreatingGroup(true)}
                data-testid="contacts-new-group"
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>New group</Trans>
              </Button>
            </>
          )}

          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateContactsGroupDialog open={creatingGroup} onOpenChange={setCreatingGroup} />
      {detailFor && <ContactPermissionsDialog open onClose={() => setDetailFor(null)} user={detailFor} />}
    </>
  );
}
