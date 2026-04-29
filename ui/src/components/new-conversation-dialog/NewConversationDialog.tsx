import {
  Conversation,
  ConversationParticipant,
  createProjectConversation,
  QueryRequest,
  User,
} from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@src/components/ui/select';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { MessageSquarePlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewConversationDialog({ open, onClose }: NewConversationDialogProps) {
  const { navigation } = useDockNavigation();
  const ctx = useDataContext();
  const { projects = [] } = useProjects();

  const [projectId, setProjectId] = useState<string>('');
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [filterText, setFilterText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the project picker to the current project on open.
  useEffect(() => {
    if (!open) return;
    setParticipants([]);
    setFilterText('');
    setError(null);
    setProjectId(ctx.project?.id ?? projects[0]?.id ?? '');
  }, [open, ctx.project?.id, projects]);

  // Contacts: all Users except the local user.
  const usersRequest = useMemo(() => new QueryRequest({ type: User.type }), []);
  const { data: allUsers = [] } = useEntitiesQuery<User>(usersRequest, { enabled: open });
  const localUserId = ctx.user?.id;
  const contacts = useMemo(
    () => allUsers.filter((u) => u.id !== localUserId),
    [allUsers, localUserId],
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

  const alreadyAdded = (email: string) =>
    participants.some((p) => p.email.toLowerCase() === email.toLowerCase());

  const addContact = (u: User) => {
    if (!u.email || alreadyAdded(u.email)) return;
    setParticipants((prev) => [...prev, { user_id: u.id, email: u.email!, name: u.name ?? null }]);
    setFilterText('');
  };

  const addFreeFormEmail = () => {
    const value = filterText.trim();
    if (!value || !EMAIL_RE.test(value) || alreadyAdded(value)) return;
    setParticipants((prev) => [...prev, { email: value, name: null }]);
    setFilterText('');
  };

  const removeParticipant = (email: string) => {
    setParticipants((prev) => prev.filter((p) => p.email !== email));
  };

  // Slack-style placeholder: "<my name>, <participant1>, ..."
  const myLabel = ctx.user?.name || ctx.user?.email || 'You';
  const placeholderTitle = useMemo(() => {
    if (participants.length === 0) return 'New conversation';
    const others = participants.map((p) => p.name || p.email).join(', ');
    return `${myLabel}, ${others}`;
  }, [participants, myLabel]);

  const canCreate = !!projectId && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createProjectConversation({
        project_id: projectId,
        participants,
      });
      navigation.openDock(
        DockPointer.forProject(result.project_id, { conversationId: result.conversation_id }),
      );
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create conversation';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md" data-testid="new-conversation-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="h-5 w-5 text-primary" />
            {placeholderTitle}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm">
          {/* Project */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Project
            </label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id ?? ''}>
                    {p.name || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Participants */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Participants
            </label>

            {participants.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {participants.map((p) => (
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
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <Input
              placeholder="Search by name or email — Enter to add"
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
              data-testid="participant-input"
            />

            {filterText.trim() && filteredContacts.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                {filteredContacts.slice(0, 8).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => addContact(u)}
                    disabled={!u.email || alreadyAdded(u.email)}
                  >
                    <span className="truncate">{u.name || u.email}</span>
                    {u.name && u.email && (
                      <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {filterText.trim() &&
              filteredContacts.length === 0 &&
              EMAIL_RE.test(filterText.trim()) &&
              !alreadyAdded(filterText.trim()) && (
                <button
                  type="button"
                  className="rounded-md border border-dashed border-border px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                  onClick={addFreeFormEmail}
                >
                  Add <span className="font-medium text-foreground">{filterText.trim()}</span>
                </button>
              )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for type completeness
export type { Conversation };
