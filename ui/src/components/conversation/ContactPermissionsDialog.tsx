import { useMemo, useState } from 'react';
import { MessagesSquare, ShieldCheck, Trash2, User as UserIcon } from 'lucide-react';
import { ActionInfo, PermissionAction, type User } from '@sdk';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { useAction } from '@src/hooks/use-action';
import {
  grantContactPermission,
  revokeContactPermission,
  useContactPermissions,
  type ContactKey,
} from '@src/hooks/use-contact-permissions';

interface ContactPermissionsDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Identity for the permissions panel. Member-roster callers (which have no
   * full ``User`` entity) pass this directly; the address-book caller passes
   * ``user`` instead and this is derived from it.
   */
  contact?: ContactKey & { name?: string | null };
  /**
   * The full contact entity. When provided (the address-book path) the dialog
   * renders the richer Details + Conversations tabs; when omitted (member-roster
   * callers) it stays a permissions-only dialog — backward compatible.
   */
  user?: User | null;
}

const ACTION_LABEL: Record<string, string> = {
  [PermissionAction.EXECUTE_PROMPT]: 'Auto-run prompts',
  [PermissionAction.AUTO_REPLY]: 'Auto-reply',
};

/** Details tab (rules 1 & 2): every stored field of the contact. */
function ContactDetails({ user }: { user: User }) {
  const rows: Array<[string, string | null | undefined]> = [
    ['Name', user.name],
    ['Email', user.email],
    ['Hub user id', user.user_id],
    ['Local id', user.id],
    ['Organization role', user.organization_role],
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
          <div className="truncate font-medium">{user.name || user.email || 'Unknown'}</div>
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
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (conversations.length === 0) {
    return <p className="text-xs text-muted-foreground">No conversations with this contact yet.</p>;
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

/** Permissions tab: the receiver's local prompt policy for this contact. */
function ContactPermissions({ contact }: { contact: ContactKey & { name?: string | null } }) {
  const { permissions, refetch } = useContactPermissions(contact);
  const [busy, setBusy] = useState(false);
  const who = contact.name?.trim() || contact.email?.trim() || 'this contact';

  const globalRow = permissions.find((p) => (p.project_id ?? null) === null);
  const projectRows = permissions.filter((p) => (p.project_id ?? null) !== null);
  const hasGlobal = (action: PermissionAction) => !!globalRow?.allowed_actions?.includes(action);

  const toggleGlobal = async (action: PermissionAction, on: boolean) => {
    setBusy(true);
    try {
      if (on) await grantContactPermission(contact, null, action);
      else await revokeContactPermission(contact, null, action);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const removeProjectRow = async (projectId: string, action: PermissionAction) => {
    setBusy(true);
    try {
      await revokeContactPermission(contact, projectId, action);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">All projects</legend>
        {([PermissionAction.EXECUTE_PROMPT, PermissionAction.AUTO_REPLY] as const).map((action) => (
          <label key={action} className="flex items-center gap-2">
            <Checkbox
              checked={hasGlobal(action)}
              onCheckedChange={(v) => void toggleGlobal(action, !!v)}
              disabled={busy}
              data-testid={`contact-perm-global-${action}`}
            />
            <span>
              {ACTION_LABEL[action]} from {who}
            </span>
          </label>
        ))}
      </fieldset>

      {projectRows.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[11px] uppercase tracking-widest text-muted-foreground">Per-project</legend>
          {projectRows.map((row) => (
            <div key={row.id} className="rounded-md border border-border px-2 py-1.5">
              <div className="truncate font-mono text-[10px] text-muted-foreground" title={row.project_id ?? ''}>
                {row.project_id}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {(row.allowed_actions ?? []).map((action) => (
                  <span
                    key={action}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                  >
                    {ACTION_LABEL[action] ?? action}
                    <button
                      type="button"
                      className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                      disabled={busy}
                      onClick={() => void removeProjectRow(row.project_id!, action as PermissionAction)}
                      aria-label={`Remove ${action}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      )}

      {permissions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No permissions yet. Grant them here, or from the Execute dialog when a prompt arrives.
        </p>
      )}
    </div>
  );
}

/**
 * Contact dialog. With a full ``user`` (address book): a tabbed Details /
 * Conversations / Permissions view. Without it (member-roster callers): the
 * permissions-only dialog, unchanged.
 */
export function ContactPermissionsDialog({ open, onClose, contact, user }: ContactPermissionsDialogProps) {
  const [tab, setTab] = useState<'details' | 'conversations' | 'permissions'>(user ? 'details' : 'permissions');
  // One identity source: derive the permissions key from ``user`` when the
  // caller passed the full entity, else use the ``contact`` key it supplied.
  const contactKey: ContactKey & { name?: string | null } = contact ?? {
    userId: user?.id,
    email: user?.email,
    name: user?.name,
  };
  const who = contactKey.name?.trim() || contactKey.email?.trim() || 'this contact';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="contact-permissions-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-primary" />
            {who}
          </DialogTitle>
        </DialogHeader>

        {user ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="details" data-testid="contact-tab-details">
                Details
              </TabsTrigger>
              <TabsTrigger value="conversations" data-testid="contact-tab-conversations">
                <MessagesSquare className="me-1 h-3.5 w-3.5" />
                Conversations
              </TabsTrigger>
              <TabsTrigger value="permissions" data-testid="contact-tab-permissions">
                <ShieldCheck className="me-1 h-3.5 w-3.5" />
                Permissions
              </TabsTrigger>
            </TabsList>
            <TabsContent value="details" className="mt-4">
              <ContactDetails user={user} />
            </TabsContent>
            <TabsContent value="conversations" className="mt-4">
              <ContactConversations user={user} active={tab === 'conversations'} />
            </TabsContent>
            <TabsContent value="permissions" className="mt-4">
              <ContactPermissions contact={contactKey} />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="mt-2">
            <ContactPermissions contact={contactKey} />
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
