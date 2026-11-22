import { useEffect, useMemo, useState } from 'react';
import { LifeBuoy, Plus } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Agent, myHelpDesks, staffedHelpDesks, type User } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { ContactDialog } from '@src/components/conversation/ContactDialog';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { SegmentedControl } from '@src/components/ui/segmented-control';
import { servedPage } from '@src/lib/hub-page-url';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateTo } from '@src/notifications';
import { ContactListBox, ContactRows, ContactsTitle } from './ContactRows';
import { CreateContactsGroupDialog } from './CreateContactsGroupDialog';
import { NewHelpDeskDialog } from './NewHelpDeskDialog';
import { filterAgents, useAgentSuggestions } from './use-agent-suggestions';
import { filterContacts, useContacts } from './use-contacts';
import { filterGroups, useContactsGroups } from './use-contacts-groups';

type Tab = 'people' | 'groups' | 'agents' | 'desks';

/** A help desk in the list: one this person answers on, or one they added to ask. */
interface DeskRow {
  id: string;
  name: string;
  mine: boolean;
  on: boolean;
}

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
  // The agents this person may add to a conversation: read only while their tab shows.
  const { agents } = useAgentSuggestions(open && tab === 'agents');
  const AgentIcon = iconForType(Agent.type);
  const { cloudUser } = useAuth();
  const [creatingDesk, setCreatingDesk] = useState(false);
  const [desks, setDesks] = useState<DeskRow[]>([]);
  const me = cloudUser?.id ?? null;
  useEffect(() => {
    if (!open || tab !== 'desks') return;
    let current = true;
    void Promise.all([staffedHelpDesks().catch(() => []), me ? myHelpDesks(me).catch(() => []) : []]).then(
      ([staffed, added]) => {
        if (!current) return;
        const held = new Set(staffed.map((d) => d.id));
        setDesks([
          ...staffed.map((d) => ({ id: d.id, name: d.helpdesk?.display_name || d.name || '', mine: true, on: !!d.helpdesk?.enabled })),
          ...added.filter((d) => !held.has(d.id)).map((d) => ({ id: d.id, name: d.display_name, mine: false, on: d.enabled })),
        ]);
      },
    );
    return () => {
      current = false;
    };
  }, [open, tab, me]);
  const openDesk = (deskId: string) => {
    onOpenChange(false);
    // On whichever page this app serves: the hub page, or the desktop.
    navigateTo(DockPointer.forDesk(deskId).withPage(servedPage()).toUrl());
  };

  const people = useMemo(() => filterContacts(contacts, query), [contacts, query]);
  const shownGroups = useMemo(() => filterGroups(groups, query), [groups, query]);
  const shownAgents = useMemo(() => filterAgents(agents, query), [agents, query]);

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
              ['agents', t`Agents`],
              ['desks', t`Help desks`],
            ]}
            value={tab}
            onChange={(next) => {
              setTab(next);
              setQuery('');
            }}
            testId="contacts-tab"
            className="justify-self-start"
          />

          {tab !== 'desks' && (
            <Input
              placeholder={
                tab === 'people' ? t`Search by name or email` : tab === 'agents' ? t`Search agents` : t`Search groups`
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="contacts-search"
            />
          )}

          {tab === 'desks' ? (
            <>
              <ContactListBox empty={<Trans>No help desks yet. Create your own support line, or open a desk's link to add it.</Trans>}>
                {desks.map((desk) => (
                  <button
                    key={desk.id}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted/40"
                    onClick={() => openDesk(desk.id)}
                    data-testid={`contacts-desk-row-${desk.id}`}
                  >
                    <LifeBuoy className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    <span className="flex-1 truncate">{desk.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {desk.mine ? desk.on ? <Trans>You answer · on</Trans> : <Trans>You answer · off</Trans> : <Trans>You can ask</Trans>}
                    </span>
                  </button>
                ))}
              </ContactListBox>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit justify-self-start"
                onClick={() => setCreatingDesk(true)}
                data-testid="contacts-new-desk"
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>New help desk</Trans>
              </Button>
            </>
          ) : tab === 'people' ? (
            <ContactRows contacts={people} testId="contacts" onOpen={setDetailFor} />
          ) : tab === 'agents' ? (
            <ContactListBox empty={<Trans>No agents you can add to a conversation yet.</Trans>}>
              {shownAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`contacts-agent-row-${agent.id}`}
                >
                  <AgentIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{agent.name}</span>
                </div>
              ))}
            </ContactListBox>
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
      <NewHelpDeskDialog open={creatingDesk} onOpenChange={setCreatingDesk} onCreated={openDesk} />
      {detailFor && <ContactDialog open onClose={() => setDetailFor(null)} user={detailFor} />}
    </>
  );
}
