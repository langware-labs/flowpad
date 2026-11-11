import { useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { MessagesSquare, User as UserIcon } from 'lucide-react';
import { ActionInfo, type User } from '@sdk';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { Button } from '@src/components/ui/button';
import { useAction } from '@src/hooks/use-action';
import { personName } from '@src/components/conversation/participant-display';

/** Details tab (rules 1 & 2): every stored field of the contact. */
function ContactDetails({ user }: { user: User }) {
  const rows: Array<[string, string | null | undefined]> = [
    ['Name', user.name],
    ['Email', user.email],
    ['Hub user id', user.user_id],
    ['Local id', user.id],
    ['Organization role', user.organization_roles?.join(', ')],
    ['Onboarded', user.onboarded != null ? String(user.onboarded) : undefined],
  ];
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="contact-details-tab">
      <div className="flex items-center gap-3">
        {user.picture ? (
          <img src={user.picture} alt="" className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserIcon className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate font-medium">{personName(user)}</div>
          {user.email && <div className="truncate text-xs text-muted-foreground">{user.email}</div>}
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows
          .filter(([, v]) => v != null && String(v).trim() !== '')
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono text-xs" title={String(value)}>
                {String(value)}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

/** Conversations tab (rule 6): the contact's conversations; opening it runs the
 *  same address-book scan scoped to this contact. */
interface ScannedConversation {
  id: string;
  title?: string | null;
  updated_date?: string | null;
}

function ContactConversations({ user, active }: { user: User; active: boolean }) {
  // Rule 6: opening this tab runs the scoped scan — it BOTH upserts the contact
  // from every conversation it appears in AND returns those conversations. The
  // backend matches by email OR user_id OR local id (more robust than a purely
  // client-side participant-key match), so the returned list is authoritative.
  const scanInfo = useMemo(() => (user.id ? new ActionInfo('conversations', 'user', user.id, 'GET') : null), [user.id]);
  const { data, loading } = useAction<ScannedConversation[]>(scanInfo, { enabled: active });
  const conversations = data ?? [];

  if (loading && conversations.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  if (conversations.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>No conversations with this contact yet.</Trans>
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="contact-conversations-tab">
      {conversations.map((c) => (
        <li
          key={c.id}
          className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
          data-testid={`contact-conv-${c.id}`}
        >
          <span className="min-w-0 flex-1 truncate">{c.title || 'Untitled conversation'}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {c.updated_date ? new Date(c.updated_date).toLocaleDateString() : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Permissions tab: the host's standing grant for this contact's live sessions. */
/** Contact dialog (address book): the contact's Details and Conversations. */
export function ContactDialog({ open, onClose, user }: { open: boolean; onClose: () => void; user: User }) {
  const [tab, setTab] = useState<'details' | 'conversations'>('details');
  const who = user.name?.trim() || user.email?.trim() || 'this contact';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="contact-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-primary" />
            {who}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="details" data-testid="contact-tab-details">
              <Trans>Details</Trans>
            </TabsTrigger>
            <TabsTrigger value="conversations" data-testid="contact-tab-conversations">
              <MessagesSquare className="me-1 h-3.5 w-3.5" />
              <Trans>Conversations</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <ContactDetails user={user} />
          </TabsContent>
          <TabsContent value="conversations" className="mt-4">
            <ContactConversations user={user} active={tab === 'conversations'} />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button onClick={onClose}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
